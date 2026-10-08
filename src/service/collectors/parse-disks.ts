// Pure disk parsers.

import type { Disk } from '../../shared/stats.ts';

const KIB = 1024;

type DfRow = { filesystem: string; size: number; used: number; available: number; mount: string };

/** `df -kP`: six columns, the mount point may contain spaces. */
export const parseDf = (text: string): DfRow[] => {
  const rows: DfRow[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[5]) continue;
    rows.push({
      filesystem: match[1],
      size: Number(match[2]) * KIB,
      used: Number(match[3]) * KIB,
      available: Number(match[4]) * KIB,
      mount: match[5],
    });
  }
  return rows;
};

// macOS system volumes that live in the same APFS container as the user's data.
const DARWIN_HIDDEN = /^\/(System\/Volumes\/(?!Data$)|Volumes\/Recovery$|private\/var\/vm$|Library\/Developer\/CoreSimulator\/)/;

/**
 * APFS volumes share their container's free space, so per-volume "used" is
 * misleading. Volumes with the same size and free space are one container:
 * used = size − available. The container is named after `/` when it holds it.
 */
export const darwinDisks = (rows: DfRow[]): Disk[] => {
  const containers = new Map<string, { mounts: string[]; size: number; available: number }>();
  for (const row of rows) {
    if (!row.filesystem.startsWith('/dev/') || DARWIN_HIDDEN.test(row.mount) || row.size <= 0) continue;
    const key = `${row.size}:${row.available}`;
    const entry = containers.get(key) ?? { mounts: [], size: row.size, available: row.available };
    entry.mounts.push(row.mount);
    containers.set(key, entry);
  }
  return [...containers.values()]
    .map((entry) => {
      const mount = entry.mounts.includes('/') ? '/' : entry.mounts.sort((a, b) => a.length - b.length)[0] ?? '/';
      // External volumes mount as /Volumes/<name>; that name is what Finder shows.
      const label = mount.startsWith('/Volumes/') ? mount.slice('/Volumes/'.length) || null : null;
      return { mount, label, used: entry.size - entry.available, total: entry.size };
    })
    .sort(byMount);
};

const LINUX_HIDDEN_MOUNT = /^\/(proc|sys|dev|run|snap)(\/|$)|^\/etc\//;

/**
 * Real filesystems (`/dev/…`, no loop devices), one row per device under its
 * shortest mount. In a container the overlay root `/` counts too. Percent
 * follows `df`: used / (used + available), since ext4 keeps reserved blocks.
 */
export const linuxDisks = (rows: DfRow[], container: boolean): Disk[] => {
  const byDevice = new Map<string, DfRow>();
  for (const row of rows) {
    const real = row.filesystem.startsWith('/dev/') && !row.filesystem.startsWith('/dev/loop');
    const containerRoot = container && row.mount === '/';
    if (!(real || containerRoot) || LINUX_HIDDEN_MOUNT.test(row.mount) || row.size <= 0) continue;
    const existing = byDevice.get(row.filesystem);
    if (!existing || row.mount.length < existing.mount.length) byDevice.set(row.filesystem, row);
  }
  // Bind mounts (container volumes, `/app`) show the backing filesystem's exact
  // numbers under another device name; identical figures are one filesystem.
  const byFigures = new Map<string, DfRow>();
  for (const row of byDevice.values()) {
    const key = `${row.size}:${row.used}:${row.available}`;
    const existing = byFigures.get(key);
    if (!existing || row.mount === '/' || (existing.mount !== '/' && row.mount.length < existing.mount.length)) {
      byFigures.set(key, row);
    }
  }
  return [...byFigures.values()]
    .map((row) => ({ mount: row.mount, label: null, used: row.used, total: row.used + row.available, device: row.filesystem }))
    .sort(byMount);
};

/** `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2 OR DriveType=3 OR DriveType=4" | … | ConvertTo-Json`: an object for one disk, an array for more. */
export const parseWindowsDisks = (text: string): Disk[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() || 'null');
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
  const disks: Disk[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const mount = Reflect.get(row, 'DeviceID');
    const label = Reflect.get(row, 'VolumeName');
    const size = Number(Reflect.get(row, 'Size'));
    const free = Number(Reflect.get(row, 'FreeSpace'));
    if (typeof mount !== 'string' || !Number.isFinite(size) || !Number.isFinite(free) || size <= 0) continue;
    const fileSystem = Reflect.get(row, 'FileSystem');
    const driveType = Number(Reflect.get(row, 'DriveType'));
    disks.push({
      mount,
      label: typeof label === 'string' && label.trim() ? label.trim() : null,
      used: size - free,
      total: size,
      device: mount,
      ...(typeof fileSystem === 'string' && fileSystem.trim() ? { fileSystem: fileSystem.trim() } : {}),
      ...(driveType === 2 ? { driveType: 'removable' as const } : driveType === 3 ? { driveType: 'fixed' as const } : driveType === 4 ? { driveType: 'network' as const } : {}),
    });
  }
  return disks.sort(byMount);
};

function byMount(left: Disk, right: Disk): number {
  if (left.mount === '/') return -1;
  if (right.mount === '/') return 1;
  return left.mount.localeCompare(right.mount);
}
