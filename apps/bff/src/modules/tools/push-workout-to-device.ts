import { z } from 'zod';
import { pushWorkoutToElemnt } from '../wahoo/wahoo.plan-pusher.js';
import type { ToolOutcome } from './tool-result.js';

const PushArgs = z.object({
  session_id: z.string().min(1),
});

export async function pushWorkoutToDevice(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  // .parse, not safeParse: a bad argument shape is a thrown ZodError that
  // executeToolCall catches, logs, and reports — the same channel the other 13
  // handlers use. Handling it here instead meant validation failures reached
  // Claude two different ways depending on which tool it called, and skipped
  // the executor's logging.
  const { session_id } = PushArgs.parse(args);

  try {
    const result = await pushWorkoutToElemnt(athleteId, session_id);
    return {
      ok: true,
      wahoo_plan_id: result.wahooPlanId,
      message: 'Workout sent to your Wahoo ELEMNT. It will appear on your device for the scheduled ride.',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Push failed';
    return { ok: false, error: message };
  }
}
