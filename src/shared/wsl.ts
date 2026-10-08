export type WslDistribution = {
  name: string;
  source: 'store' | 'imported' | 'unknown';
  state: 'running' | 'stopped' | 'unknown';
  version: 1 | 2 | null;
  isDefault: boolean;
  virtualDiskBytes: number | null;
  osName: string | null;
  osVersion: string | null;
  kernel: string | null;
  rootUsedBytes: number | null;
  rootTotalBytes: number | null;
  processCount: number | null;
  gpu: WslGpuStatus | null;
  remoteDesktopPort: number | null;
};

export type WslGpuStatus = {
  directX: boolean | null;
  cudaLibrary: boolean | null;
  nvidiaToolkit: boolean | null;
  cdiSpec: boolean | null;
};

export type WslSnapshot = {
  supported: boolean;
  reason: 'unsupported' | 'tool-missing' | 'failed' | null;
  version: string | null;
  defaultVersion: 1 | 2 | null;
  kernelVersion: string | null;
  wslgVersion: string | null;
  /** WSL 2 distributions share one utility VM, so guest memory is a global reading. */
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  distributions: WslDistribution[];
  sampledAt: number;
  error: string | null;
};

export type WslAction =
  | { action: 'start'; distro: string }
  | { action: 'stop'; distro: string }
  | { action: 'restart'; distro: string }
  | { action: 'set-default'; distro: string }
  | { action: 'set-default-version'; version: 1 | 2; confirmation: string }
  | { action: 'update-wsl'; confirmation: string }
  | { action: 'set-version'; distro: string; version: 1 | 2; confirmation: string }
  | { action: 'set-default-user'; distro: string; username: string; confirmation: string }
  | { action: 'install'; distro: string }
  | { action: 'export'; distro: string; file: string }
  | { action: 'import'; distro: string; location: string; file: string; version: 1 | 2 }
  | { action: 'clone'; distro: string; newDistro: string; location: string; version: 1 | 2; confirmation: string }
  | { action: 'rename'; distro: string; newDistro: string; location: string; version: 1 | 2; confirmation: string }
  | { action: 'move'; distro: string; location: string; confirmation: string }
  | { action: 'resize'; distro: string; size: string; confirmation: string }
  | { action: 'compact'; distro: string; confirmation: string }
  | { action: 'set-sparse'; distro: string; enabled: boolean }
  | { action: 'shutdown'; confirmation: string }
  | { action: 'force-shutdown'; confirmation: string }
  | { action: 'unregister'; distro: string; confirmation: string }
  | { action: 'open-terminal'; distro: string }
  | { action: 'open-files'; distro: string }
  | { action: 'open-vscode'; distro: string }
  | { action: 'open-rdp'; distro: string };

export type WslActionResult = { ok: boolean; message: string };

export type WslJob = {
  id: string;
  action: string;
  state: 'running' | 'succeeded' | 'failed';
  message: string;
  startedAt: number;
  finishedAt: number | null;
};

export type WslCatalogItem = { name: string; friendlyName: string };
export type WslCatalog = { supported: boolean; items: WslCatalogItem[]; error: string | null };

export type WslProcess = { pid: number; name: string; cpuPercent: number | null; memoryPercent: number | null };
export type WslListeningPort = { protocol: 'tcp' | 'udp'; address: string; port: number };
export type WslReadings<T> = { status: 'ok'; items: T[] } | { status: 'unavailable'; reason: string; items: [] };
export type WslDiagnostics = {
  distro: string;
  processes: WslReadings<WslProcess>;
  listeningPorts: WslReadings<WslListeningPort>;
  sampledAt: number;
};

export type WslConfigTarget = { kind: 'global' } | { kind: 'distribution'; distro: string };
export type WslConfigDocument = { target: WslConfigTarget; exists: boolean; text: string };
export type WslConfigUpdate = WslConfigTarget & { text: string; confirmation: string };
export type WslConfigInsight = { section: string; key: string; value: string };

/** Read-only summary of settings worth surfacing; unknown keys remain untouched in the editor. */
export const inspectWslConfig = (text: string): { insights: WslConfigInsight[]; hasBootCommand: boolean; networkingDisabled: boolean } => {
  let section = '';
  const settings = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const heading = /^\[([^\]]+)\]$/.exec(trimmed);
    if (heading) { section = heading[1]!.trim().toLocaleLowerCase(); continue; }
    const assignment = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*?)\s*$/.exec(trimmed);
    if (!assignment) continue;
    const key = assignment[1]!.toLocaleLowerCase();
    const value = assignment[2]!.replace(/^(["'])(.*)\1$/, '$2').trim();
    settings.set(`${section}.${key}`, value);
  }
  const visible = new Set([
    'wsl2.memory', 'wsl2.processors', 'wsl2.swap', 'wsl2.networkingmode', 'wsl2.localhostforwarding',
    'wsl2.dnstunneling', 'wsl2.autoproxy', 'wsl2.guiapplications', 'wsl2.gpusupport', 'wsl2.nestedvirtualization',
    'wsl2.debugconsole', 'wsl2.vmidletimeout',
    'experimental.sparsevhd', 'experimental.besteffortdnsparsing', 'experimental.automemoryreclaim',
    'general.instanceidletimeout',
    'boot.systemd', 'boot.command', 'automount.enabled', 'automount.mountfstab',
    'interop.enabled', 'interop.appendwindowspath', 'network.generatehosts', 'network.generateresolvconf',
    'user.default',
  ]);
  const insights = [...settings].filter(([path]) => visible.has(path)).map(([path, value]) => {
    const [sectionName, key] = path.split('.');
    return { section: sectionName!, key: key!, value };
  });
  return {
    insights,
    hasBootCommand: Boolean(settings.get('boot.command')?.trim()),
    networkingDisabled: settings.get('wsl2.networkingmode')?.toLocaleLowerCase() === 'none',
  };
};

const safeDistroName = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 128
  && !/[\u0000-\u001f\u007f/\\]/.test(value) && !value.startsWith('-');

const safeWindowsPath = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length <= 3 || value.length > 240 || !/^[A-Za-z]:\\/.test(value)
    || /[\u0000-\u001f\u007f"<>|?*]/.test(value)) return false;
  const segments = value.slice(3).split(/[\\/]/);
  return segments.length > 0 && segments.every((part) => part.length > 0 && part !== '.' && part !== '..'
    && !part.includes(':') && !part.endsWith('.') && !part.endsWith(' ')
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part));
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Strict request parser. Service requests never accept an arbitrary command or argument list. */
export const parseWslAction = (value: unknown): WslAction | null => {
  if (!record(value) || typeof value.action !== 'string') return null;
  const distro = value.distro;
  const isDistro = safeDistroName(distro);
  const confirmation = typeof value.confirmation === 'string' ? value.confirmation : '';
  switch (value.action) {
    case 'start': case 'stop': case 'restart': case 'set-default': case 'open-terminal': case 'open-files': case 'open-vscode': case 'open-rdp':
      return isDistro ? { action: value.action, distro } : null;
    case 'set-version':
      return isDistro && (value.version === 1 || value.version === 2)
        && confirmation === `SET VERSION ${distro} ${value.version}`
        ? { action: 'set-version', distro, version: value.version, confirmation } : null;
    case 'set-default-version':
      return (value.version === 1 || value.version === 2) && confirmation === `DEFAULT WSL ${value.version}`
        ? { action: 'set-default-version', version: value.version, confirmation } : null;
    case 'update-wsl':
      return confirmation === 'UPDATE WSL' ? { action: 'update-wsl', confirmation } : null;
    case 'set-default-user':
      return isDistro && typeof value.username === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(value.username)
        && confirmation === `USER ${value.username}`
        ? { action: 'set-default-user', distro, username: value.username, confirmation } : null;
    case 'install':
      return isDistro ? { action: 'install', distro } : null;
    case 'export':
      return isDistro && safeWindowsPath(value.file) ? { action: 'export', distro, file: value.file } : null;
    case 'import':
      return isDistro && safeWindowsPath(value.location) && safeWindowsPath(value.file) && (value.version === 1 || value.version === 2)
        ? { action: 'import', distro, location: value.location, file: value.file, version: value.version } : null;
    case 'clone': case 'rename': {
      const newDistro = value.newDistro;
      const expected = typeof newDistro === 'string' ? `${value.action.toLocaleUpperCase()} ${distro} AS ${newDistro}` : '';
      return isDistro && safeDistroName(newDistro) && safeWindowsPath(value.location)
        && newDistro.toLocaleLowerCase() !== distro.toLocaleLowerCase()
        && (value.version === 1 || value.version === 2) && confirmation === expected
        ? { action: value.action, distro, newDistro, location: value.location, version: value.version, confirmation } : null;
    }
    case 'move':
      return isDistro && safeWindowsPath(value.location) && confirmation === distro
        ? { action: 'move', distro, location: value.location, confirmation } : null;
    case 'resize':
      return isDistro && typeof value.size === 'string' && /^\d+(?:B|KB|MB|GB|TB)?$/i.test(value.size)
        && confirmation === `RESIZE ${distro}`
        ? { action: 'resize', distro, size: value.size, confirmation } : null;
    case 'compact':
      return isDistro && confirmation === `COMPACT ${distro}` ? { action: 'compact', distro, confirmation } : null;
    case 'set-sparse':
      return isDistro && typeof value.enabled === 'boolean' ? { action: 'set-sparse', distro, enabled: value.enabled } : null;
    case 'shutdown':
      return confirmation === 'SHUTDOWN WSL' ? { action: 'shutdown', confirmation } : null;
    case 'force-shutdown':
      return confirmation === 'FORCE SHUTDOWN WSL' ? { action: 'force-shutdown', confirmation } : null;
    case 'unregister':
      return isDistro && confirmation === distro ? { action: 'unregister', distro, confirmation } : null;
    default:
      return null;
  }
};

/** Config writes accept only the two documented WSL files and require a typed confirmation. */
export const parseWslConfigUpdate = (value: unknown): WslConfigUpdate | null => {
  if (!record(value) || typeof value.text !== 'string' || value.text.length > 16_384 || value.text.includes('\0')) return null;
  const text = value.text.replace(/\r\n?/g, '\n');
  if (value.kind === 'global') {
    return value.confirmation === 'SAVE GLOBAL WSL CONFIG' ? { kind: 'global', text, confirmation: value.confirmation } : null;
  }
  if (value.kind === 'distribution' && safeDistroName(value.distro)) {
    const confirmation = `SAVE WSL CONFIG ${value.distro}`;
    return value.confirmation === confirmation ? { kind: 'distribution', distro: value.distro, text, confirmation } : null;
  }
  return null;
};
