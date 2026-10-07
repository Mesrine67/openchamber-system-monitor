import os from 'node:os';
import { readdir } from 'node:fs/promises';

import { unavailable, type Platform, type ProcessEntry, type ProcessStats, type Unavailable } from '../../shared/stats.ts';
import { readText, run } from './exec.ts';
import { parseLinuxProcessMemory, parseLinuxProcessStat, parseLinuxTotalCpuTicks, parsePsProcesses, parseWindowsProcesses, rankProcesses } from './parse-processes.ts';
import { runPowerShell } from './windows.ts';

const WINDOWS_PROCESSES = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -gt 0 -and $_.Name -ne '_Total' } | Select-Object Name, IDProcess, PercentProcessorTime, WorkingSetPrivate)
$cpu = @($rows | Sort-Object { [double]$_.PercentProcessorTime } -Descending | Select-Object -First 20)
$mem = @($rows | Sort-Object { [double]$_.WorkingSetPrivate } -Descending | Select-Object -First 20)
@{ topCpu = $cpu; topMemory = $mem } | ConvertTo-Json -Compress -Depth 3
`;

type ProcRecord = { pid: number; name: string; cpuTicks: number; memoryBytes: number | null };

export type ProcessCollector = { read: (limit: number) => Promise<ProcessStats | Unavailable> };

export const createProcessCollector = (platform: Platform, now: () => number): ProcessCollector => {
  let previousCpuTicks: Map<number, number> | null = null;
  let previousSystemTicks: number | null = null;

  const readLinux = async (limit: number): Promise<ProcessStats | Unavailable> => {
    let pids: string[];
    try { pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name)).slice(0, 2048); }
    catch { return unavailable('failed'); }
    const systemTicks = parseLinuxTotalCpuTicks(await readText('/proc/stat') ?? '');
    if (systemTicks === null) return unavailable('failed');

    const current: ProcRecord[] = [];
    for (let offset = 0; offset < pids.length; offset += 64) {
      const chunk = await Promise.all(pids.slice(offset, offset + 64).map(async (pidText) => {
        const [statText, statusText] = await Promise.all([
          readText(`/proc/${pidText}/stat`), readText(`/proc/${pidText}/status`),
        ]);
        const parsed = statText ? parseLinuxProcessStat(statText) : null;
        if (!parsed) return null;
        return {
          pid: parsed.pid, name: parsed.name, cpuTicks: parsed.cpuTicks,
          memoryBytes: statusText ? parseLinuxProcessMemory(statusText) : null,
        } satisfies ProcRecord;
      }));
      current.push(...chunk.filter((item): item is ProcRecord => item !== null));
    }

    const totalDelta = previousSystemTicks === null ? null : systemTicks - previousSystemTicks;
    const previous = previousCpuTicks;
    const entries: ProcessEntry[] = current.map((item) => {
      const before = previous?.get(item.pid);
      const delta = before === undefined ? null : item.cpuTicks - before;
      const cpuPercent = delta === null || totalDelta === null || totalDelta <= 0 || delta < 0
        ? null
        : Math.min(100, (delta / totalDelta) * 100);
      return { pid: item.pid, name: item.name, cpuPercent, memoryBytes: item.memoryBytes };
    });
    previousCpuTicks = new Map(current.map((item) => [item.pid, item.cpuTicks]));
    previousSystemTicks = systemTicks;
    const ranked = rankProcesses(entries, limit);
    return { status: 'ok', ...ranked, sampledAt: now() };
  };

  const readOther = async (limit: number): Promise<ProcessStats | Unavailable> => {
    let entries: ProcessEntry[] | null;
    if (platform === 'win32') {
      const result = await runPowerShell(WINDOWS_PROCESSES, 8_000);
      if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'powershell');
      let data: unknown;
      try { data = JSON.parse(result.stdout.trim() || '{}'); } catch { return unavailable('failed'); }
      const fields = (key: string): string => {
        const value = typeof data === 'object' && data !== null ? Reflect.get(data, key) : undefined;
        return JSON.stringify(value ?? []);
      };
      const cpu = parseWindowsProcesses(fields('topCpu'), 20)?.map((item) => ({
        ...item,
        cpuPercent: item.cpuPercent === null ? null : Math.min(100, item.cpuPercent / Math.max(1, os.cpus().length)),
      })) ?? null;
      const memory = parseWindowsProcesses(fields('topMemory'), 20);
      if (cpu === null || memory === null) return unavailable('failed');
      const union = new Map<number, ProcessEntry>();
      for (const item of [...cpu, ...memory]) union.set(item.pid, { ...union.get(item.pid), ...item });
      const ranked = rankProcesses([...union.values()], limit);
      return { status: 'ok', ...ranked, sampledAt: now() };
    }
    if (platform === 'darwin') {
      const result = await run(['/bin/ps', 'ps'], ['-Ao', 'pid=,comm=,%cpu=,rss=']);
      if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'ps');
      entries = parsePsProcesses(result.stdout, 2048);
      if (entries === null) return unavailable('failed');
      const ranked = rankProcesses(entries, limit);
      return { status: 'ok', ...ranked, sampledAt: now() };
    }
    return unavailable('unsupported');
  };

  return { read: (limit) => platform === 'linux' ? readLinux(limit) : readOther(limit) };
};
