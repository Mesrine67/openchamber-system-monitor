import { describe, expect, test } from 'bun:test';

import { createSampler, settle, type SamplerDeps } from '../src/service/sampler.ts';
import { evaluateWarnings, sustainedHigh, SUSTAINED_SAMPLES } from '../src/service/warnings.ts';
import {
  HISTORY_LENGTH,
  DEFAULT_MONITOR_SETTINGS,
  IDLE_STOP_MS,
  RETRY_UNAVAILABLE_MS,
  SAMPLE_INTERVAL_MS,
  unavailable,
  warningKey,
  type CpuStats,
  type Disk,
  type GpuStats,
  type MemoryStats,
  type Unavailable,
} from '../src/shared/stats.ts';

const cpuOk = (total: number): CpuStats => ({
  status: 'ok', total, perCore: [total], load: [1, 1, 1], cores: 1, limitCores: null, model: null,
});
const memoryOk = (used: number, total = 100): MemoryStats => ({ status: 'ok', used, total, swapUsed: null, swapTotal: null });
const gpuOk = (utilization: number | null): GpuStats => ({
  status: 'ok', devices: [{ name: 'GPU', utilization, memUsed: null, memTotal: null }],
});
const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};

/** Manual clock and timers; `advance` fires due timers in order. */
const harness = () => {
  let clock = 1_000_000;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 0;
  const calls = { cpu: 0, memory: 0, gpu: 0, disks: 0, gpuStop: 0, prime: 0 };
  const values = {
    cpu: (): CpuStats | Unavailable => cpuOk(10),
    memory: (): MemoryStats | Unavailable => memoryOk(50),
    gpu: (): GpuStats | Unavailable => gpuOk(20),
    disks: (): Disk[] | Unavailable => [{ mount: '/', label: null, used: 10, total: 100 }],
  };
  const deps: SamplerDeps = {
    now: () => clock,
    wait: async () => undefined,
    schedule: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: clock + ms, fn, id });
      return () => {
        timers = timers.filter((timer) => timer.id !== id);
      };
    },
    platform: 'linux',
    container: false,
    cpuMem: {
      prime: async () => { calls.prime += 1; },
      cpu: async () => { calls.cpu += 1; return values.cpu(); },
      memory: async () => { calls.memory += 1; return values.memory(); },
    },
    gpu: {
      read: async () => { calls.gpu += 1; return values.gpu(); },
      stop: () => { calls.gpuStop += 1; },
    },
    disks: async () => { calls.disks += 1; return values.disks(); },
  };
  const advance = async (ms: number) => {
    const target = clock + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      clock = due.at;
      due.fn();
      await flush();
    }
    clock = target;
  };
  return { deps, calls, values, advance, pending: () => timers.length };
};

describe('sampler', () => {
  test('first request primes, measures once and answers', async () => {
    const h = harness();
    const sampler = createSampler(h.deps);
    const stats = await sampler.stats();
    expect(h.calls.prime).toBe(1);
    expect(stats.cpu).toEqual(cpuOk(10));
    expect(stats.history.cpu).toEqual([10]);
    expect(sampler.running()).toBe(true);
    await flush();
    expect((await sampler.stats()).disks.status).toBe('ok');
  });

  test('ticks every interval, disks every 30 s, history capped', async () => {
    const h = harness();
    const sampler = createSampler(h.deps);
    await sampler.stats();
    for (let index = 0; index < HISTORY_LENGTH + 5; index++) {
      await h.advance(SAMPLE_INTERVAL_MS);
      if (index % 5 === 0) await sampler.stats(); // keep it from idling
    }
    const stats = await sampler.stats();
    expect(h.calls.cpu).toBe(HISTORY_LENGTH + 6);
    expect(stats.history.cpu.length).toBe(HISTORY_LENGTH);
    // The display history is capped; disks stay on their 30 s cadence.
    expect(h.calls.disks).toBe(5);
  });

  test('a slow disk collector cannot hold up fast CPU samples', async () => {
    const h = harness();
    let resolveDisk!: (value: Disk[] | Unavailable) => void;
    h.deps.disks = async () => {
      h.calls.disks += 1;
      return await new Promise<Disk[] | Unavailable>((resolve) => { resolveDisk = resolve; });
    };
    const sampler = createSampler(h.deps);
    const first = await sampler.stats();
    expect(first.cpu).toEqual(cpuOk(10));
    expect(h.calls.disks).toBe(1);

    await h.advance(SAMPLE_INTERVAL_MS);
    expect(h.calls.cpu).toBe(2);
    expect(h.calls.disks).toBe(1);
    expect(sampler.running()).toBe(true);

    resolveDisk([{ mount: '/', label: null, used: 10, total: 100 }]);
    await flush();
    expect((await sampler.stats()).disks.status).toBe('ok');
  });

  test('long history windows downsample display data without weakening sustained alerts', async () => {
    const h = harness();
    h.values.cpu = () => cpuOk(96);
    h.deps.settings = () => ({
      ...DEFAULT_MONITOR_SETTINGS,
      historyMinutes: 30,
      thresholds: { ...DEFAULT_MONITOR_SETTINGS.thresholds, sustainedSeconds: 30 },
    });
    const sampler = createSampler(h.deps);
    const first = await sampler.stats();
    expect(first.history.sampleIntervalMs).toBe(30_000);
    expect(first.history.cpu).toEqual([96]);
    for (let index = 0; index < 15; index += 1) {
      await h.advance(SAMPLE_INTERVAL_MS);
      await sampler.stats();
    }
    const after = await sampler.stats();
    expect(after.history.cpu.length).toBe(2);
    expect(after.warnings).toContainEqual({ kind: 'cpu', target: null, level: 'critical' });
  });

  test('stops after 30 s without a request and drops the history', async () => {
    const h = harness();
    const sampler = createSampler(h.deps);
    await sampler.stats();
    await h.advance(IDLE_STOP_MS + SAMPLE_INTERVAL_MS);
    expect(sampler.running()).toBe(false);
    expect(h.calls.gpuStop).toBe(1);
    expect(h.pending()).toBe(0);
    const again = await sampler.stats();
    expect(h.calls.prime).toBe(2);
    expect(again.history.cpu).toEqual([10]);
  });

  test('keeps the last good value through two failures, reports the third', async () => {
    const h = harness();
    const sampler = createSampler(h.deps);
    await sampler.stats();
    h.values.memory = () => unavailable('failed');
    await h.advance(SAMPLE_INTERVAL_MS);
    await h.advance(SAMPLE_INTERVAL_MS);
    expect((await sampler.stats()).memory).toEqual(memoryOk(50));
    await h.advance(SAMPLE_INTERVAL_MS);
    expect((await sampler.stats()).memory).toEqual(unavailable('failed'));
  });

  test('an unavailable source is asked again only after a minute', async () => {
    const h = harness();
    h.values.gpu = () => unavailable('tool-missing', 'nvidia-smi');
    const sampler = createSampler(h.deps);
    const first = await sampler.stats();
    expect(first.gpus.status).toBe('unavailable');
    expect(first.history.gpu).toEqual([null]);
    await flush();
    expect((await sampler.stats()).gpus).toEqual(unavailable('tool-missing', 'nvidia-smi'));
    for (let elapsed = 0; elapsed < RETRY_UNAVAILABLE_MS - SAMPLE_INTERVAL_MS; elapsed += SAMPLE_INTERVAL_MS) {
      await h.advance(SAMPLE_INTERVAL_MS);
      await sampler.stats();
    }
    expect(h.calls.gpu).toBe(1);
    h.values.gpu = () => gpuOk(5);
    await h.advance(SAMPLE_INTERVAL_MS);
    await flush();
    expect(h.calls.gpu).toBe(2);
    expect((await sampler.stats()).gpus).toEqual(gpuOk(5));
  });

  test('a throwing collector counts as a failure, not a dead sampler', async () => {
    const h = harness();
    h.values.cpu = () => { throw new Error('boom'); };
    const sampler = createSampler(h.deps);
    const stats = await sampler.stats();
    expect(stats.cpu).toEqual(unavailable('failed'));
    expect(stats.memory.status).toBe('ok');
  });

  test('settle keeps lastGood only for transient failures', () => {
    const source = { value: unavailable('failed'), lastGood: null, failures: 0, retryAt: 0 } as {
      value: MemoryStats | Unavailable; lastGood: MemoryStats | null; failures: number; retryAt: number;
    };
    settle(source, memoryOk(1), 0);
    settle(source, unavailable('no-device'), 5);
    expect(source.value).toEqual(unavailable('no-device'));
    expect(source.retryAt).toBe(5 + RETRY_UNAVAILABLE_MS);
  });
});

describe('warnings', () => {
  const high = Array.from({ length: SUSTAINED_SAMPLES }, () => 95);

  test('CPU needs a full minute at or above 90 %', () => {
    expect(sustainedHigh(high)).toBe(true);
    expect(sustainedHigh(high.slice(1))).toBe(false);
    expect(sustainedHigh([...high.slice(1), 89])).toBe(false);
    expect(sustainedHigh([...high.slice(1), null])).toBe(false);
  });

  test('memory and disks: warn at 90 %, critical at 95 %', () => {
    const warnings = evaluateWarnings({
      cpu: cpuOk(100),
      memory: memoryOk(91),
      disks: {
        status: 'ok',
        sampledAt: 0,
        items: [
          { mount: '/', label: null, used: 96, total: 100 },
          { mount: '/data', label: null, used: 50, total: 100 },
        ],
      },
      cpuHistory: high,
      gpuHistory: [99],
    });
    expect(warnings).toEqual([
      { kind: 'cpu', target: null, level: 'critical' },
      { kind: 'memory', target: null, level: 'warn' },
      { kind: 'disk', target: '/', level: 'critical' },
    ]);
  });

  test('the badge key ignores order', () => {
    const a = { kind: 'disk' as const, target: '/', level: 'warn' as const };
    const b = { kind: 'memory' as const, target: null, level: 'critical' as const };
    expect(warningKey([a, b])).toBe(warningKey([b, a]));
    expect(warningKey([])).toBe('');
  });
});
