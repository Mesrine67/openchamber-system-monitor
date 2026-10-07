import os from 'node:os';

import {
  busiestGpu,
  DEFAULT_MONITOR_SETTINGS,
  DISK_INTERVAL_MS,
  FAILURES_BEFORE_UNAVAILABLE,
  HISTORY_LENGTH,
  WARNING_HISTORY_LENGTH,
  IDLE_STOP_MS,
  RETRY_UNAVAILABLE_MS,
  SAMPLE_INTERVAL_MS,
  unavailable,
  type CpuStats,
  type ComputerInfo,
  type Disk,
  type DiskStats,
  type DiskActivityStats,
  type GpuStats,
  type MemoryStats,
  type NetworkStats,
  type ProcessStats,
  type BatteryStats,
  type SensorStats,
  type MonitorSettings,
  type Platform,
  type Stats,
  type Unavailable,
} from '../shared/stats.ts';
import type { CpuMemCollector } from './collectors/cpu-mem.ts';
import type { GpuCollector } from './collectors/gpu.ts';
import { evaluateWarnings } from './warnings.ts';
import { deriveNetworkRates } from './collectors/parse-network.ts';
import { evaluateHealth } from '../shared/health.ts';

/** Delay between the CPU baseline and the first reading, so the first answer has real numbers. */
export const PRIME_MS = 500;
export const COMPUTER_INFO_INTERVAL_MS = 5 * 60_000;
export const NETWORK_INTERVAL_MS = 5_000;
export const PROCESS_INTERVAL_MS = 10_000;
export const SENSOR_INTERVAL_MS = 10_000;
export const BATTERY_INTERVAL_MS = 30_000;
export const DISK_ACTIVITY_INTERVAL_MS = 5_000;

export type SamplerDeps = {
  now: () => number;
  wait: (ms: number) => Promise<void>;
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule: (fn: () => void, ms: number) => () => void;
  platform: Platform;
  container: boolean;
  cpuMem: CpuMemCollector;
  gpu: GpuCollector;
  disks: () => Promise<Disk[] | Unavailable>;
  computerInfo?: () => Promise<ComputerInfo | Unavailable>;
  network?: () => Promise<NetworkStats | Unavailable>;
  processes?: (limit: number) => Promise<ProcessStats | Unavailable>;
  battery?: () => Promise<BatteryStats | Unavailable>;
  sensors?: () => Promise<SensorStats | Unavailable>;
  diskActivity?: () => Promise<DiskActivityStats | Unavailable>;
  settings?: () => MonitorSettings;
};

type Source<T> = { value: T | Unavailable; lastGood: T | null; failures: number; retryAt: number };

const freshSource = <T>(): Source<T> => ({ value: unavailable('pending'), lastGood: null, failures: 0, retryAt: 0 });

/**
 * One reading folded into a source. A transient failure keeps the last good
 * value; the third in a row reports the source unavailable. Anything
 * unavailable is asked again only after `RETRY_UNAVAILABLE_MS`.
 */
export const settle = <T extends { status: 'ok' }>(source: Source<T>, result: T | Unavailable, now: number): void => {
  if (result.status === 'ok') {
    source.value = result;
    source.lastGood = result;
    source.failures = 0;
    source.retryAt = 0;
    return;
  }
  if (result.reason === 'failed') {
    source.failures += 1;
    if (source.failures < FAILURES_BEFORE_UNAVAILABLE) {
      source.value = source.lastGood ?? result;
      return;
    }
  }
  source.value = result;
  source.lastGood = null;
  source.retryAt = now + RETRY_UNAVAILABLE_MS;
};

/** A collector that throws counts as one failed reading, never as a dead sampler. */
const safely = async <T>(read: () => Promise<T | Unavailable>): Promise<T | Unavailable> => {
  try {
    return await read();
  } catch {
    return unavailable('failed');
  }
};

const due = (source: Source<{ status: 'ok' }>, now: number): boolean => source.retryAt <= now;

class RingBuffer {
  private readonly points: (number | null)[];
  private next = 0;
  private count = 0;

  constructor(length: number) {
    this.points = Array.from({ length }, () => null);
  }

  push(value: number | null): void {
    this.points[this.next] = value;
    this.next = (this.next + 1) % this.points.length;
    this.count = Math.min(this.points.length, this.count + 1);
  }

  clear(): void { this.next = 0; this.count = 0; this.points.fill(null); }

  values(): (number | null)[] {
    if (this.count < this.points.length) return this.points.slice(0, this.count);
    return [...this.points.slice(this.next), ...this.points.slice(0, this.next)];
  }
}

const pushHistory = (history: RingBuffer, value: number | null): void => history.push(value);

export type Sampler = {
  /** Current snapshot. The first call starts sampling and waits for its first reading. */
  stats: () => Promise<Stats>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  running: () => boolean;
};

export const createSampler = (deps: SamplerDeps): Sampler => {
  let generation = 0;
  let active = false;
  let paused = false;
  let lastRequest = 0;
  let cancelTimer: (() => void) | null = null;
  let first: Promise<void> | null = null;
  let snapshot: Stats | null = null;
  let cpu = freshSource<CpuStats>();
  let memory = freshSource<MemoryStats>();
  let gpu = freshSource<GpuStats>();
  let disks = freshSource<DiskStats>();
  let diskActivity = freshSource<DiskActivityStats>();
  let network = freshSource<NetworkStats>();
  let processes = freshSource<ProcessStats>();
  let battery = freshSource<BatteryStats>();
  let sensors = freshSource<SensorStats>();
  let disksDueAt = 0;
  let networkDueAt = 0;
  let processesDueAt = 0;
  let batteryDueAt = 0;
  let sensorsDueAt = 0;
  let diskActivityDueAt = 0;
  let computerInfo: ComputerInfo | null = null;
  let computerInfoDueAt = 0;
  const cpuHistory = new RingBuffer(HISTORY_LENGTH);
  const gpuHistory = new RingBuffer(HISTORY_LENGTH);
  const memoryHistory = new RingBuffer(HISTORY_LENGTH);
  const networkDownHistory = new RingBuffer(HISTORY_LENGTH);
  const networkUpHistory = new RingBuffer(HISTORY_LENGTH);
  const cpuWarningHistory = new RingBuffer(WARNING_HISTORY_LENGTH);
  const gpuWarningHistory = new RingBuffer(WARNING_HISTORY_LENGTH);
  let historyIntervalMs = 0;
  let lastHistoryAt = 0;
  let previousNetwork: NetworkStats | null = null;

  const reset = () => {
    cpu = freshSource();
    memory = freshSource();
    gpu = freshSource();
    disks = freshSource();
    diskActivity = freshSource();
    network = freshSource();
    processes = freshSource();
    battery = freshSource();
    sensors = freshSource();
    disksDueAt = 0;
    networkDueAt = 0;
    processesDueAt = 0;
    batteryDueAt = 0;
    sensorsDueAt = 0;
    diskActivityDueAt = 0;
    computerInfo = null;
    computerInfoDueAt = 0;
    cpuHistory.clear();
    gpuHistory.clear();
    memoryHistory.clear();
    networkDownHistory.clear();
    networkUpHistory.clear();
    cpuWarningHistory.clear();
    gpuWarningHistory.clear();
    historyIntervalMs = 0;
    lastHistoryAt = 0;
    previousNetwork = null;
    snapshot = null;
  };

  const stop = () => {
    generation += 1;
    active = false;
    first = null;
    cancelTimer?.();
    cancelTimer = null;
    deps.gpu.stop();
    reset();
  };

  const pause = () => {
    if (paused) return;
    paused = true;
    generation += 1;
    active = false;
    first = null;
    cancelTimer?.();
    cancelTimer = null;
    deps.gpu.stop();
  };

  const resume = () => {
    if (!paused) return;
    paused = false;
    if (snapshot) first = start();
  };

  // Keep in-flight work generation-scoped so a slow command from a stopped
  // sampler cannot block the next request or erase its in-flight marker.
  const inFlight = new Map<string, number>();

  const publish = (sampledAt: number, recordHistory: boolean): void => {
    const settings = deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS;
    if (recordHistory) {
      const cpuPoint = cpu.value.status === 'ok' ? cpu.value.total : null;
      const gpuPoint = busiestGpu(gpu.value);
      const memoryPoint = memory.value.status === 'ok' && memory.value.total > 0 ? memory.value.used / memory.value.total * 100 : null;
      const rates = network.value.status === 'ok' ? network.value.interfaces : [];
      const down = rates.map((item) => item.downloadBytesPerSecond).filter((value): value is number => value !== null);
      const up = rates.map((item) => item.uploadBytesPerSecond).filter((value): value is number => value !== null);
      cpuWarningHistory.push(cpuPoint);
      gpuWarningHistory.push(gpuPoint);
      const nextHistoryInterval = Math.floor(settings.historyMinutes * 60_000 / HISTORY_LENGTH);
      if (nextHistoryInterval !== historyIntervalMs) {
        historyIntervalMs = nextHistoryInterval;
        lastHistoryAt = 0;
        cpuHistory.clear(); gpuHistory.clear(); memoryHistory.clear(); networkDownHistory.clear(); networkUpHistory.clear();
      }
      if (lastHistoryAt === 0 || sampledAt - lastHistoryAt >= historyIntervalMs) {
        pushHistory(cpuHistory, cpuPoint);
        pushHistory(gpuHistory, gpuPoint);
        pushHistory(memoryHistory, memoryPoint);
        pushHistory(networkDownHistory, down.length > 0 ? down.reduce((sum, value) => sum + value, 0) : null);
        pushHistory(networkUpHistory, up.length > 0 ? up.reduce((sum, value) => sum + value, 0) : null);
        lastHistoryAt = sampledAt;
      }
    }

    const warnings = evaluateWarnings({
      cpu: cpu.value,
      memory: memory.value,
      disks: disks.value,
      cpuHistory: cpuWarningHistory.values(),
      gpuHistory: gpuWarningHistory.values(),
    }, settings);
    const nextSnapshot: Stats = {
      sampledAt,
      environment: {
        platform: deps.platform,
        container: deps.container,
        computer: {
          hostName: os.hostname() || null,
          operatingSystem: [deps.platform === 'win32' ? 'Windows' : deps.platform === 'darwin' ? 'macOS' : os.type(), os.release()]
            .filter(Boolean)
            .join(' ') || null,
          architecture: os.arch() || null,
          uptimeSeconds: Math.floor(os.uptime()),
          details: computerInfo,
        },
      },
      cpu: cpu.value,
      memory: memory.value,
      gpus: gpu.value,
      disks: disks.value,
      diskActivity: diskActivity.value,
      network: network.value,
      processes: processes.value,
      battery: battery.value,
      sensors: sensors.value,
      history: {
        cpu: cpuHistory.values(), gpu: gpuHistory.values(), memory: memoryHistory.values(),
        networkDown: networkDownHistory.values(), networkUp: networkUpHistory.values(), sampleIntervalMs: historyIntervalMs || SAMPLE_INTERVAL_MS,
      },
      warnings,
      health: { state: 'healthy', warningCount: 0, criticalCount: 0, unavailableCount: 0 },
    };
    snapshot = { ...nextSnapshot, health: evaluateHealth(nextSnapshot) };
  };

  const launchSource = <T extends { status: 'ok' }>(
    current: number,
    key: string,
    source: Source<T>,
    read: () => Promise<T | Unavailable>,
    enabled?: () => boolean,
  ): void => {
    if (inFlight.get(key) === current) return;
    inFlight.set(key, current);
    void safely(read).then((result) => {
      if (current !== generation) return;
      const settledAt = deps.now();
      if (enabled?.() === false) {
        source.value = unavailable('disabled');
        source.lastGood = null;
        source.failures = 0;
        source.retryAt = 0;
      } else {
        settle(source, result, settledAt);
      }
      publish(settledAt, false);
    }).finally(() => {
      if (inFlight.get(key) === current) inFlight.delete(key);
    });
  };

  const tick = async (current: number) => {
    const now = deps.now();
    if (snapshot === null && networkDueAt === 0) {
      // Let the fast CPU/memory snapshot answer first, then stagger optional
      // and process-startup-heavy collectors across later ticks.
      networkDueAt = now + 2_500;
      diskActivityDueAt = now + 3_000;
      processesDueAt = now + 5_000;
      sensorsDueAt = now + 5_000;
      batteryDueAt = now + 10_000;
    }
    const settings = deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS;
    const cpuResult = due(cpu, now) ? await safely(deps.cpuMem.cpu) : null;
    if (current !== generation) return;
    const settledAt = deps.now();
    if (cpuResult) settle(cpu, cpuResult, settledAt);
    if (due(memory, now)) launchSource(current, 'memory', memory, deps.cpuMem.memory);
    if (due(gpu, now)) launchSource(current, 'gpu', gpu, deps.gpu.read);

    if (due(disks, now) && now >= disksDueAt) {
      disksDueAt = now + DISK_INTERVAL_MS;
      launchSource(current, 'disks', disks, async () => {
        const result = await deps.disks();
        return Array.isArray(result) ? { status: 'ok', items: result, sampledAt: deps.now() } : result;
      });
    }

    if (deps.computerInfo && now >= computerInfoDueAt && inFlight.get('computerInfo') !== current) {
      computerInfoDueAt = now + COMPUTER_INFO_INTERVAL_MS;
      inFlight.set('computerInfo', current);
      void safely(deps.computerInfo).then((result) => {
        if (current !== generation) return;
        computerInfo = 'status' in result ? null : result;
        publish(deps.now(), false);
      }).finally(() => {
        if (inFlight.get('computerInfo') === current) inFlight.delete('computerInfo');
      });
    }

    if (deps.network && !settings.modules.network) {
      network.value = unavailable('disabled'); network.lastGood = null; network.failures = 0; network.retryAt = 0; previousNetwork = null;
    } else if (deps.network && due(network, now) && now >= networkDueAt) {
      networkDueAt = now + NETWORK_INTERVAL_MS;
      launchSource(current, 'network', network, async () => {
        const result = await deps.network!();
        if (result.status !== 'ok') return result;
        const at = deps.now();
        const elapsed = previousNetwork ? at - previousNetwork.sampledAt : 0;
        const sampled = { ...result, interfaces: deriveNetworkRates(result.interfaces, previousNetwork?.interfaces ?? null, elapsed), sampledAt: at };
        previousNetwork = sampled;
        return sampled;
      }, () => (deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS).modules.network);
    }
    if (deps.processes && !settings.modules.processes) {
      processes.value = unavailable('disabled'); processes.lastGood = null; processes.failures = 0; processes.retryAt = 0;
    } else if (deps.processes && due(processes, now) && now >= processesDueAt) {
      processesDueAt = now + PROCESS_INTERVAL_MS;
      launchSource(current, 'processes', processes, () => deps.processes!(settings.processLimit), () => (deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS).modules.processes);
    }
    if (deps.battery && !settings.modules.battery) {
      battery.value = unavailable('disabled'); battery.lastGood = null; battery.failures = 0; battery.retryAt = 0;
    } else if (deps.battery && due(battery, now) && now >= batteryDueAt) {
      batteryDueAt = now + BATTERY_INTERVAL_MS;
      launchSource(current, 'battery', battery, deps.battery, () => (deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS).modules.battery);
    }
    if (deps.sensors && !settings.modules.sensors) {
      sensors.value = unavailable('disabled'); sensors.lastGood = null; sensors.failures = 0; sensors.retryAt = 0;
    } else if (deps.sensors && due(sensors, now) && now >= sensorsDueAt) {
      sensorsDueAt = now + SENSOR_INTERVAL_MS;
      launchSource(current, 'sensors', sensors, deps.sensors, () => (deps.settings?.() ?? DEFAULT_MONITOR_SETTINGS).modules.sensors);
    }
    if (deps.diskActivity && due(diskActivity, now) && now >= diskActivityDueAt) {
      diskActivityDueAt = now + DISK_ACTIVITY_INTERVAL_MS;
      launchSource(current, 'diskActivity', diskActivity, deps.diskActivity);
    }

    publish(settledAt, true);
  };

  const loop = (current: number) => {
    cancelTimer = deps.schedule(() => {
      cancelTimer = null;
      if (current !== generation) return;
      // Nobody asked for a while: stop measuring and drop the history.
      if (deps.now() - lastRequest >= IDLE_STOP_MS) {
        stop();
        return;
      }
      void tick(current).finally(() => {
        if (current === generation) loop(current);
      });
    }, SAMPLE_INTERVAL_MS);
  };

  const start = (): Promise<void> => {
    if (paused) return Promise.resolve();
    active = true;
    const current = generation;
    return (async () => {
      await deps.cpuMem.prime().catch(() => undefined);
      await deps.wait(PRIME_MS);
      if (current !== generation) return;
      await tick(current);
      if (current === generation) loop(current);
    })();
  };

  return {
    stats: async () => {
      lastRequest = deps.now();
      if (paused && snapshot) return snapshot;
      if (!active) first = start();
      if (first) await first;
      if (!snapshot) throw new Error('Sampling stopped before the first reading.');
      return snapshot;
    },
    stop,
    pause,
    resume,
    running: () => active,
  };
};
