import { unavailable, type DiskActivityStats, type Platform, type Unavailable } from '../../shared/stats.ts';
import { readText } from './exec.ts';
import { diskActivityFromDelta, parseProcDiskStats, parseWindowsDiskActivity } from './parse-disk-activity.ts';
import { runPowerShell } from './windows.ts';

const WINDOWS_DISK_ACTIVITY = `
$ErrorActionPreference = 'SilentlyContinue'
@(Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk | Where-Object { $_.Name -match '^[A-Z]:$' } | Select-Object Name, DiskReadBytesPersec, DiskWriteBytesPersec, DiskReadsPersec, DiskWritesPersec, PercentDiskTime, AvgDisksecPerRead, AvgDisksecPerWrite) | ConvertTo-Json -Compress
`;

export const createDiskActivityCollector = (platform: Platform, now: () => number) => {
  let previous: ReturnType<typeof parseProcDiskStats> | null = null;
  let previousAt: number | null = null;
  return async (): Promise<DiskActivityStats | Unavailable> => {
    const sampledAt = now();
    if (platform === 'linux') {
      const text = await readText('/proc/diskstats');
      if (text === null) return unavailable('failed');
      const current = parseProcDiskStats(text);
      const items = diskActivityFromDelta(current, previous, previousAt === null ? 0 : sampledAt - previousAt);
      previous = current;
      previousAt = sampledAt;
      return items.length > 0 ? { status: 'ok', items, sampledAt } : unavailable('no-device');
    }
    if (platform === 'win32') {
      const result = await runPowerShell(WINDOWS_DISK_ACTIVITY, 8_000);
      if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'powershell');
      const items = parseWindowsDiskActivity(result.stdout);
      if (items === null) return unavailable('failed');
      return items.length > 0 ? { status: 'ok', items, sampledAt } : unavailable('no-device');
    }
    return unavailable(platform === 'darwin' ? 'unsupported' : 'unsupported');
  };
};
