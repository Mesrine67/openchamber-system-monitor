// The `/stats` contract between the service and both frames.
// A missing value is `null`, never 0: 0 % is a measurement, `null` is "unknown".

export type UnavailableReason =
  /** A required tool is not on PATH (`tool` names it). */
  | 'tool-missing'
  /** The source answered, but no device of this kind exists. */
  | 'no-device'
  /** This platform has no source for the value. */
  | 'unsupported'
  /** The user turned this optional collector off. */
  | 'disabled'
  /** This source has not had its first sample yet. */
  | 'pending'
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
  /** Current average frequency when exposed by the operating system. */
  frequencyMHz?: number | null;
  /** Cores granted by the container's CPU limit, `null` without one. */
  limitCores: number | null;
  model: string | null;
};

export type MemoryStats = {
  status: 'ok';
  used: number;
  total: number;
  available?: number;
  /** OS-reported cache and commit figures; omitted when not exposed. */
  cached?: number | null;
  committed?: number | null;
  commitLimit?: number | null;
  pressure?: 'low' | 'medium' | 'high' | null;
  swapUsed: number | null;
  swapTotal: number | null;
};

export type GpuDevice = {
  name: string;
  utilization: number | null;
  memUsed: number | null;
  memTotal: number | null;
  /** Windows WDDM allocation budget; it is not necessarily physical VRAM capacity. */
  memBudget?: number | null;
  sharedMemUsed?: number | null;
  sharedMemTotal?: number | null;
  temperatureC?: number | null;
  frequencyMHz?: number | null;
  powerW?: number | null;
  fanPercent?: number | null;
  driverVersion?: string | null;
};

export type GpuStats = { status: 'ok'; devices: GpuDevice[] };

export type Disk = {
  /** Mount point (`/`, `/Volumes/USB`) or drive (`C:`). */
  mount: string;
  /** Volume name when the system knows one. */
  label: string | null;
  used: number;
  total: number;
  fileSystem?: string | null;
  driveType?: 'fixed' | 'removable' | 'network' | null;
  /** Source device identifier, kept local and never included in diagnostic exports. */
  device?: string | null;
  deviceType?: 'ssd' | 'hdd' | 'nvme' | null;
};

export type ComputerInfo = {
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  osName: string | null;
  osVersion: string | null;
  osDisplayVersion: string | null;
  osBuild: string | null;
  displayAdapters: string[];
  physicalCores: number | null;
  logicalProcessors: number | null;
  cpuMaxMHz: number | null;
  memoryModules: number | null;
  memorySpeedMHz: number | null;
  motherboard?: string | null;
};

export type DiskStats = { status: 'ok'; items: Disk[]; sampledAt: number };
export type DiskActivityEntry = {
  device: string;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  readIops: number | null;
  writeIops: number | null;
  activePercent: number | null;
  responseMs: number | null;
};
export type DiskActivityStats = { status: 'ok'; items: DiskActivityEntry[]; sampledAt: number };

export type NetworkInterface = {
  name: string;
  receivedBytes: number;
  sentBytes: number;
  downloadBytesPerSecond: number | null;
  uploadBytesPerSecond: number | null;
  isDefault: boolean | null;
  linkSpeedBps: number | null;
};
export type NetworkStats = { status: 'ok'; interfaces: NetworkInterface[]; sampledAt: number };

export type ProcessEntry = { pid: number; name: string; cpuPercent: number | null; memoryBytes: number | null };
export type ProcessStats = { status: 'ok'; topCpu: ProcessEntry[]; topMemory: ProcessEntry[]; sampledAt: number };

export type BatteryStats = {
  status: 'ok';
  percent: number;
  state: 'charging' | 'discharging' | 'full' | 'unknown';
  acConnected: boolean | null;
  remainingSeconds: number | null;
  healthPercent: number | null;
};

export type SensorReading = { name: string; kind: 'cpu' | 'gpu' | 'disk' | 'other'; temperatureC: number };
export type SensorStats = { status: 'ok'; readings: SensorReading[]; sampledAt: number };

export type WarningKind = 'disk' | 'memory' | 'cpu' | 'gpu' | 'swap';
export type WarningLevel = 'warn' | 'critical';
export type Warning = { kind: WarningKind; target: string | null; level: WarningLevel };
export type HealthState = 'healthy' | 'attention' | 'critical' | 'unavailable';
export type HealthSummary = { state: HealthState; warningCount: number; criticalCount: number; unavailableCount: number };

export type MonitorSettings = {
  paused: boolean;
  refreshSeconds: 2 | 5 | 10;
  historyMinutes: 2 | 5 | 15 | 30;
  processLimit: 5 | 10 | 20;
  modules: { network: boolean; processes: boolean; battery: boolean; sensors: boolean };
  thresholds: {
    memoryWarning: number; memoryCritical: number;
    diskWarning: number; diskCritical: number;
    cpuWarning: number; cpuCritical: number;
    gpuWarning: number; gpuCritical: number;
    swapWarning: number; sustainedSeconds: 30 | 60 | 120;
  };
};

export const DEFAULT_MONITOR_SETTINGS: MonitorSettings = {
  paused: false,
  refreshSeconds: 2,
  historyMinutes: 2,
  processLimit: 10,
  modules: { network: true, processes: true, battery: true, sensors: true },
  thresholds: {
    memoryWarning: 85, memoryCritical: 95,
    diskWarning: 85, diskCritical: 95,
    cpuWarning: 85, cpuCritical: 95,
    gpuWarning: 85, gpuCritical: 95,
    swapWarning: 50, sustainedSeconds: 60,
  },
};

const allowed = <T extends number>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === 'number' && values.includes(value as T) ? value as T : fallback;
const threshold = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(99, Math.max(50, Math.round(value))) : fallback;

/** Validate the host-stored value again at the service boundary. */
export const normalizeMonitorSettings = (value: unknown): MonitorSettings => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return structuredClone(DEFAULT_MONITOR_SETTINGS);
  const modules = Reflect.get(value, 'modules');
  const thresholds = Reflect.get(value, 'thresholds');
  const read = (source: unknown, key: string): unknown =>
    typeof source === 'object' && source !== null ? Reflect.get(source, key) : undefined;
  const normalizedThresholds = {
    memoryWarning: threshold(read(thresholds, 'memoryWarning'), 85),
    memoryCritical: threshold(read(thresholds, 'memoryCritical'), 95),
    diskWarning: threshold(read(thresholds, 'diskWarning'), 85),
    diskCritical: threshold(read(thresholds, 'diskCritical'), 95),
    cpuWarning: threshold(read(thresholds, 'cpuWarning'), 85),
    cpuCritical: threshold(read(thresholds, 'cpuCritical'), 95),
    gpuWarning: threshold(read(thresholds, 'gpuWarning'), 85),
    gpuCritical: threshold(read(thresholds, 'gpuCritical'), 95),
    swapWarning: threshold(read(thresholds, 'swapWarning'), 50),
    sustainedSeconds: allowed(read(thresholds, 'sustainedSeconds'), [30, 60, 120] as const, 60),
  };
  for (const [warning, critical] of [
    ['memoryWarning', 'memoryCritical'], ['diskWarning', 'diskCritical'],
    ['cpuWarning', 'cpuCritical'], ['gpuWarning', 'gpuCritical'],
  ] as const) {
    if (normalizedThresholds[warning] >= normalizedThresholds[critical]) {
      normalizedThresholds[warning] = Math.max(50, normalizedThresholds[critical] - 5);
    }
  }
  return {
    paused: read(value, 'paused') === true,
    refreshSeconds: allowed(read(value, 'refreshSeconds'), [2, 5, 10] as const, 2),
    historyMinutes: allowed(read(value, 'historyMinutes'), [2, 5, 15, 30] as const, 2),
    processLimit: allowed(read(value, 'processLimit'), [5, 10, 20] as const, 10),
    modules: {
      network: read(modules, 'network') !== false,
      processes: read(modules, 'processes') !== false,
      battery: read(modules, 'battery') !== false,
      sensors: read(modules, 'sensors') !== false,
    },
    thresholds: normalizedThresholds,
  };
};

export type Platform = 'darwin' | 'linux' | 'win32' | 'other';

export type Stats = {
  sampledAt: number;
  environment: {
    platform: Platform;
    container: boolean;
    computer?: {
      hostName: string | null;
      operatingSystem: string | null;
      architecture: string | null;
      uptimeSeconds?: number | null;
      details?: ComputerInfo | null;
    };
  };
  cpu: CpuStats | Unavailable;
  memory: MemoryStats | Unavailable;
  gpus: GpuStats | Unavailable;
  disks: DiskStats | Unavailable;
  diskActivity: DiskActivityStats | Unavailable;
  network: NetworkStats | Unavailable;
  processes: ProcessStats | Unavailable;
  battery: BatteryStats | Unavailable;
  sensors: SensorStats | Unavailable;
/** Oldest first; display history is downsampled to at most `HISTORY_LENGTH` points. */
  history: {
    cpu: (number | null)[];
    gpu: (number | null)[];
    memory: (number | null)[];
    networkDown: (number | null)[];
    networkUp: (number | null)[];
    sampleIntervalMs: number;
  };
  warnings: Warning[];
  health: HealthSummary;
};

export const SAMPLE_INTERVAL_MS = 2_000;
/** Display history uses 60 points at a window-dependent 2/5/15/30 s interval. */
export const HISTORY_LENGTH = 60;
/** Keep up to two minutes of fast samples separately for sustained warning evaluation. */
export const WARNING_HISTORY_LENGTH = 60;
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

export const diskPercent = (disk: Disk): number | null => disk.total > 0 ? (disk.used / disk.total) * 100 : null;

/** The fullest disk, which the compact status section shows. */
export const fullestDisk = (disks: DiskStats | Unavailable): Disk | null => {
  if (disks.status !== 'ok') return null;
  let fullest: Disk | null = null;
  for (const disk of disks.items) {
    const percent = diskPercent(disk);
    if (percent !== null && (!fullest || percent > (diskPercent(fullest) ?? -1))) fullest = disk;
  }
  return fullest;
};
