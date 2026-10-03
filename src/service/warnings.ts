import {
  diskPercent,
  levelForPercent,
  WARN_PERCENT,
  type CpuStats,
  type DiskStats,
  type MemoryStats,
  type Unavailable,
  type Warning,
} from '../shared/stats.ts';

/** CPU or GPU must stay at or above `WARN_PERCENT` for this many samples (60 s at 2 s). */
export const SUSTAINED_SAMPLES = 30;

/** True when the last `SUSTAINED_SAMPLES` points all exist and sit at or above the threshold. */
export const sustainedHigh = (history: (number | null)[]): boolean => {
  if (history.length < SUSTAINED_SAMPLES) return false;
  return history.slice(-SUSTAINED_SAMPLES).every((value) => value !== null && value >= WARN_PERCENT);
};

export const evaluateWarnings = (input: {
  cpu: CpuStats | Unavailable;
  memory: MemoryStats | Unavailable;
  disks: DiskStats | Unavailable;
  cpuHistory: (number | null)[];
  gpuHistory: (number | null)[];
}): Warning[] => {
  const warnings: Warning[] = [];
  if (input.cpu.status === 'ok' && sustainedHigh(input.cpuHistory)) {
    warnings.push({ kind: 'cpu', target: null, level: 'warn' });
  }
  if (input.memory.status === 'ok' && input.memory.total > 0) {
    const level = levelForPercent((input.memory.used / input.memory.total) * 100);
    if (level) warnings.push({ kind: 'memory', target: null, level });
  }
  if (sustainedHigh(input.gpuHistory)) {
    warnings.push({ kind: 'gpu', target: null, level: 'warn' });
  }
  if (input.disks.status === 'ok') {
    for (const disk of input.disks.items) {
      const level = levelForPercent(diskPercent(disk));
      if (level) warnings.push({ kind: 'disk', target: disk.mount, level });
    }
  }
  return warnings;
};
