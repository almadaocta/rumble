import '../env.js';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Records one fixture's real orchestrator run into a cassette — the tool
 * trace a live Anthropic API call actually produced, frozen to JSON so
 * eval-*.test.ts can replay it deterministically in CI without spending
 * anything or depending on the model behaving identically twice.
 *
 * Never runs against the live data/rumble.db by default: it copies it first
 * and points DATABASE_PATH at the copy. The orchestrator can decide to write
 * things (a coaching note, for instance) — a recording run has no business
 * mutating anyone's real coaching history to produce a test fixture.
 * `--db <path>` overrides this with an already-prepared DB (e.g. a copy with
 * a field deliberately nulled out to exercise a specific missing-data path)
 * instead of copying the live one.
 *
 * Usage:
 *   tsx src/scripts/record-tape.ts src/eval/fixtures/<name>.json
 *   tsx src/scripts/record-tape.ts src/eval/fixtures/<name>.json --db data/some-prepared.db
 */
async function main(): Promise<void> {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('Usage: tsx src/scripts/record-tape.ts <fixture.json> [--db <path>]');
    process.exit(1);
  }

  const dbFlagIdx = process.argv.indexOf('--db');
  const dbOverride = dbFlagIdx !== -1 ? process.argv[dbFlagIdx + 1] : undefined;

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as { name: string; prompt: string };

  if (dbOverride) {
    process.env.DATABASE_PATH = resolve(process.cwd(), dbOverride);
    console.log(`Using prepared DB at ${process.env.DATABASE_PATH} (not copying data/rumble.db)`);
  } else {
    const liveDb = resolve(process.cwd(), 'data', 'rumble.db');
    const recordingDb = resolve(process.cwd(), 'data', 'eval-recording.db');
    if (existsSync(liveDb)) {
      copyFileSync(liveDb, recordingDb);
      console.log(`Copied ${liveDb} -> ${recordingDb} (recording never touches the live file)`);
    }
    process.env.DATABASE_PATH = recordingDb;
  }

  const { getDefaultAthleteId } = await import('../db/athlete.js');
  const { chatStream } = await import('../modules/claude/claude.client.js');
  const { orchestratorSystemPrompt, ORCHESTRATOR_MODEL } = await import('../modules/claude/model-config.js');
  const { ORCHESTRATOR_TOOLS, executeToolCalls } = await import('../modules/tools/tool.executor.js');
  const { buildSlimPreamble } = await import('../modules/athlete/context-preamble.js');
  const { MAX_TOOL_ROUNDS } = await import('../modules/chat/chat.stream.js');
  const { arbitrateSpecialists } = await import('../modules/tools/arbitrate-specialists.js');
  const { isSpecialist } = await import('../modules/claude/model-config.js');
  type ChatMessage = import('../modules/claude/claude.client.js').ChatMessage;
  type Specialist = import('../modules/claude/model-config.js').Specialist;
  type ResolvedContradiction = import('../modules/tools/arbitrate-specialists.js').ResolvedContradiction;

  const athleteId = await getDefaultAthleteId();
  console.log(`Recording "${fixture.name}" against athlete ${athleteId}...`);

  const preamble = await buildSlimPreamble(athleteId);
  // Mirrors buildOrchestratorSystem in chat.stream.ts — kept separate rather
  // than imported because that function isn't exported (it's private to a
  // module built around streaming an Express response, which this recorder
  // has no use for). If the real system-prompt assembly ever changes shape,
  // this needs to change with it or a taped run stops reflecting production
  // behavior — a known, accepted seam, not a hidden one.
  const system = [
    { type: 'text' as const, text: orchestratorSystemPrompt(), cache_control: { type: 'ephemeral' as const } },
    { type: 'text' as const, text: preamble },
  ];

  let messages: ChatMessage[] = [{ role: 'user', content: fixture.prompt }];
  const rounds: Array<{ content: unknown[]; stop_reason: string | null; textDeltas: string[] }> = [];
  // Recorded only if a round actually consults >1 specialist — mirrors
  // chat.stream.ts's round-scoped trigger exactly, using the real Haiku
  // arbitration call (not a stub), so the replay test can exercise the full
  // pipeline — including a real SSE contradiction-notice frame — from a
  // recorded resolution instead of a mocked-to-empty default.
  let arbitration: ResolvedContradiction[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const toolsAllowed = round < MAX_TOOL_ROUNDS - 1;
    console.log(`  round ${round + 1}/${MAX_TOOL_ROUNDS}...`);

    const stream = chatStream({
      model: ORCHESTRATOR_MODEL,
      system,
      messages,
      tools: ORCHESTRATOR_TOOLS,
      toolChoice: toolsAllowed ? undefined : { type: 'none' },
      maxTokens: 8192,
    });

    let text = '';
    stream.on('text', (delta: string) => {
      text += delta;
    });
    const decision = await stream.finalMessage();

    rounds.push({
      content: decision.content,
      stop_reason: decision.stop_reason,
      textDeltas: text ? [text] : [],
    });

    const toolUseBlocks = decision.content.filter(
      (b): b is Extract<typeof decision.content[number], { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (toolUseBlocks.length === 0) {
      console.log(`  done — final answer: ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`);
      break;
    }

    console.log(`  tools: ${toolUseBlocks.map((b) => b.name).join(', ')}`);

    const toolResults = await executeToolCalls(
      toolUseBlocks.map((b) => ({ id: b.id, name: b.name, arguments: b.input as Record<string, unknown> })),
      athleteId,
    );

    // Same detection chat.stream.ts uses: >1 consult_specialist succeeding
    // in this same round is "couldn't decide which was authoritative", not
    // two independent reads.
    const specialistConsults: Array<{ specialist: Specialist; response: string }> = [];
    for (const tr of toolResults) {
      if (tr.name !== 'consult_specialist' || tr.error) continue;
      const result = tr.result as { specialist?: unknown; response?: unknown } | null;
      const specialist = typeof result?.specialist === 'string' ? result.specialist : null;
      const text = typeof result?.response === 'string' ? result.response : null;
      if (specialist && isSpecialist(specialist) && text) specialistConsults.push({ specialist, response: text });
    }

    let arbitrationNote = '';
    if (specialistConsults.length > 1) {
      console.log(`  arbitrating ${specialistConsults.length} specialist consults...`);
      const resolved = await arbitrateSpecialists(specialistConsults);
      arbitration = [...arbitration, ...resolved];
      if (resolved.length > 0) {
        console.log(`  arbitration found ${resolved.length} contradiction(s): ${resolved.map((c) => `${c.domainA} vs ${c.domainB} -> ${c.chosenDomain}`).join('; ')}`);
        arbitrationNote = [
          `Arbitration note — ${resolved.length} contradiction(s) found between this round's specialists:`,
          ...resolved.map(
            (c) => `- ${c.domainA} vs ${c.domainB}: ${c.issue} — defer to ${c.chosenDomain} per Rumble's fixed priority (${c.reason})`,
          ),
        ].join('\n');
      } else {
        console.log('  arbitration found no contradiction');
      }
    }

    const assistantMsg: ChatMessage = { role: 'assistant', content: decision.content };
    const toolResultBlocks = toolResults.map((tr) => ({
      type: 'tool_result' as const,
      tool_use_id: tr.tool_call_id,
      content: JSON.stringify(tr.error ? { error: tr.error } : tr.result),
      is_error: Boolean(tr.error),
    }));
    const toolResultContent = arbitrationNote
      ? [...toolResultBlocks, { type: 'text' as const, text: arbitrationNote }]
      : toolResultBlocks;
    const toolResultMsg: ChatMessage = { role: 'user', content: toolResultContent };
    messages = [...messages, assistantMsg, toolResultMsg];
  }

  const cassette = {
    fixture: fixture.name,
    recordedAt: new Date().toISOString(),
    athleteId,
    rounds,
    ...(arbitration.length > 0 ? { arbitration } : {}),
  };

  const cassettePath = resolve(process.cwd(), 'src', 'eval', 'cassettes', `${fixture.name}.json`);
  writeFileSync(cassettePath, JSON.stringify(cassette, null, 2) + '\n');
  console.log(`Wrote ${cassettePath} (${rounds.length} round(s))`);
}

main().catch((err) => {
  console.error('Recording failed:', err);
  process.exit(1);
});
