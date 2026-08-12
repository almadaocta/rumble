import { describe, it, expect } from 'vitest';
import { scoreTrace, callsFromCassette, type Fixture, type Cassette } from './score-trace.js';

const FIXTURE: Fixture = {
  name: 'race-readiness',
  prompt: 'Am I ready to race next month?',
  expected_trace: [
    { tool: 'get_training_data' },
    { tool: 'get_athlete_context' },
    { tool: 'consult_specialist', args_match: { specialist: 'recovery' } },
  ],
  must_not_call: ['update_training_plan'],
};

function cassetteWithCalls(
  calls: Array<{ name: string; input?: Record<string, unknown> }>,
): Cassette {
  return {
    fixture: 'race-readiness',
    recordedAt: '2026-08-11T00:00:00.000Z',
    athleteId: 'athlete-1',
    rounds: [
      {
        content: calls.map((c, i) => ({ type: 'tool_use', id: `t${i}`, name: c.name, input: c.input ?? {} })),
        stop_reason: 'tool_use',
      },
    ],
  };
}

describe('callsFromCassette', () => {
  it('flattens tool_use blocks across rounds, ignoring text blocks', () => {
    const cassette: Cassette = {
      fixture: 'x',
      recordedAt: 'now',
      athleteId: 'a1',
      rounds: [
        { content: [{ type: 'tool_use', name: 'get_training_data', input: {} }], stop_reason: 'tool_use' },
        {
          content: [
            { type: 'text', text: 'here you go' },
            { type: 'tool_use', name: 'consult_specialist', input: { specialist: 'recovery' } },
          ],
          stop_reason: 'tool_use',
        },
      ],
    };

    expect(callsFromCassette(cassette)).toEqual([
      { tool: 'get_training_data', args: {} },
      { tool: 'consult_specialist', args: { specialist: 'recovery' } },
    ]);
  });
});

describe('scoreTrace', () => {
  it('passes when every expected call happened in order, with matching args', () => {
    const cassette = cassetteWithCalls([
      { name: 'get_training_data' },
      { name: 'get_athlete_context' },
      { name: 'consult_specialist', input: { specialist: 'recovery' } },
    ]);

    const result = scoreTrace(FIXTURE, cassette);

    expect(result.pass).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.forbiddenCalled).toEqual([]);
  });

  it('tolerates an extra unlisted call interspersed between expected ones', () => {
    // get_body_metrics is not in expected_trace at all — its presence
    // between two expected calls shouldn't fail anything.
    const cassette = cassetteWithCalls([
      { name: 'get_training_data' },
      { name: 'get_body_metrics' },
      { name: 'get_athlete_context' },
      { name: 'consult_specialist', input: { specialist: 'recovery' } },
    ]);

    expect(scoreTrace(FIXTURE, cassette).pass).toBe(true);
  });

  it('fails when two expected calls happen out of the order the fixture lists them in', () => {
    // The fixture lists get_training_data before get_athlete_context — a
    // fixture author who doesn't care about relative order between two
    // entries shouldn't encode an order for them. This pins that the
    // scorer takes the listed order at face value rather than silently
    // treating expected_trace as an unordered set.
    const cassette = cassetteWithCalls([
      { name: 'get_athlete_context' },
      { name: 'get_training_data' },
      { name: 'consult_specialist', input: { specialist: 'recovery' } },
    ]);

    const result = scoreTrace(FIXTURE, cassette);
    expect(result.pass).toBe(false);
    expect(result.missing).toEqual([{ tool: 'get_athlete_context' }]);
  });

  it('fails when the specialist consulted does not match args_match', () => {
    const cassette = cassetteWithCalls([
      { name: 'get_training_data' },
      { name: 'get_athlete_context' },
      { name: 'consult_specialist', input: { specialist: 'nutritionist' } },
    ]);

    const result = scoreTrace(FIXTURE, cassette);

    expect(result.pass).toBe(false);
    expect(result.missing).toEqual([{ tool: 'consult_specialist', args_match: { specialist: 'recovery' } }]);
  });

  it('fails when an expected tool never gets called', () => {
    const cassette = cassetteWithCalls([{ name: 'get_training_data' }]);

    const result = scoreTrace(FIXTURE, cassette);

    expect(result.pass).toBe(false);
    expect(result.missing).toHaveLength(2);
  });

  it('fails when a forbidden tool was called, even if everything expected also happened', () => {
    const cassette = cassetteWithCalls([
      { name: 'get_training_data' },
      { name: 'get_athlete_context' },
      { name: 'consult_specialist', input: { specialist: 'recovery' } },
      { name: 'update_training_plan', input: { action: 'create' } },
    ]);

    const result = scoreTrace(FIXTURE, cassette);

    expect(result.pass).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.forbiddenCalled).toEqual(['update_training_plan']);
  });

  it('does not let a wrong-args match satisfy a later exact-args expectation out of turn', () => {
    // Two consult_specialist calls: nutritionist first, recovery second.
    // The fixture only asks for recovery — it must find the second one, not
    // silently accept the first as a partial match.
    const cassette = cassetteWithCalls([
      { name: 'get_training_data' },
      { name: 'get_athlete_context' },
      { name: 'consult_specialist', input: { specialist: 'nutritionist' } },
      { name: 'consult_specialist', input: { specialist: 'recovery' } },
    ]);

    expect(scoreTrace(FIXTURE, cassette).pass).toBe(true);
  });
});
