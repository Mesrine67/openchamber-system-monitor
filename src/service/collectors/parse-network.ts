import type { NetworkInterface } from '../../shared/stats.ts';

const byteCount = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const linkSpeed = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(bps|kbps|mbps|gbps|tbps)\s*$/i.exec(value);
  if (!match?.[1] || !match[2]) return null;
  const multiplier = ({ bps: 1, kbps: 1e3, mbps: 1e6, gbps: 1e9, tbps: 1e12 } as const)[match[2].toLowerCase() as 'bps' | 'kbps' | 'mbps' | 'gbps' | 'tbps'];
  const parsed = Number(match[1]) * multiplier;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const row = (name: string, receivedBytes: unknown, sentBytes: unknown, isDefault: boolean | null = null): NetworkInterface | null => {
  const received = byteCount(receivedBytes);
  const sent = byteCount(sentBytes);
  if (!name || name === 'lo' || name === 'lo0' || name.toLowerCase().includes('loopback') || received === null || sent === null) return null;
  return {
    name: name.slice(0, 80), receivedBytes: received, sentBytes: sent,
    downloadBytesPerSecond: null, uploadBytesPerSecond: null, isDefault, linkSpeedBps: null,
  };
};

export const parseProcNetDev = (text: string, defaultInterface: string | null = null): NetworkInterface[] => {
  const result: NetworkInterface[] = [];
  for (const line of text.split(/\r?\n/).slice(2)) {
    const match = /^\s*([^:]+):\s*(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const name = match[1].trim();
    const fields = match[2].trim().split(/\s+/);
    if (fields.length < 9) continue;
    const parsed = row(name, fields[0], fields[8], defaultInterface === null ? null : name === defaultInterface);
    if (parsed) result.push(parsed);
  }
  return result;
};

export const parseDefaultRoute = (text: string): string | null => {
  const route = text.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/))
    .find((fields) => fields[1] === '00000000' && fields[0] && (Number.parseInt(fields[3] ?? '', 16) & 1) === 1);
  return route?.[0] ?? null;
};

/** `netstat -ibn` on macOS; ignores the address-specific rows with no counters. */
export const parseDarwinNetstat = (text: string): NetworkInterface[] => {
  const result = new Map<string, NetworkInterface>();
  let receivedIndex = -1;
  let sentIndex = -1;
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'Name') {
      receivedIndex = fields.findIndex((field) => field.toLowerCase() === 'ibytes');
      sentIndex = fields.findIndex((field) => field.toLowerCase() === 'obytes');
      continue;
    }
    if (receivedIndex < 0 || sentIndex < 0 || fields.length <= Math.max(receivedIndex, sentIndex)) continue;
    const parsed = row(fields[0] ?? '', fields[receivedIndex], fields[sentIndex]);
    if (parsed) result.set(parsed.name, parsed);
  }
  return [...result.values()];
};

export const parseDarwinDefaultRoute = (text: string): string | null =>
  /^interface:\s*(\S+)\s*$/mi.exec(text)?.[1] ?? null;

export const parseWindowsNetwork = (text: string): NetworkInterface[] | null => {
  let value: unknown;
  try { value = JSON.parse(text.trim() || 'null'); } catch { return null; }
  const rows = Array.isArray(value) ? value : value === null ? [] : [value];
  const result: NetworkInterface[] = [];
  for (const item of rows) {
    if (typeof item !== 'object' || item === null) continue;
    const parsed = row(
      String(Reflect.get(item, 'Name') ?? ''),
      Reflect.get(item, 'ReceivedBytes'),
      Reflect.get(item, 'SentBytes'),
      typeof Reflect.get(item, 'Default') === 'boolean' ? Reflect.get(item, 'Default') as boolean : null,
    );
    if (parsed) result.push({ ...parsed, linkSpeedBps: linkSpeed(Reflect.get(item, 'LinkSpeed')) });
  }
  return result;
};

export const deriveNetworkRates = (
  current: NetworkInterface[], previous: NetworkInterface[] | null, elapsedMs: number,
): NetworkInterface[] => current.map((item) => {
  const before = previous?.find((entry) => entry.name === item.name);
  if (!before || elapsedMs <= 0 || item.receivedBytes < before.receivedBytes || item.sentBytes < before.sentBytes) return item;
  return {
    ...item,
    downloadBytesPerSecond: (item.receivedBytes - before.receivedBytes) * 1000 / elapsedMs,
    uploadBytesPerSecond: (item.sentBytes - before.sentBytes) * 1000 / elapsedMs,
  };
});
