/**
 * Scores a recorded orchestrator run against a golden trace fixture.
 *
 * Deliberately not the response text: two runs of the same prompt can phrase
 * an answer differently and both be right, but "did it look up training data
 * before answering a readiness question" is a real, checkable claim about
 * behavior. The response text is noise for this kind of eval; the tool trace
 * is the signal.
 */

export interface ExpectedTraceEntry {
  tool: string;
  /** Exact-match on these input fields only — an entry with no args_match matches on tool name alone. */
  args_match?: Record<string, unknown>;
}

export interface Fixture {
  name: string;
  prompt: string;
  expected_trace: ExpectedTraceEntry[];
  must_not_call?: string[];
}

/** One recorded round of the real orchestrator loop — a cassette is an array of these. See record-tape.ts. */
export interface CassetteRound {
  content: Array<Record<string, unknown> & { type: string }>;
  stop_reason: string;
  textDeltas?: string[];
}

export interface Cassette {
  fixture: string;
  recordedAt: string;
  athleteId: string;
  rounds: CassetteRound[];
}

export interface ActualCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Flattens a cassette's rounds into the ordered sequence of tool calls the model actually made. */
export function callsFromCassette(cassette: Cassette): ActualCall[] {
  const calls: ActualCall[] = [];
  for (const round of cassette.rounds) {
    for (const block of round.content) {
      if (block.type === 'tool_use') {
        calls.push({
          tool: block.name as string,
          args: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
  }
  return calls;
}

export interface ScoreResult {
  pass: boolean;
  missing: ExpectedTraceEntry[];
  forbiddenCalled: string[];
  actualTrace: string[];
}

function argsMatch(actual: Record<string, unknown>, expected: Record<string, unknown> | undefined): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/**
 * Scores a cassette's actual tool trace against a fixture's expectations.
 *
 * expected_trace is checked as an ORDERED SUBSEQUENCE, not positional
 * equality: an extra, unlisted tool call between two expected ones doesn't
 * fail the fixture — a real orchestrator run calling get_body_metrics along
 * the way isn't a bug. What the fixture author's listed order *does* still
 * assert is real: if the fixture lists get_training_data before
 * consult_specialist, that relative order must hold in the actual trace too
 * (a fixture that doesn't care about relative order between two entries
 * shouldn't encode an order for them). must_not_call is checked against the
 * whole trace regardless of position — nothing legitimizes a forbidden call.
 */
export function scoreTrace(fixture: Fixture, cassette: Cassette): ScoreResult {
  const calls = callsFromCassette(cassette);

  const missing: ExpectedTraceEntry[] = [];
  let searchFrom = 0;
  for (const expected of fixture.expected_trace) {
    const idx = calls.findIndex(
      (c, i) => i >= searchFrom && c.tool === expected.tool && argsMatch(c.args, expected.args_match),
    );
    if (idx === -1) {
      missing.push(expected);
    } else {
      searchFrom = idx + 1;
    }
  }

  const calledTools = new Set(calls.map((c) => c.tool));
  const forbiddenCalled = (fixture.must_not_call ?? []).filter((tool) => calledTools.has(tool));

  return {
    pass: missing.length === 0 && forbiddenCalled.length === 0,
    missing,
    forbiddenCalled,
    actualTrace: calls.map((c) => c.tool),
  };
}
