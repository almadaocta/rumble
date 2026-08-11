// Hits the real Anthropic API twice against each cache-eligible prefix in the
// app (a specialist's persona+knowledge-base, and the orchestrator's
// persona+tool schemas) and checks `usage.cache_read_input_tokens` on the
// second call. Unit tests can only assert that the right `cache_control`
// markers are sent — this is the only way to confirm Anthropic is actually
// honoring them. Not run in CI: it costs a handful of real API calls and
// depends on network access.
import '../env.js';
import type { Usage } from '@anthropic-ai/sdk/resources/messages';
import { chat, systemBlock, type ChatMessage } from '../modules/claude/claude.client.js';
import { getSpecialist, orchestratorSystemPrompt, ORCHESTRATOR_MODEL } from '../modules/claude/model-config.js';
import { ORCHESTRATOR_TOOLS } from '../modules/tools/tool.executor.js';

function report(label: string, usage: Usage): void {
  console.log(
    `  ${label}: input=${usage.input_tokens} cache_write=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0}`,
  );
}

async function checkPrefix(
  label: string,
  request: (ping: string) => Parameters<typeof chat>[0],
): Promise<void> {
  console.log(`\n--- ${label} ---`);

  const first = await chat(request('Reply with only the word "ack".'));
  report('Call 1 (expect cache_write > 0, cache_read = 0)', first.usage);

  const second = await chat(request('Reply with only the word "ack" again.'));
  report('Call 2 (expect cache_read > 0)', second.usage);

  if ((second.usage.cache_read_input_tokens ?? 0) === 0) {
    throw new Error(`${label}: no cache hit on the second call — caching is not working for this prefix.`);
  }
}

async function main(): Promise<void> {
  const specialistConfig = getSpecialist('cycling_coach');
  await checkPrefix('Specialist consult (cycling_coach persona + knowledge base)', (ping) => ({
    model: specialistConfig.model,
    system: systemBlock(`${specialistConfig.systemPrompt}\n\n${specialistConfig.knowledgeBase}`, true),
    messages: [{ role: 'user', content: ping }] as ChatMessage[],
    maxTokens: 16,
  }));

  await checkPrefix('Orchestrator (persona + tool schemas)', (ping) => ({
    model: ORCHESTRATOR_MODEL,
    system: [
      { type: 'text', text: orchestratorSystemPrompt(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'live preamble, intentionally left out of the cached prefix' },
    ],
    messages: [{ role: 'user', content: ping }] as ChatMessage[],
    tools: ORCHESTRATOR_TOOLS,
    toolChoice: { type: 'none' },
    maxTokens: 16,
  }));

  console.log('\nAll caching checks passed — both prefixes cache-hit on the second call.');
}

main().catch((err) => {
  console.error('\nCache verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
