import '../env.js';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Set before any db-touching module is imported — db/client.ts opens
// DATABASE_PATH lazily on first query, but config.ts parses process.env at
// its own import time, so this has to land before that happens. A dynamic
// `await import(...)` below (not a static import) is what makes that
// ordering hold: static imports are hoisted above this assignment and would
// run too early. See model-config.test.ts for the same trick, same reason.
const RECORDING_DB = resolve(process.cwd(), 'data', 'eval-recording.db');

/**
 * Records one fixture's real orchestrator run into a cassette — the tool
 * trace a live Anthropic API call actually produced, frozen to JSON so
 * eval-*.test.ts can replay it deterministically in CI without spending
 * anything or depending on the model behaving identically twice.
 *
 * Never runs against the live data/rumble.db: it copies it first (or seeds
 * fresh if it doesn't exist) and points DATABASE_PATH at the copy. The
 * orchestrator can decide to write things (a coaching note, for instance) —
 * a recording run has no business mutating anyone's real coaching history to
 * produce a test fixture.
 *
 * Usage: tsx src/scripts/record-tape.ts src/eval/fixtures/<name>.json
 */
async function main(): Promise<void> {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.error('Usage: tsx src/scripts/record-tape.ts <fixture.json>');
    process.exit(1);
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as { name: string; prompt: string };

  const liveDb = resolve(process.cwd(), 'data', 'rumble.db');
  if (existsSync(liveDb)) {
    copyFileSync(liveDb, RECORDING_DB);
    console.log(`Copied ${liveDb} -> ${RECORDING_DB} (recording never touches the live file)`);
  }
  process.env.DATABASE_PATH = RECORDING_DB;

  const { getDefaultAthleteId } = await import('../db/athlete.js');
  const { chatStream } = await import('../modules/claude/claude.client.js');
  const { orchestratorSystemPrompt, ORCHESTRATOR_MODEL } = await import('../modules/claude/model-config.js');
  const { ORCHESTRATOR_TOOLS, executeToolCalls } = await import('../modules/tools/tool.executor.js');
  const { buildSlimPreamble } = await import('../modules/athlete/context-preamble.js');
  const { MAX_TOOL_ROUNDS } = await import('../modules/chat/chat.stream.js');
  type ChatMessage = import('../modules/claude/claude.client.js').ChatMessage;

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

    const assistantMsg: ChatMessage = { role: 'assistant', content: decision.content };
    const toolResultMsg: ChatMessage = {
      role: 'user',
      content: toolResults.map((tr) => ({
        type: 'tool_result' as const,
        tool_use_id: tr.tool_call_id,
        content: JSON.stringify(tr.error ? { error: tr.error } : tr.result),
        is_error: Boolean(tr.error),
      })),
    };
    messages = [...messages, assistantMsg, toolResultMsg];
  }

  const cassette = {
    fixture: fixture.name,
    recordedAt: new Date().toISOString(),
    athleteId,
    rounds,
  };

  const cassettePath = resolve(process.cwd(), 'src', 'eval', 'cassettes', `${fixture.name}.json`);
  writeFileSync(cassettePath, JSON.stringify(cassette, null, 2) + '\n');
  console.log(`Wrote ${cassettePath} (${rounds.length} round(s))`);
}

main().catch((err) => {
  console.error('Recording failed:', err);
  process.exit(1);
});
