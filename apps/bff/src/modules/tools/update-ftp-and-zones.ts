import { z } from 'zod';
import { FTP_SOURCES } from './vocabularies.js';
import { db } from '../../db/client.js';
import { athletes, powerZones } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { wahooClient } from '../wahoo/wahoo.client.js';
import { wahooTokenManager } from '../wahoo/wahoo.token-manager.js';
import { wahooEnabled } from '../../config.js';
import type { ToolOutcome } from './tool-result.js';

const UpdateFtpArgs = z.object({
  ftp: z.number().optional(),
  ftp_source: z.enum(FTP_SOURCES).optional(),
  push_to_device: z.boolean().optional(),
  reason: z.string(),
});

interface PowerZone {
  zone: number;
  name: string;
  minWatts: number;
  maxWatts: number;
}

function computePowerZones(ftp: number): PowerZone[] {
  return [
    { zone: 1, name: 'Active Recovery', minWatts: 0, maxWatts: Math.round(ftp * 0.55) },
    { zone: 2, name: 'Endurance', minWatts: Math.round(ftp * 0.56), maxWatts: Math.round(ftp * 0.75) },
    { zone: 3, name: 'Tempo', minWatts: Math.round(ftp * 0.76), maxWatts: Math.round(ftp * 0.9) },
    { zone: 4, name: 'Threshold', minWatts: Math.round(ftp * 0.91), maxWatts: Math.round(ftp * 1.05) },
    { zone: 5, name: 'VO2max', minWatts: Math.round(ftp * 1.06), maxWatts: Math.round(ftp * 1.2) },
    { zone: 6, name: 'Anaerobic', minWatts: Math.round(ftp * 1.21), maxWatts: Math.round(ftp * 1.5) },
    { zone: 7, name: 'Neuromuscular', minWatts: Math.round(ftp * 1.51), maxWatts: 2500 },
  ];
}

export async function updateFtpZones(
  args: Record<string, unknown>,
  athleteId: string,
): Promise<ToolOutcome> {
  const { ftp, ftp_source, reason, push_to_device } = UpdateFtpArgs.parse(args);

  const [athlete] = await db.select().from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  if (!athlete) return { ok: false, error: 'Athlete not found' };

  const previousFtp = athlete.ftp;
  const newFtp = ftp ?? athlete.ftp;

  if (!newFtp) return { ok: false, error: 'No FTP value provided and no existing FTP' };

  const zones = computePowerZones(newFtp);

  if (ftp) {
    await db
      .update(athletes)
      .set({ ftp, ftpUpdatedAt: new Date() })
      .where(eq(athletes.id, athleteId));
  }

  await db.insert(powerZones).values({
    athleteId,
    ftp: newFtp,
    zones,
    source: ftp_source ?? 'manual',
    reason,
  });


  const change =
    previousFtp && ftp
      ? `${ftp > previousFtp ? '+' : ''}${(((ftp - previousFtp) / previousFtp) * 100).toFixed(1)}%`
      : null;

  let pushedToWahoo = false;
  let wahooNote: string | undefined;
  if (push_to_device && !wahooEnabled) {
    // The tool schema hides this option in chat-only mode, but an older
    // conversation replayed from history can still carry it. Say so plainly
    // rather than failing several layers down at the token lookup.
    wahooNote = 'Wahoo is not configured, so the zones were saved locally but not pushed to a device.';
  } else if (push_to_device) {
    try {
      const token = await wahooTokenManager.ensureValidToken(athleteId);
      await wahooClient.putPowerZones(token, {
        zones: zones.map((z) => ({ zone: z.zone, min: z.minWatts, max: z.maxWatts })),
      });
      pushedToWahoo = true;
    } catch (err) {
      wahooNote = err instanceof Error ? err.message : 'Failed to push zones to Wahoo';
    }
  }

  return {
    ok: true,
    previous_ftp: previousFtp,
    new_ftp: newFtp,
    change,
    power_zones: zones,
    pushed_to_wahoo: pushedToWahoo,
    ...(wahooNote ? { wahoo_note: wahooNote } : {}),
  };
}
