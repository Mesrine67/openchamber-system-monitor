import { isIP } from 'node:net';
import type { WslCatalogItem, WslDistribution, WslGpuStatus, WslListeningPort, WslNetworkDiagnostics, WslProcess, WslReadings, WslSystemService } from '../../shared/wsl.ts';

export type WslDiagnosticSections = {
  processes: WslReadings<WslProcess>;
  listeningPorts: WslReadings<WslListeningPort>;
  services: WslReadings<WslSystemService>;
  network: WslNetworkDiagnostics;
};

/** Parses bounded output from the fixed, read-only WSL diagnostics probe. */
export const parseWslDiagnostics = (input: string | Uint8Array): WslDiagnosticSections => {
  const text = decodeWslText(input);
  const section = (name: 'PROCESSES' | 'PROCESSES_CPU' | 'PROCESSES_MEMORY' | 'PORTS' | 'SERVICES' | 'NETWORK'): string | null => {
    const marker = `__${name}__\n`;
    const start = text.indexOf(marker);
    if (start < 0) return null;
    const content = text.slice(start + marker.length);
    const end = content.search(/\n__/);
    return (end < 0 ? content : content.slice(0, end)).trim();
  };
  const legacyProcesses = section('PROCESSES');
  const cpuProcesses = section('PROCESSES_CPU');
  const memoryProcesses = section('PROCESSES_MEMORY');
  const processSources = cpuProcesses !== null || memoryProcesses !== null
    ? [cpuProcesses, memoryProcesses] as const
    : [legacyProcesses] as const;
  const processUnavailable = processSources.some((source) => source === '__UNAVAILABLE__');
  const processes = processSources.every((source) => source === null) || processUnavailable
    ? {
      status: 'unavailable' as const,
      reason: processUnavailable ? 'The ps utility is not available in this distribution.' : 'Process data was not returned.',
      items: [] as [],
    }
    : (() => {
      const items = new Map<number, WslProcess>();
      for (let sourceIndex = 0; sourceIndex < processSources.length; sourceIndex += 1) {
        const source = processSources[sourceIndex];
        if (source == null) continue;
        for (const line of source.split('\n')) {
          const value = line.trim();
          const modern = sourceIndex < 2 && (cpuProcesses !== null || memoryProcesses !== null);
          const match = modern
            ? /^(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.+?)\s*$/.exec(value)
            : /^(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/.exec(value);
          if (!match) continue;
          const pid = Number(match[1]);
          const cpuPercent = Number(modern ? match[2] : match[3]);
          const memoryPercent = Number(modern ? match[3] : match[4]);
          const name = (modern ? match[4] : match[2])?.trim();
          if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(cpuPercent) || cpuPercent < 0
            || !Number.isFinite(memoryPercent) || memoryPercent < 0 || !name) continue;
          items.set(pid, { pid, name: name.slice(0, 64), cpuPercent, memoryPercent });
        }
      }
      return { status: 'ok' as const, items: [...items.values()].slice(0, cpuProcesses !== null || memoryProcesses !== null ? 200 : 10) };
    })();

  const portsText = section('PORTS');
  const listeningPorts = (portsText === null || portsText === '__UNAVAILABLE__'
    ? { status: 'unavailable', reason: portsText === null ? 'Network data was not returned.' : 'The ss utility is not available in this distribution.', items: [] }
    : {
      status: 'ok',
      items: portsText.split('\n').flatMap((line) => {
        const match = line.trim().match(/^(tcp|udp)\s+(.+):(\d+)(?:\s+.*)?$/i);
        if (!match) return [];
        const port = Number(match[3]);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
        const owner = /users:\(\("([^"\r\n]{1,80})",pid=(\d+),fd=\d+\)/.exec(line);
        const ownerPid = owner?.[2] ? Number(owner[2]) : NaN;
        const processName = owner?.[1]?.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || null;
        return [{ protocol: match[1]!.toLowerCase() as 'tcp' | 'udp', address: match[2]!.slice(0, 80), port,
          processName, pid: Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : null }];
      }).filter((item, index, items) => items.findIndex((candidate) => candidate.protocol === item.protocol
        && candidate.address === item.address && candidate.port === item.port && candidate.pid === item.pid) === index).slice(0, 100),
    }) as WslReadings<WslListeningPort>;

  const servicesText = section('SERVICES');
  const services: WslReadings<WslSystemService> = servicesText === null || servicesText === '__UNAVAILABLE__'
    ? { status: 'unavailable', reason: servicesText === null ? 'Service data was not returned.' : 'systemd is unavailable or not running in this distribution.', items: [] }
    : {
      status: 'ok',
      items: servicesText.split('\n').flatMap((line) => {
        const match = /^([A-Za-z0-9_.@:-]+\.service)\s+(loaded|not-found|masked|error)\s+(active|inactive|failed|activating|deactivating|reloading)\s+(running|exited|dead|failed|waiting|start|stop|auto-restart|condition)\s*(.*)$/.exec(line.trim());
        if (!match) return [];
        return [{ unit: match[1]!.slice(0, 128), loadState: match[2]!, activeState: match[3]!, subState: match[4]!, description: match[5]!.trim().slice(0, 240) || null }];
      }).filter((item, index, items) => items.findIndex((candidate) => candidate.unit === item.unit) === index).slice(0, 100),
    };

  const networkText = section('NETWORK');
  let addresses: string[] = [];
  let gateway: string | null = null;
  let dnsServers: string[] = [];
  let configuredMode: string | null = null;
  let networkUnavailable = networkText === null || networkText === '__UNAVAILABLE__';
  if (!networkUnavailable && networkText !== null) {
    for (const line of networkText.split('\n')) {
      const separator = line.indexOf('=');
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key === 'ADDRESSES') addresses = value.split(/\s+/).filter((item) => isIP(item) !== 0).slice(0, 16);
      if (key === 'GATEWAY' && isIP(value) !== 0) gateway = value;
      if (key === 'DNS') dnsServers = value.split(/\s+/).filter((item) => isIP(item) !== 0).slice(0, 8);
      if (key === 'MODE' && /^[a-z][a-z0-9_-]{0,31}$/i.test(value)) configuredMode = value;
    }
    // A missing address marker means the guest probe did not return enough network data.
    networkUnavailable = !networkText.split('\n').some((line) => line.startsWith('ADDRESSES='));
  }
  const network: WslNetworkDiagnostics = networkUnavailable
    ? { status: 'unavailable', reason: networkText === '__UNAVAILABLE__' ? 'The guest network tools are not available in this distribution.' : 'Network data was not returned by the guest probe.', addresses: [], gateway: null, dnsServers: [], configuredMode }
    : { status: 'ok', addresses, gateway, dnsServers, configuredMode };
  return { processes, listeningPorts, services, network };
};

export type WslRegistrationMetadata = {
  name: string;
  source: WslDistribution['source'];
  virtualDiskBytes: number | null;
};

/** WSL may emit UTF-16LE text when writing to a redirected Windows pipe. */
export const decodeWslText = (input: string | Uint8Array): string => {
  if (typeof input === 'string') return input.replace(/^\uFEFF/, '').replaceAll('\u0000', '').replace(/\r/g, '');
  const bytes = Buffer.from(input);
  const sample = bytes.subarray(0, Math.min(bytes.length, 64));
  let zeroes = 0;
  for (let index = 1; index < sample.length; index += 2) if (sample[index] === 0) zeroes += 1;
  const utf16le = sample.length > 2 && zeroes / Math.max(1, Math.floor(sample.length / 2)) > 0.35;
  const text = utf16le ? bytes.toString('utf16le') : bytes.toString('utf8');
  return text.replace(/^\uFEFF/, '').replaceAll('\u0000', '').replace(/\r/g, '');
};

const finiteBytes = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export const parseWslList = (input: string | Uint8Array): WslDistribution[] => {
  const rows: WslDistribution[] = [];
  for (const rawLine of decodeWslText(input).split('\n')) {
    const line = rawLine.trimEnd();
    const match = line.match(/^\s*(\*)?\s*(.+?)\s{2,}(.+?)\s{2,}([12])\s*$/);
    if (!match || !match[2] || !match[3]) continue;
    const name = match[2].trim();
    const localizedState = match[3].trim().toLocaleLowerCase();
    if (!name || /^(name|nom)$/i.test(name)) continue;
    const state = /running|run|cours|ex[eé]cut/.test(localizedState) ? 'running'
      : /stopped|stop|arr[eê]t|termin/.test(localizedState) ? 'stopped' : 'unknown';
    rows.push({
      name,
      source: 'unknown',
      state,
      version: Number(match[4]) === 1 || Number(match[4]) === 2 ? Number(match[4]) as 1 | 2 : null,
      isDefault: match[1] === '*',
      virtualDiskBytes: null,
      osName: null,
      osVersion: null,
      kernel: null,
      rootUsedBytes: null,
      rootTotalBytes: null,
      processCount: null,
      gpu: null,
      remoteDesktopPort: null,
    });
  }
  return rows;
};

export const parseWslVersions = (input: string | Uint8Array): { version: string | null; kernelVersion: string | null; wslgVersion: string | null } => {
  const values = new Map<string, string>();
  for (const line of decodeWslText(input).split('\n')) {
    const split = line.indexOf(':');
    if (split < 0) continue;
    values.set(line.slice(0, split).trim().toLocaleLowerCase(), line.slice(split + 1).trim());
  }
  const pick = (...keys: string[]) => keys.map((key) => values.get(key)).find((value) => value && value.length > 0) ?? null;
  return {
    version: pick('wsl version', 'version du wsl', 'version wsl'),
    kernelVersion: pick('kernel version', 'version du noyau', 'version du kernel'),
    wslgVersion: pick('wslg version', 'version wslg'),
  };
};

export const parseWslDefaultVersion = (input: string | Uint8Array): 1 | 2 | null => {
  for (const line of decodeWslText(input).split('\n')) {
    const normalized = line.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
    const match = normalized.match(/^\s*(?:default\s+version|version\s+par\s+defaut|version\s+predeterminada)\s*:\s*([12])\s*$/);
    if (match?.[1] === '1' || match?.[1] === '2') return Number(match[1]) as 1 | 2;
  }
  return null;
};

export type WslDistroDetails = Pick<WslDistribution,
  'osName' | 'osVersion' | 'kernel' | 'rootUsedBytes' | 'rootTotalBytes' | 'processCount' | 'gpu' | 'remoteDesktopPort'>
  & { memoryUsedBytes: number | null; memoryTotalBytes: number | null };

/** Parses fixed, delimited output from the constant per-distro probe command. */
export const parseWslDistroDetails = (input: string | Uint8Array): WslDistroDetails => {
  const text = decodeWslText(input);
  const marker = (name: string) => {
    const token = `__${name}__\n`;
    const start = text.indexOf(token);
    if (start < 0) return '';
    const content = text.slice(start + token.length);
    const end = content.search(/\n__/);
    return end < 0 ? content : content.slice(0, end);
  };
  const os = new Map<string, string>();
  for (const line of marker('OS').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match?.[1]) os.set(match[1], (match[2] ?? '').replace(/^"|"$/g, ''));
  }
  const memory = marker('MEM').match(/^Mem:\s+(\d+)\s+(\d+)\s+(\d+)/m);
  const disk = marker('DISK').match(/^\S+\s+(\d+)\s+(\d+)\s+(\d+)/m);
  const kernel = text.match(/\n__KERNEL__=(.*)/)?.[1]?.trim() || null;
  const processCount = text.match(/\n__PROCS__=(\d+)/)?.[1];
  const gpuParts = text.match(/(?:^|\n)__GPU__=([01]),([01]),([01]),([01])(?:\n|$)/);
  const gpu: WslGpuStatus | null = gpuParts ? {
    directX: gpuParts[1] === '1',
    cudaLibrary: gpuParts[2] === '1',
    nvidiaToolkit: gpuParts[3] === '1',
    cdiSpec: gpuParts[4] === '1',
  } : null;
  const remoteDesktopPortValue = Number(text.match(/(?:^|\n)__XRDP__=(\d{1,5})(?:\n|$)/)?.[1]);
  const remoteDesktopPort = Number.isInteger(remoteDesktopPortValue) && remoteDesktopPortValue >= 1 && remoteDesktopPortValue <= 65_535
    ? remoteDesktopPortValue : null;
  return {
    osName: os.get('PRETTY_NAME') ?? os.get('NAME') ?? null,
    osVersion: os.get('VERSION_ID') ?? null,
    kernel,
    memoryUsedBytes: finiteBytes(memory?.[2]),
    memoryTotalBytes: finiteBytes(memory?.[1]),
    rootUsedBytes: finiteBytes(disk?.[2]),
    rootTotalBytes: disk?.[1] ? finiteBytes(disk[1]) : null,
    processCount: finiteBytes(processCount),
    gpu,
    remoteDesktopPort,
  };
};

/** Parses the current user's WSL registry rows without returning installation paths. */
export const parseWslRegistrationMetadata = (input: string | Uint8Array): WslRegistrationMetadata[] => {
  try {
    const decoded = decodeWslText(input).trim();
    if (!decoded) return [];
    const value: unknown = JSON.parse(decoded);
    const entries = Array.isArray(value) ? value : [value];
    const result: WslRegistrationMetadata[] = [];
    for (const item of entries) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (typeof row.Name !== 'string' || !row.Name.trim() || row.Name.length > 128) continue;
      const bytes = typeof row.VirtualDiskBytes === 'number' && Number.isSafeInteger(row.VirtualDiskBytes) && row.VirtualDiskBytes >= 0
        ? row.VirtualDiskBytes : null;
      result.push({
        name: row.Name,
        source: row.Source === 'store' || row.Source === 'imported' ? row.Source : 'unknown',
        virtualDiskBytes: bytes,
      });
    }
    return result;
  } catch {
    return [];
  }
};

export const parseWslCatalog = (input: string | Uint8Array): WslCatalogItem[] => {
  const items: WslCatalogItem[] = [];
  const seen = new Set<string>();
  for (const line of decodeWslText(input).split('\n')) {
    const match = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\s{2,}(.+?)\s*$/);
    if (!match?.[1] || !match[2] || /^(name|nom|install|the)$/i.test(match[1])) continue;
    const name = match[1];
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name, friendlyName: match[2].trim() });
  }
  return items;
};
