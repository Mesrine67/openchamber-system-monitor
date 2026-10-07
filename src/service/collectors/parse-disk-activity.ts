import type { DiskActivityEntry } from '../../shared/stats.ts';

type RawDiskCounters = { device: string; readSectors: number; writeSectors: number; reads: number; writes: number; readMs: number; writeMs: number; busyMs: number };

const nonNegative = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
};

export const parseProcDiskStats = (text: string): RawDiskCounters[] => text.split(/\r?\n/).flatMap((line) => {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 14 || !fields[2]) return [];
  const values = [3, 5, 6, 7, 9, 10, 12].map((index) => nonNegative(fields[index]));
  if (values.some((value) => value === null)) return [];
  if (values.some((value) => value === null)) return [];
  return [{
    device: fields[2]!, reads: values[0]!, readSectors: values[1]!, readMs: values[2]!,
    writes: values[3]!, writeSectors: values[4]!, writeMs: values[5]!, busyMs: values[6]!,
  }];
});

export const diskActivityFromDelta = (current: RawDiskCounters[], previous: RawDiskCounters[] | null, elapsedMs: number): DiskActivityEntry[] =>
  current.map((entry) => {
    const before = previous?.find((item) => item.device === entry.device);
    const deltas = before ? {
      readSectors: entry.readSectors - before.readSectors,
      writeSectors: entry.writeSectors - before.writeSectors,
      reads: entry.reads - before.reads,
      writes: entry.writes - before.writes,
      readMs: entry.readMs - before.readMs,
      writeMs: entry.writeMs - before.writeMs,
      busyMs: entry.busyMs - before.busyMs,
    } : null;
    const valid = deltas !== null && elapsedMs > 0 && Object.values(deltas).every((value) => value >= 0);
    const readOps = valid ? deltas.reads : null;
    const writeOps = valid ? deltas.writes : null;
    const totalOps = readOps !== null && writeOps !== null ? readOps + writeOps : 0;
    return {
      device: entry.device,
      readBytesPerSecond: valid ? deltas.readSectors * 512 * 1000 / elapsedMs : null,
      writeBytesPerSecond: valid ? deltas.writeSectors * 512 * 1000 / elapsedMs : null,
      readIops: valid ? readOps! * 1000 / elapsedMs : null,
      writeIops: valid ? writeOps! * 1000 / elapsedMs : null,
      activePercent: valid ? Math.min(100, deltas.busyMs * 100 / elapsedMs) : null,
      responseMs: valid && totalOps > 0 ? (deltas.readMs + deltas.writeMs) / totalOps : null,
    };
  });

export const parseWindowsDiskActivity = (text: string): DiskActivityEntry[] | null => {
  let parsed: unknown;
  try { parsed = JSON.parse(text.trim() || 'null'); } catch { return null; }
  const rows = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
  const output: DiskActivityEntry[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const device = Reflect.get(row, 'Name');
    if (typeof device !== 'string' || !/^[A-Z]:$/i.test(device)) continue;
    const read = nonNegative(Reflect.get(row, 'DiskReadBytesPersec'));
    const write = nonNegative(Reflect.get(row, 'DiskWriteBytesPersec'));
    const readIops = nonNegative(Reflect.get(row, 'DiskReadsPersec'));
    const writeIops = nonNegative(Reflect.get(row, 'DiskWritesPersec'));
    const active = nonNegative(Reflect.get(row, 'PercentDiskTime'));
    const readLatency = nonNegative(Reflect.get(row, 'AvgDisksecPerRead'));
    const writeLatency = nonNegative(Reflect.get(row, 'AvgDisksecPerWrite'));
    const latencies = [readLatency, writeLatency].filter((value): value is number => value !== null);
    output.push({
      device, readBytesPerSecond: read, writeBytesPerSecond: write,
      readIops, writeIops,
      activePercent: active === null ? null : Math.min(100, active),
      responseMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length * 1000 : null,
    });
  }
  return output;
};
