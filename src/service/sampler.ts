import os from 'node:os';

import {
  busiestGpu,
  DISK_INTERVAL_MS,
  FAILURES_BEFORE_UNAVAILABLE,
  HISTORY_LENGTH,
  IDLE_STOP_MS,
  RETRY_UNAVAILABLE_MS,
  SAMPLE_INTERVAL_MS,
  unavailable,
  type CpuStats,
  type Disk,
  type DiskStats,
  type GpuStats,
  type MemoryStats,
  type Platform,
  type Stats,
  type Unavailable,
} from '../shared/stats.ts';
import type { CpuMemCollector } from './collectors/cpu-mem.ts';
import type { GpuCollector } from './collectors/gpu.ts';
import { evaluateWarnings } from './warnings.ts';

/** Delay between the CPU baseline and the first reading, so the first answer has real numbers. */
export const PRIME_MS = 500;

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
};

type Source<T> = { value: T | Unavailable; lastGood: T | null; failures: number; retryAt: number };

const freshSource = <T>(): Source<T> => ({ value: unavailable('failed'), lastGood: null, failures: 0, retryAt: 0 });

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

const pushHistory = (history: (number | null)[], value: number | null): void => {
  history.push(value);
  if (history.length > HISTORY_LENGTH) history.splice(0, history.length - HISTORY_LENGTH);
};

export type Sampler = {
  /** Current snapshot. The first call starts sampling and waits for its first reading. */
  stats: () => Promise<Stats>;
  stop: () => void;
  running: () => boolean;
};

export const createSampler = (deps: SamplerDeps): Sampler => {
  let generation = 0;
  let active = false;
  let lastRequest = 0;
  let cancelTimer: (() => void) | null = null;
  let first: Promise<void> | null = null;
  let snapshot: Stats | null = null;
  let cpu = freshSource<CpuStats>();
  let memory = freshSource<MemoryStats>();
  let gpu = freshSource<GpuStats>();
  let disks = freshSource<DiskStats>();
  let disksDueAt = 0;
  let cpuHistory: (number | null)[] = [];
  let gpuHistory: (number | null)[] = [];

  const reset = () => {
    cpu = freshSource();
    memory = freshSource();
    gpu = freshSource();
    disks = freshSource();
    disksDueAt = 0;
    cpuHistory = [];
    gpuHistory = [];
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

  const tick = async (current: number) => {
    const now = deps.now();
    const readDisks = due(disks, now) && now >= disksDueAt;
    const [cpuResult, memoryResult, gpuResult, diskResult] = await Promise.all([
      due(cpu, now) ? safely(deps.cpuMem.cpu) : null,
      due(memory, now) ? safely(deps.cpuMem.memory) : null,
      due(gpu, now) ? safely(deps.gpu.read) : null,
      readDisks ? safely(deps.disks) : null,
    ]);
    if (current !== generation) return;
    const settledAt = deps.now();
    if (cpuResult) settle(cpu, cpuResult, settledAt);
    if (memoryResult) settle(memory, memoryResult, settledAt);
    if (gpuResult) settle(gpu, gpuResult, settledAt);
    if (diskResult) {
      settle(disks, Array.isArray(diskResult) ? { status: 'ok', items: diskResult, sampledAt: settledAt } : diskResult, settledAt);
      disksDueAt = settledAt + DISK_INTERVAL_MS;
    }

    pushHistory(cpuHistory, cpu.value.status === 'ok' ? cpu.value.total : null);
    pushHistory(gpuHistory, busiestGpu(gpu.value));
    snapshot = {
      sampledAt: settledAt,
      environment: {
        platform: deps.platform,
        container: deps.container,
        computer: {
          hostName: os.hostname() || null,
          operatingSystem: [deps.platform === 'win32' ? 'Windows' : deps.platform === 'darwin' ? 'macOS' : os.type(), os.release()]
            .filter(Boolean)
            .join(' ') || null,
          architecture: os.arch() || null,
        },
      },
      cpu: cpu.value,
      memory: memory.value,
      gpus: gpu.value,
      disks: disks.value,
      history: { cpu: [...cpuHistory], gpu: [...gpuHistory] },
      warnings: evaluateWarnings({
        cpu: cpu.value,
        memory: memory.value,
        disks: disks.value,
        cpuHistory,
        gpuHistory,
      }),
    };
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
      if (!active) first = start();
      if (first) await first;
      if (!snapshot) throw new Error('Sampling stopped before the first reading.');
      return snapshot;
    },
    stop,
    running: () => active,
  };
};
