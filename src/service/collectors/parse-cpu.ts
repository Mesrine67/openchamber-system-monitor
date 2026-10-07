// Pure CPU math and cgroup parsers.

export type CoreTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** Linux sysfs scaling_cur_freq readings are kHz; average only positive finite cores. */
export const parseCpuFrequencyMHz = (readings: string[]): number | null => {
  const values = readings.map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length / 1000;
};

/** Busy share per core and overall between two `os.cpus()` readings. */
export const cpuUsage = (previous: CoreTimes[], next: CoreTimes[]): { total: number; perCore: number[] } | null => {
  if (previous.length === 0 || previous.length !== next.length) return null;
  let busyAll = 0;
  let totalAll = 0;
  const perCore: number[] = [];
  for (let index = 0; index < next.length; index++) {
    const before = previous[index];
    const after = next[index];
    if (!before || !after) return null;
    const busy = (after.user - before.user) + (after.nice - before.nice) + (after.sys - before.sys) + (after.irq - before.irq);
    const total = busy + (after.idle - before.idle);
    busyAll += busy;
    totalAll += total;
    perCore.push(total > 0 ? clampPercent((busy / total) * 100) : 0);
  }
  if (totalAll <= 0) return null;
  return { total: clampPercent((busyAll / totalAll) * 100), perCore };
};

/** cgroup v2 `cpu.max` (`200000 100000` → 2 cores, `max 100000` → no limit). */
export const parseCpuMax = (text: string | null): number | null => {
  const [quota, period] = (text ?? '').trim().split(/\s+/);
  if (!quota || !period || quota === 'max') return null;
  const cores = Number(quota) / Number(period);
  return Number.isFinite(cores) && cores > 0 ? cores : null;
};

/** cgroup v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us` (`-1` → no limit). */
export const parseCfsQuota = (quota: string | null, period: string | null): number | null => {
  const quotaValue = Number((quota ?? '').trim());
  const periodValue = Number((period ?? '').trim());
  if (!Number.isFinite(quotaValue) || !Number.isFinite(periodValue) || quotaValue <= 0 || periodValue <= 0) return null;
  return quotaValue / periodValue;
};

/** cgroup v2 `cpu.stat` `usage_usec`, in microseconds. */
export const parseCpuStatUsage = (text: string | null): number | null => {
  const match = /^usage_usec (\d+)$/m.exec(text ?? '');
  return match?.[1] ? Number(match[1]) : null;
};

/** Share of a CPU limit used between two cgroup usage readings (microseconds). */
export const limitedCpuUsage = (
  previousUsec: number,
  nextUsec: number,
  elapsedMs: number,
  limitCores: number,
): number | null => {
  if (elapsedMs <= 0 || limitCores <= 0 || nextUsec < previousUsec) return null;
  const usedMs = (nextUsec - previousUsec) / 1000;
  return clampPercent((usedMs / (elapsedMs * limitCores)) * 100);
};
