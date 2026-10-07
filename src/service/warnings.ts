import {
  diskPercent,
  DEFAULT_MONITOR_SETTINGS,
  SAMPLE_INTERVAL_MS,
  WARN_PERCENT,
  type MonitorSettings,
  type CpuStats,
  type DiskStats,
  type MemoryStats,
  type Unavailable,
  type Warning,
} from '../shared/stats.ts';

/** Baseline warning window at default settings (60 s at 2 s). */
export const SUSTAINED_SAMPLES = 30;

/** True when the last `SUSTAINED_SAMPLES` points all exist and sit at or above the threshold. */
export const sustainedHigh = (history: (number | null)[], threshold = WARN_PERCENT, seconds = 60): boolean => {
  const required = Math.max(1, Math.ceil(seconds * 1000 / SAMPLE_INTERVAL_MS));
  if (history.length < required) return false;
  return history.slice(-required).every((value) => value !== null && value >= threshold);
};

const levelAt = (percent: number, warning: number, critical: number): 'warn' | 'critical' | null =>
  percent >= critical ? 'critical' : percent >= warning ? 'warn' : null;

export const evaluateWarnings = (input: {
  cpu: CpuStats | Unavailable;
  memory: MemoryStats | Unavailable;
  disks: DiskStats | Unavailable;
  cpuHistory: (number | null)[];
  gpuHistory: (number | null)[];
}, settings: MonitorSettings = DEFAULT_MONITOR_SETTINGS): Warning[] => {
  const warnings: Warning[] = [];
  const thresholds = settings.thresholds;
  if (input.cpu.status === 'ok' && input.cpuHistory.length > 0) {
    const critical = sustainedHigh(input.cpuHistory, thresholds.cpuCritical, thresholds.sustainedSeconds);
    const elevated = critical || sustainedHigh(input.cpuHistory, thresholds.cpuWarning, thresholds.sustainedSeconds);
    if (elevated) warnings.push({ kind: 'cpu', target: null, level: critical ? 'critical' : 'warn' });
  }
  if (input.memory.status === 'ok' && input.memory.total > 0) {
    const level = levelAt((input.memory.used / input.memory.total) * 100, thresholds.memoryWarning, thresholds.memoryCritical);
    if (level) warnings.push({ kind: 'memory', target: null, level });
    if (input.memory.swapTotal && input.memory.swapUsed !== null) {
      const swapPercent = (input.memory.swapUsed / input.memory.swapTotal) * 100;
      if (swapPercent >= thresholds.swapWarning) warnings.push({ kind: 'swap', target: null, level: 'warn' });
    }
  }
  if (input.gpuHistory.length > 0) {
    const critical = sustainedHigh(input.gpuHistory, thresholds.gpuCritical, thresholds.sustainedSeconds);
    const elevated = critical || sustainedHigh(input.gpuHistory, thresholds.gpuWarning, thresholds.sustainedSeconds);
    if (elevated) warnings.push({ kind: 'gpu', target: null, level: critical ? 'critical' : 'warn' });
  }
  if (input.disks.status === 'ok') {
    for (const disk of input.disks.items) {
      const percent = diskPercent(disk);
      if (percent === null) continue;
      const level = levelAt(percent, thresholds.diskWarning, thresholds.diskCritical);
      if (level) warnings.push({ kind: 'disk', target: disk.mount, level });
    }
  }
  return warnings;
};
