// The `/stats` contract between the service and both frames.
// A missing value is `null`, never 0: 0 % is a measurement, `null` is "unknown".

export type UnavailableReason =
  /** A required tool is not on PATH (`tool` names it). */
  | 'tool-missing'
  /** The source answered, but no device of this kind exists. */
  | 'no-device'
  /** This platform has no source for the value. */
  | 'unsupported'
  /** The source failed repeatedly. */
  | 'failed';

export type Unavailable = { status: 'unavailable'; reason: UnavailableReason; tool: string | null };

export type CpuStats = {
  status: 'ok';
  /** 0..100 across all cores, or of the container's CPU limit. */
  total: number;
  /** 0..100 per core. Empty inside a CPU-limited container, where host cores would mislead. */
  perCore: number[];
  /** 1, 5 and 15 minute load average. `null` on Windows, which has none. */
  load: [number, number, number] | null;
  cores: number;
  /** Cores granted by the container's CPU limit, `null` without one. */
  limitCores: number | null;
  model: string | null;
};

export type MemoryStats = {
  status: 'ok';
  used: number;
  total: number;
  swapUsed: number | null;
  swapTotal: number | null;
};

export type GpuDevice = {
  name: string;
  utilization: number | null;
  memUsed: number | null;
  memTotal: number | null;
};

export type GpuStats = { status: 'ok'; devices: GpuDevice[] };

export type Disk = {
  /** Mount point (`/`, `/Volumes/USB`) or drive (`C:`). */
  mount: string;
  /** Volume name when the system knows one. */
  label: string | null;
  used: number;
  total: number;
};

export type DiskStats = { status: 'ok'; items: Disk[]; sampledAt: number };

export type WarningKind = 'disk' | 'memory' | 'cpu' | 'gpu';
export type WarningLevel = 'warn' | 'critical';
export type Warning = { kind: WarningKind; target: string | null; level: WarningLevel };

export type Platform = 'darwin' | 'linux' | 'win32' | 'other';

export type Stats = {
  sampledAt: number;
  environment: { platform: Platform; container: boolean };
  cpu: CpuStats | Unavailable;
  memory: MemoryStats | Unavailable;
  gpus: GpuStats | Unavailable;
  disks: DiskStats | Unavailable;
  /** Oldest first, one point per sample, at most `HISTORY_LENGTH`. */
  history: { cpu: (number | null)[]; gpu: (number | null)[] };
  warnings: Warning[];
};

export const SAMPLE_INTERVAL_MS = 2_000;
export const HISTORY_LENGTH = 60;
export const IDLE_STOP_MS = 30_000;
export const DISK_INTERVAL_MS = 30_000;
export const RETRY_UNAVAILABLE_MS = 60_000;
export const FAILURES_BEFORE_UNAVAILABLE = 3;

export const WARN_PERCENT = 90;
export const CRITICAL_PERCENT = 95;

/** Fill level of memory or a disk as a warning level. */
export const levelForPercent = (percent: number): WarningLevel | null => {
  if (percent >= CRITICAL_PERCENT) return 'critical';
  if (percent >= WARN_PERCENT) return 'warn';
  return null;
};

export const unavailable = (reason: UnavailableReason, tool: string | null = null): Unavailable => ({
  status: 'unavailable',
  reason,
  tool,
});

/** Busiest GPU of a sample, or `null` when no device reports utilization. */
export const busiestGpu = (gpus: GpuStats | Unavailable): number | null => {
  if (gpus.status !== 'ok') return null;
  let busiest: number | null = null;
  for (const device of gpus.devices) {
    if (device.utilization !== null && (busiest === null || device.utilization > busiest)) busiest = device.utilization;
  }
  return busiest;
};

/** Stable identity of a warning set; the badge only changes when this does. */
export const warningKey = (warnings: Warning[]): string =>
  warnings.map((warning) => `${warning.kind}:${warning.target ?? ''}:${warning.level}`).sort().join('|');

export const diskPercent = (disk: Disk): number => (disk.total > 0 ? (disk.used / disk.total) * 100 : 0);

/** The fullest disk, which the compact status section shows. */
export const fullestDisk = (disks: DiskStats | Unavailable): Disk | null => {
  if (disks.status !== 'ok') return null;
  let fullest: Disk | null = null;
  for (const disk of disks.items) {
    if (!fullest || diskPercent(disk) > diskPercent(fullest)) fullest = disk;
  }
  return fullest;
};
