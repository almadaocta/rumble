import { Decoder, Stream } from '@garmin-fit/sdk';
import { createLogger, describeError } from '../../logger.js';

const log = createLogger('fit-parser');

export interface ParsedLap {
  lapIndex: number;
  startedAt: Date;
  durationS: number;
  distanceM: number | null;
  avgPower: number | null;
  maxPower: number | null;
  normPower: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  avgSpeed: number | null;
  elevationGain: number | null;
  calories: number | null;
}

export interface ParsedStreams {
  timestamps: number[];
  power: (number | null)[];
  heartRate: (number | null)[];
  cadence: (number | null)[];
  speed: (number | null)[];
  altitude: (number | null)[];
  distance: (number | null)[];
  temperature: (number | null)[];
  lat: (number | null)[];
  lng: (number | null)[];
  sampleCount: number;
}

export interface ParsedSession {
  sport: string | null;
  subSport: string | null;
  startedAt: Date;
  durationS: number;
  distanceM: number | null;
  avgPower: number | null;
  maxPower: number | null;
  normPower: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  elevationGain: number | null;
  calories: number | null;
}

export interface ParsedFitFile {
  session: ParsedSession | null;
  laps: ParsedLap[];
  streams: ParsedStreams;
}

export async function downloadAndParseFit(url: string): Promise<ParsedFitFile | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      log.warn('Failed to download FIT file', { status: response.status });
      return null;
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    return parseFitBuffer(bytes);
  } catch (err) {
    log.warn('Error downloading/parsing FIT', describeError(err));
    return null;
  }
}

export function parseFitBuffer(bytes: Uint8Array): ParsedFitFile | null {
  try {
    const stream = Stream.fromByteArray(Array.from(bytes));

    if (!Decoder.isFIT(stream)) {
      log.warn('Not a valid FIT file');
      return null;
    }

    const decoder = new Decoder(stream);
    const { messages, errors } = decoder.read({
      applyScaleAndOffset: true,
      expandSubFields: true,
      expandComponents: true,
      convertTypesToStrings: true,
      convertDateTimesToDates: true,
      includeUnknownData: false,
      mergeHeartRates: true,
    });

    if (errors.length > 0) {
      log.warn('Decode errors', { count: errors.length });
    }

    const session = extractSession(messages.sessionMesgs ?? []);
    const laps = extractLaps(messages.lapMesgs ?? []);
    const streams = extractStreams(messages.recordMesgs ?? []);

    return { session, laps, streams };
  } catch (err) {
    log.warn('Parse error', describeError(err));
    return null;
  }
}

function extractSession(sessionMesgs: any[]): ParsedSession | null {
  const session = sessionMesgs[0];
  if (!session) return null;

  return {
    sport: typeof session.sport === 'string' ? session.sport : null,
    subSport: typeof session.subSport === 'string' ? session.subSport : null,
    startedAt: session.startTime instanceof Date ? session.startTime : new Date(session.startTime ?? 0),
    durationS: Math.round(session.totalTimerTime ?? session.totalElapsedTime ?? 0),
    distanceM: numOrNull(session.totalDistance),
    avgPower: intOrNull(session.avgPower),
    maxPower: intOrNull(session.maxPower),
    normPower: intOrNull(session.normalizedPower),
    avgHr: intOrNull(session.avgHeartRate),
    maxHr: intOrNull(session.maxHeartRate),
    avgCadence: intOrNull(session.avgCadence),
    elevationGain: numOrNull(session.totalAscent),
    calories: intOrNull(session.totalCalories),
  };
}

function extractLaps(lapMesgs: any[]): ParsedLap[] {
  return lapMesgs.map((lap, i) => ({
    lapIndex: i,
    startedAt: lap.startTime instanceof Date ? lap.startTime : new Date(lap.startTime ?? 0),
    durationS: Math.round(lap.totalTimerTime ?? lap.totalElapsedTime ?? 0),
    distanceM: numOrNull(lap.totalDistance),
    avgPower: intOrNull(lap.avgPower),
    maxPower: intOrNull(lap.maxPower),
    normPower: intOrNull(lap.normalizedPower),
    avgHr: intOrNull(lap.avgHeartRate),
    maxHr: intOrNull(lap.maxHeartRate),
    avgCadence: intOrNull(lap.avgCadence),
    avgSpeed: numOrNull(lap.avgSpeed),
    elevationGain: numOrNull(lap.totalAscent),
    calories: intOrNull(lap.totalCalories),
  }));
}

function extractStreams(recordMesgs: any[]): ParsedStreams {
  const timestamps: number[] = [];
  const power: (number | null)[] = [];
  const heartRate: (number | null)[] = [];
  const cadence: (number | null)[] = [];
  const speed: (number | null)[] = [];
  const altitude: (number | null)[] = [];
  const distance: (number | null)[] = [];
  const temperature: (number | null)[] = [];
  const lat: (number | null)[] = [];
  const lng: (number | null)[] = [];

  for (const rec of recordMesgs) {
    const ts = rec.timestamp instanceof Date
      ? Math.floor(rec.timestamp.getTime() / 1000)
      : (typeof rec.timestamp === 'number' ? rec.timestamp : 0);

    timestamps.push(ts);
    power.push(numOrNull(rec.power));
    heartRate.push(intOrNull(rec.heartRate));
    cadence.push(intOrNull(rec.cadence));
    speed.push(numOrNull(rec.speed));
    altitude.push(numOrNull(rec.altitude ?? rec.enhancedAltitude));
    distance.push(numOrNull(rec.distance));
    temperature.push(numOrNull(rec.temperature));
    lat.push(numOrNull(rec.positionLat));
    lng.push(numOrNull(rec.positionLong));
  }

  return {
    timestamps, power, heartRate, cadence, speed,
    altitude, distance, temperature, lat, lng,
    sampleCount: timestamps.length,
  };
}

function numOrNull(v: unknown): number | null {
  if (v == null || typeof v !== 'number' || !isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

function intOrNull(v: unknown): number | null {
  if (v == null || typeof v !== 'number' || !isFinite(v)) return null;
  return Math.round(v);
}
