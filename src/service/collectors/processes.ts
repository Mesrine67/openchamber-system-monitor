import os from 'node:os';
import { readdir } from 'node:fs/promises';

import { unavailable, type Platform, type ProcessEntry, type ProcessStats, type Unavailable } from '../../shared/stats.ts';
import { readText, run } from './exec.ts';
import { parseLinuxProcessMemory, parseLinuxProcessStat, parseLinuxTotalCpuTicks, parsePsProcesses, parseWindowsProcesses, processInventory, rankProcesses } from './parse-processes.ts';
import { runPowerShell } from './windows.ts';

const WINDOWS_PROCESSES = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -gt 0 -and $_.Name -ne '_Total' } | Select-Object Name, IDProcess, PercentProcessorTime, WorkingSetPrivate, CreatingProcessID, ThreadCount)
$cpu = @($rows | Sort-Object { [double]$_.PercentProcessorTime } -Descending | Select-Object -First 20)
$mem = @($rows | Sort-Object { [double]$_.WorkingSetPrivate } -Descending | Select-Object -First 20)
$items = @($rows | Sort-Object { [int]$_.IDProcess } | Select-Object -First 500)
@{ topCpu = $cpu; topMemory = $mem; items = $items; totalProcesses = $rows.Count } | ConvertTo-Json -Compress -Depth 3
`;

type ProcRecord = {
  pid: number; name: string; cpuTicks: number; memoryBytes: number | null;
  parentPid: number | null; threadCount: number | null; state: string | null;
};

export type ProcessCollector = { read: (limit: number) => Promise<ProcessStats | Unavailable> };

export const createProcessCollector = (platform: Platform, now: () => number): ProcessCollector => {
  let previousCpuTicks: Map<number, number> | null = null;
  let previousSystemTicks: number | null = null;

  const readLinux = async (limit: number): Promise<ProcessStats | Unavailable> => {
    let pids: string[];
    try { pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b)); }
    catch { return unavailable('failed'); }
    const systemTicks = parseLinuxTotalCpuTicks(await readText('/proc/stat') ?? '');
    if (systemTicks === null) return unavailable('failed');

    const totalProcesses = pids.length;
    // Rank across a larger bounded sample; the UI inventory below stays capped at 500.
    const selectedPids = pids.slice(0, 2_048);
    const current: ProcRecord[] = [];
    for (let offset = 0; offset < selectedPids.length; offset += 64) {
      const chunk = await Promise.all(selectedPids.slice(offset, offset + 64).map(async (pidText) => {
        const [statText, statusText] = await Promise.all([
          readText(`/proc/${pidText}/stat`), readText(`/proc/${pidText}/status`),
        ]);
        const parsed = statText ? parseLinuxProcessStat(statText) : null;
        if (!parsed) return null;
        return {
          pid: parsed.pid, name: parsed.name, cpuTicks: parsed.cpuTicks,
          parentPid: parsed.parentPid, threadCount: parsed.threadCount, state: parsed.state,
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
      return { pid: item.pid, name: item.name, cpuPercent, memoryBytes: item.memoryBytes, parentPid: item.parentPid, threadCount: item.threadCount, state: item.state };
    });
    previousCpuTicks = new Map(current.map((item) => [item.pid, item.cpuTicks]));
    previousSystemTicks = systemTicks;
    const ranked = rankProcesses(entries, limit);
    return { status: 'ok', ...ranked, ...processInventory(entries, totalProcesses), sampledAt: now() };
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
      const items = parseWindowsProcesses(fields('items'), 500);
      const totalProcesses = typeof data === 'object' && data !== null ? Number(Reflect.get(data, 'totalProcesses')) : NaN;
      if (cpu === null || memory === null || items === null || !Number.isFinite(totalProcesses)) return unavailable('failed');
      const union = new Map<number, ProcessEntry>();
      for (const item of [...cpu, ...memory]) union.set(item.pid, { ...union.get(item.pid), ...item });
      const ranked = rankProcesses([...union.values()], limit);
      return { status: 'ok', ...ranked, ...processInventory(items.map((item) => ({ ...item, cpuPercent: item.cpuPercent === null ? null : Math.min(100, item.cpuPercent / Math.max(1, os.cpus().length)) })), totalProcesses), sampledAt: now() };
    }
    if (platform === 'darwin') {
      const result = await run(['/bin/ps', 'ps'], ['-Ao', 'pid=,ppid=,stat=,%cpu=,rss=,comm=']);
      if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'ps');
      entries = parsePsProcesses(result.stdout, 2_048);
      if (entries === null) return unavailable('failed');
      const ranked = rankProcesses(entries, limit);
      const totalProcesses = result.stdout.split(/\r?\n/).filter((line) => /^\s*\d+\s/.test(line)).length;
      return { status: 'ok', ...ranked, ...processInventory(entries, totalProcesses), sampledAt: now() };
    }
    return unavailable('unsupported');
  };

  return { read: (limit) => platform === 'linux' ? readLinux(limit) : readOther(limit) };
};
