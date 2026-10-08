import { unavailable, type Disk, type Platform, type Unavailable } from '../../shared/stats.ts';
import { readText, run } from './exec.ts';
import { darwinDisks, linuxDisks, parseDf, parseWindowsDisks } from './parse-disks.ts';
import { runPowerShell } from './windows.ts';

const WINDOWS_DISKS =
  'Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3 OR DriveType=4" | Select-Object DeviceID, VolumeName, Size, FreeSpace, FileSystem, DriveType | ConvertTo-Json -Compress';
// PowerShell needs about a second to start; give the disk query more room than a tool call.
const WINDOWS_TIMEOUT_MS = 10_000;

const DF = ['/bin/df', '/usr/bin/df', 'df'];

const deviceType = async (disk: Disk): Promise<Disk> => {
  if (!disk.device?.startsWith('/dev/')) return disk;
  const block = disk.device.slice('/dev/'.length);
  if (/^(mapper|disk|loop)/.test(block)) return disk;
  const queueBlock = block.replace(/p\d+$/, '');
  const rotationalBlock = /^(nvme\d+n\d+|mmcblk\d+)$/.test(queueBlock) ? queueBlock : queueBlock.replace(/\d+$/, '');
  if (!/^[a-zA-Z0-9_-]+$/.test(rotationalBlock)) return disk;
  const rotational = (await readText(`/sys/class/block/${rotationalBlock}/queue/rotational`))?.trim();
  if (rotational === '1') return { ...disk, deviceType: 'hdd' };
  if (rotational === '0') return { ...disk, deviceType: /^nvme/.test(rotationalBlock) ? 'nvme' : 'ssd' };
  return disk;
};

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
    if (platform === 'darwin') return darwinDisks(rows);
    return Promise.all(linuxDisks(rows, container).map(deviceType));
  }
  return unavailable('unsupported');
};
