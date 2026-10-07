// Pure GPU parsers. A value a source does not report stays `null`.

import type { GpuDevice } from '../../shared/stats.ts';

const MIB = 1024 * 1024;

const percent = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? null : Math.min(100, Math.max(0, value));

const numberOrNull = (text: string | undefined): number | null => {
  if (text === undefined) return null;
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(value) ? value : null;
};

/**
 * macOS `ioreg -r -d 1 -w 0 -c IOAccelerator`. One `+-o` block per GPU.
 * Apple Silicon shares memory with the CPU, so there is no total; "In use
 * system memory" is what the GPU holds right now.
 */
export const parseIoreg = (text: string): GpuDevice[] => {
  const devices: GpuDevice[] = [];
  for (const block of text.split(/^\+-o /m).slice(1)) {
    const stats = /"PerformanceStatistics" = \{([^}]*)\}/.exec(block)?.[1];
    if (stats === undefined) continue;
    const read = (key: string): number | null => {
      const match = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}"=(\\d+)`).exec(stats);
      return match?.[1] ? Number(match[1]) : null;
    };
    const model = /"model" = (?:"([^"]+)"|<"([^"]+)">)/.exec(block);
    const className = /^(\S+)/.exec(block)?.[1] ?? 'GPU';
    devices.push({
      name: model?.[1] ?? model?.[2] ?? className,
      utilization: percent(read('Device Utilization %') ?? read('GPU Activity(%)')),
      memUsed: read('In use system memory') ?? read('vramUsedBytes'),
      memTotal: null,
    });
  }
  return devices;
};

/** NVIDIA query output. Legacy four-column output remains accepted for older drivers. */
export const parseNvidiaSmi = (text: string): GpuDevice[] => {
  const devices: GpuDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((part) => part.trim());
    // NVIDIA's name may contain commas; use the known column count to isolate it.
    if (parts.length < 4) continue;
    const extended = parts.length >= 9;
    const columns = extended ? parts.slice(-8) : parts.slice(-3);
    const name = parts.slice(0, parts.length - columns.length).join(', ') || 'NVIDIA GPU';
    const [utilizationText, usedText, totalText, temperatureText, frequencyText, powerText, fanText, driverText] = columns;
    const utilization = numberOrNull(utilizationText);
    const used = numberOrNull(usedText);
    const total = numberOrNull(totalText);
    devices.push({
      name,
      utilization: percent(utilization),
      memUsed: used === null ? null : used * MIB,
      memTotal: total === null ? null : total * MIB,
      ...(extended ? {
        temperatureC: numberOrNull(temperatureText),
        frequencyMHz: numberOrNull(frequencyText),
        powerW: numberOrNull(powerText),
        fanPercent: numberOrNull(fanText),
        driverVersion: driverText && driverText !== 'N/A' ? driverText : null,
      } : {}),
    });
  }
  return devices;
};

export type AmdCard = {
  card: string;
  vendor: string | null;
  busy: string | null;
  vramUsed: string | null;
  vramTotal: string | null;
};

/** AMD GPUs from `/sys/class/drm/cardN/device/*`; vendor `0x1002` is AMD. */
export const parseAmdCards = (cards: AmdCard[]): GpuDevice[] =>
  cards
    .filter((card) => card.vendor?.trim() === '0x1002' && card.busy !== null)
    .map((card) => ({
      name: `AMD GPU (${card.card})`,
      utilization: percent(numberOrNull(card.busy ?? undefined)),
      memUsed: numberOrNull(card.vramUsed ?? undefined),
      memTotal: numberOrNull(card.vramTotal ?? undefined),
    }));

const asArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
};

const LUID = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i;

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return numberOrNull(value);
  return null;
};

const toName = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * One line of the Windows sampler loop: WMI performance classes
 * `GPUPerformanceCounters_GPUEngine` (3D engines only) and `_GPUAdapterMemory`.
 * Their class names are not localised, unlike `typeperf` counter paths. Engines
 * are per process; Task Manager's GPU figure is their sum per adapter, capped at 100.
 */
export const parseWindowsGpu = (line: string): GpuDevice[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  const luidOf = (value: unknown): string | null =>
    LUID.exec(toName(record(value, 'Name')) ?? '')?.[1]?.toLowerCase() ?? null;

  // Only adapters with a 3D engine count as GPUs; memory rows attach to them.
  const adapters = new Map<string, {
    utilization: number;
    memUsed: number | null;
    memBudget: number | null;
    sharedMemUsed: number | null;
    sharedMemTotal: number | null;
  }>();
  for (const engine of asArray(record(parsed, 'engines'))) {
    const luid = luidOf(engine);
    const value = toNumber(record(engine, 'UtilizationPercentage'));
    if (!luid || value === null) continue;
    const entry = adapters.get(luid) ?? { utilization: 0, memUsed: null, memBudget: null, sharedMemUsed: null, sharedMemTotal: null };
    entry.utilization += value;
    adapters.set(luid, entry);
  }
  for (const row of asArray(record(parsed, 'memory'))) {
    const luid = luidOf(row);
    const value = toNumber(record(row, 'DedicatedUsage'));
    const budget = toNumber(record(row, 'DedicatedLimit'));
    const sharedUsed = toNumber(record(row, 'SharedUsage'));
    const sharedBudget = toNumber(record(row, 'SharedLimit'));
    const entry = luid ? adapters.get(luid) : undefined;
    if (!entry) continue;
    if (value !== null) entry.memUsed = (entry.memUsed ?? 0) + value;
    if (budget !== null) entry.memBudget = (entry.memBudget ?? 0) + budget;
    if (sharedUsed !== null) entry.sharedMemUsed = (entry.sharedMemUsed ?? 0) + sharedUsed;
    if (sharedBudget !== null) entry.sharedMemTotal = (entry.sharedMemTotal ?? 0) + sharedBudget;
  }
  const devices = [...adapters.entries()].sort(([left], [right]) => left.localeCompare(right));
  return devices.map(([, entry], index) => ({
    name: devices.length === 1 ? 'GPU' : `GPU ${index + 1}`,
    utilization: percent(entry.utilization),
    memUsed: entry.memUsed,
    memTotal: null,
    ...(entry.memBudget === null ? {} : { memBudget: entry.memBudget }),
    ...(entry.sharedMemUsed === null ? {} : { sharedMemUsed: entry.sharedMemUsed }),
    ...(entry.sharedMemTotal === null ? {} : { sharedMemTotal: entry.sharedMemTotal }),
  }));
};
