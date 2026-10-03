import { unavailable, type Disk, type Platform, type Unavailable } from '../../shared/stats.ts';
import { run } from './exec.ts';
import { darwinDisks, linuxDisks, parseDf, parseWindowsDisks } from './parse-disks.ts';
import { runPowerShell } from './windows.ts';

const WINDOWS_DISKS =
  'Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID, VolumeName, Size, FreeSpace | ConvertTo-Json -Compress';
// PowerShell needs about a second to start; give the disk query more room than a tool call.
const WINDOWS_TIMEOUT_MS = 10_000;

const DF = ['/bin/df', '/usr/bin/df', 'df'];

const readDf = async (): Promise<{ ok: true; stdout: string } | Unavailable> => {
  // `-l` (local only) is missing from BusyBox; fall back to every filesystem.
  const local = await run(DF, ['-kPl']);
  if (local.ok) return local;
  const all = await run(DF, ['-kP']);
  if (all.ok) return all;
  return unavailable(all.missing ? 'tool-missing' : 'failed', 'df');
};

export const readDisks = async (platform: Platform, container: boolean): Promise<Disk[] | Unavailable> => {
  if (platform === 'win32') {
    const result = await runPowerShell(WINDOWS_DISKS, WINDOWS_TIMEOUT_MS);
    if (!result.ok) return unavailable(result.missing ? 'tool-missing' : 'failed', 'powershell');
    return parseWindowsDisks(result.stdout) ?? unavailable('failed');
  }
  if (platform === 'darwin' || platform === 'linux') {
    const df = await readDf();
    if (!('ok' in df)) return df;
    const rows = parseDf(df.stdout);
    if (rows.length === 0) return unavailable('failed');
    return platform === 'darwin' ? darwinDisks(rows) : linuxDisks(rows, container);
  }
  return unavailable('unsupported');
};
