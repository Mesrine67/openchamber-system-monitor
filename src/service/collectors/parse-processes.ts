import type { ProcessEntry } from '../../shared/stats.ts';

const safeNumber = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const safeName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.trim().split(/[\\/]/).at(-1)?.slice(0, 100);
  return name && name !== '.' ? name : null;
};

export const parseLinuxProcessStat = (text: string): { pid: number; name: string; cpuTicks: number; parentPid: number | null; threadCount: number | null; state: string | null } | null => {
  const match = /^(\d+) \((.*)\) ([^ ]+) (.*)$/.exec(text.trim());
  if (!match?.[1] || match[2] === undefined || !match[4]) return null;
  const pid = Number(match[1]);
  const fields = match[4].split(/\s+/);
  // The tail starts at field 4 (ppid); utime/stime are fields 14/15.
  const userTicks = safeNumber(fields[10]);
  const systemTicks = safeNumber(fields[11]);
  const parentPid = safeNumber(fields[0]);
  const threadCount = safeNumber(fields[16]);
  const name = safeName(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !name || userTicks === null || systemTicks === null) return null;
  return { pid, name, cpuTicks: userTicks + systemTicks, parentPid, threadCount, state: match[3] ?? null };
};

export const parseLinuxProcessMemory = (text: string): number | null => {
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(text);
  const kib = match?.[1] ? Number(match[1]) : NaN;
  return Number.isSafeInteger(kib) && kib >= 0 ? kib * 1024 : null;
};

export const parseLinuxTotalCpuTicks = (text: string): number | null => {
  const match = /^cpu\s+(.+)$/m.exec(text);
  if (!match?.[1]) return null;
  const values = match[1].trim().split(/\s+/).map(Number);
  const total = values.reduce((sum, value) => sum + (Number.isFinite(value) && value >= 0 ? value : 0), 0);
  return values.length >= 4 && Number.isSafeInteger(total) && total > 0 ? total : null;
};

const jsonRows = (text: string): unknown[] | null => {
  try {
    const value: unknown = JSON.parse(text.trim() || 'null');
    return Array.isArray(value) ? value : value === null ? [] : [value];
  } catch { return null; }
};

export const parseWindowsProcesses = (text: string, limit = 20): ProcessEntry[] | null => {
  const rows = jsonRows(text);
  if (rows === null) return null;
  const result: ProcessEntry[] = [];
  for (const value of rows) {
    if (typeof value !== 'object' || value === null) continue;
    const pid = safeNumber(Reflect.get(value, 'IDProcess') ?? Reflect.get(value, 'IdProcess'));
    const name = safeName(Reflect.get(value, 'Name'));
    const cpuPercent = safeNumber(Reflect.get(value, 'PercentProcessorTime'));
    const memoryBytes = safeNumber(Reflect.get(value, 'WorkingSetPrivate'));
    const parentPid = safeNumber(Reflect.get(value, 'CreatingProcessID'));
    const threadCount = safeNumber(Reflect.get(value, 'ThreadCount'));
    if (pid === null || pid <= 0 || !name) continue;
    result.push({ pid, name, cpuPercent, memoryBytes, ...(parentPid !== null ? { parentPid } : {}), ...(threadCount !== null ? { threadCount } : {}) });
  }
  return result.slice(0, limit);
};

export const parsePsProcesses = (text: string, limit = 20): ProcessEntry[] | null => {
  const result: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const extended = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    const legacy = extended ? null : /^\s*(\d+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s*$/.exec(line);
    const pidText = extended?.[1] ?? legacy?.[1];
    const rawName = extended?.[6] ?? legacy?.[2];
    const cpuText = extended?.[4] ?? legacy?.[3];
    const rssText = extended?.[5] ?? legacy?.[4];
    if (!pidText || !rawName || !cpuText || !rssText) continue;
    const pid = Number(pidText);
    const name = safeName(rawName);
    const cpuPercent = Number(cpuText);
    const rssKib = Number(rssText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name || !Number.isFinite(cpuPercent) || !Number.isSafeInteger(rssKib)) continue;
    result.push({
      pid, name, cpuPercent: Math.max(0, cpuPercent), memoryBytes: Math.max(0, rssKib) * 1024,
      ...(extended ? { parentPid: Number(extended[2]), state: extended[3] } : {}),
    });
  }
  return result.slice(0, limit);
};

export const rankProcesses = (entries: ProcessEntry[], limit: number): { topCpu: ProcessEntry[]; topMemory: ProcessEntry[] } => ({
  topCpu: [...entries].filter((item) => item.cpuPercent !== null).sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)).slice(0, limit),
  topMemory: [...entries].filter((item) => item.memoryBytes !== null).sort((a, b) => (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1)).slice(0, limit),
});

/** Keep the table payload bounded and stable while preserving the observed total. */
export const processInventory = (entries: ProcessEntry[], total: number, limit = 500) => {
  const ordered = [...entries].sort((a, b) => a.pid - b.pid);
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const totalProcesses = Math.max(ordered.length, Math.floor(total));
  return { items: ordered.slice(0, safeLimit), totalProcesses, inventoryTruncated: totalProcesses > safeLimit };
};
