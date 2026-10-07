// Pure parsers for memory sources. Each returns `null` when the text does not
// carry the values, so a broken source never turns into 0.

const KIB = 1024;
const MIB = 1024 * 1024;

const field = (text: string, pattern: RegExp): number | null => {
  const match = pattern.exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

/**
 * macOS `vm_stat`. Used memory follows Activity Monitor: app memory
 * (anonymous minus purgeable) + wired + compressed. `os.freemem()` counts only
 * completely free pages, which would show a Mac as nearly full all the time.
 */
export const parseVmStat = (text: string): number | null => {
  const pageSize = field(text, /page size of (\d+) bytes/);
  const anonymous = field(text, /^Anonymous pages:\s+(\d+)\./m);
  const purgeable = field(text, /^Pages purgeable:\s+(\d+)\./m);
  const wired = field(text, /^Pages wired down:\s+(\d+)\./m);
  const compressed = field(text, /^Pages occupied by compressor:\s+(\d+)\./m);
  if (pageSize === null || anonymous === null || wired === null || compressed === null) return null;
  const app = Math.max(0, anonymous - (purgeable ?? 0));
  return (app + wired + compressed) * pageSize;
};

const SWAP_UNITS: Record<string, number> = { K: KIB, M: MIB, G: MIB * 1024 };

/** macOS `sysctl vm.swapusage`: `total = 1024.00M  used = 0.75M  free = …`. */
export const parseSwapUsage = (text: string): { used: number; total: number } | null => {
  const read = (name: string): number | null => {
    const match = new RegExp(`${name} = ([\\d.]+)([KMG])`).exec(text);
    if (!match?.[1] || !match[2]) return null;
    const unit = SWAP_UNITS[match[2]];
    const value = Number(match[1]);
    return unit && Number.isFinite(value) ? Math.round(value * unit) : null;
  };
  const total = read('total');
  const used = read('used');
  return total === null || used === null ? null : { used, total };
};

/** Aggregate Windows Win32_PageFileUsage values (MiB) into byte totals. */
export const parseWindowsPageFile = (text: string): { total: number; used: number } | null => {
  let value: unknown;
  try {
    value = JSON.parse(text.trim() || 'null');
  } catch {
    return null;
  }
  const rows = Array.isArray(value) ? value : value === null ? [] : [value];
  let total = 0;
  let used = 0;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const allocated = Number(Reflect.get(row, 'AllocatedBaseSize'));
    const current = Number(Reflect.get(row, 'CurrentUsage'));
    if (!Number.isFinite(allocated) || !Number.isFinite(current) || allocated < 0 || current < 0) continue;
    total += allocated * MIB;
    used += current * MIB;
  }
  return total > 0 ? { total, used: Math.min(used, total) } : null;
};

export type Meminfo = { total: number; available: number; swapTotal: number; swapFree: number };

/** Linux `/proc/meminfo`, values in kB. */
export const parseMeminfo = (text: string): Meminfo | null => {
  const read = (name: string): number | null => field(text, new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'));
  const total = read('MemTotal');
  const available = read('MemAvailable');
  if (total === null || available === null) return null;
  return {
    total: total * KIB,
    available: available * KIB,
    swapTotal: (read('SwapTotal') ?? 0) * KIB,
    swapFree: (read('SwapFree') ?? 0) * KIB,
  };
};

/**
 * Container memory from cgroup files, the way `docker stats` counts it:
 * usage minus inactive page cache. `null` without a limit, so the caller falls
 * back to the machine's own values.
 */
export const parseCgroupMemory = (input: {
  limit: string | null;
  usage: string | null;
  stat: string | null;
}): { used: number; total: number } | null => {
  const limitText = input.limit?.trim();
  const usageText = input.usage?.trim();
  if (!limitText || !usageText || limitText === 'max') return null;
  const limit = Number(limitText);
  const usage = Number(usageText);
  // cgroup v1 reports "no limit" as a huge page-aligned number.
  if (!Number.isFinite(limit) || !Number.isFinite(usage) || limit <= 0 || limit >= 2 ** 60) return null;
  const inactive = input.stat
    ? field(input.stat, /^(?:total_)?inactive_file (\d+)$/m) ?? 0
    : 0;
  return { used: Math.max(0, usage - inactive), total: limit };
};
