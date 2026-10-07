import { describe, expect, test } from 'bun:test';

import { diskName, formatBytes, formatPercent } from '../src/frame/format.ts';
import { createPoller, TIMEOUTS_BEFORE_FAILED, type PollState } from '../src/frame/poller.ts';
import { isStats, readStats } from '../src/frame/read-stats.ts';
import { format, LOCALES, messagesFor, resolveLocale } from '../src/i18n/messages.ts';
import { monitorMessagesFor } from '../src/i18n/monitor.ts';
import type { Stats } from '../src/shared/stats.ts';

const stats = (sampledAt: number): Stats => ({
  sampledAt,
  environment: {
    platform: 'linux',
    container: false,
    computer: { hostName: 'test-host', operatingSystem: 'Linux 6.0', architecture: 'x64' },
  },
  cpu: { status: 'ok', total: 5, perCore: [5], load: null, cores: 1, limitCores: null, model: null },
  memory: { status: 'ok', used: 1, total: 2, available: 1, cached: null, committed: null, commitLimit: null, pressure: null, swapUsed: null, swapTotal: null },
  gpus: { status: 'unavailable', reason: 'no-device', tool: null },
  disks: { status: 'ok', items: [], sampledAt },
  diskActivity: { status: 'unavailable', reason: 'unsupported', tool: null },
  network: { status: 'unavailable', reason: 'unsupported', tool: null },
  processes: { status: 'unavailable', reason: 'unsupported', tool: null },
  battery: { status: 'unavailable', reason: 'no-device', tool: null },
  sensors: { status: 'unavailable', reason: 'no-device', tool: null },
  history: { cpu: [5], gpu: [null], memory: [50], networkDown: [null], networkUp: [null], sampleIntervalMs: 2000 },
  warnings: [],
  health: { state: 'healthy', warningCount: 0, criticalCount: 0, unavailableCount: 0 },
});

class HostError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const flush = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

const pollerHarness = () => {
  const states: PollState[] = [];
  const scheduled: number[] = [];
  let answers: (() => Promise<{ status: number; body: string }>)[] = [];
  let visible = true;
  const poller = createPoller({
    request: () => {
      const next = answers.shift();
      if (!next) throw new Error('no answer queued');
      return next();
    },
    onState: (state) => states.push(state),
    visible: () => visible,
    schedule: (_fn, ms) => {
      scheduled.push(ms);
      return () => undefined;
    },
  });
  return {
    poller,
    states,
    scheduled,
    answer: (fn: () => Promise<{ status: number; body: string }>) => { answers.push(fn); },
    hide: () => { visible = false; },
    reset: () => { answers = []; },
  };
};

describe('poller', () => {
  test('renders a reading and asks again after the interval', async () => {
    const h = pollerHarness();
    h.answer(async () => ({ status: 200, body: JSON.stringify(stats(10)) }));
    h.poller.poll();
    await flush();
    expect(h.states).toEqual([{ kind: 'ready', stats: stats(10) }]);
    expect(h.scheduled).toEqual([2000]);
  });

  test('drops an answer older than the one shown', async () => {
    const h = pollerHarness();
    h.answer(async () => ({ status: 200, body: JSON.stringify(stats(10)) }));
    h.poller.poll();
    await flush();
    h.answer(async () => ({ status: 200, body: JSON.stringify(stats(5)) }));
    h.poller.poll();
    await flush();
    expect(h.states.length).toBe(1);
  });

  test('maps host errors to the right notice', async () => {
    for (const [code, reason] of [['NO_SERVICE', 'not-allowed'], ['DISABLED', 'paused'], ['SERVICE_FAILED', 'failed'], ['HOST_REJECTED', 'failed']]) {
      const h = pollerHarness();
      h.answer(async () => { throw new HostError(code ?? ''); });
      h.poller.poll();
      await flush();
      expect(h.states).toEqual([{ kind: 'blocked', reason: reason as 'failed' }]);
    }
  });

  test('host timeouts stay quiet until the third, with growing backoff', async () => {
    const h = pollerHarness();
    for (let index = 0; index < TIMEOUTS_BEFORE_FAILED; index++) {
      h.answer(async () => { throw new HostError('HOST_TIMEOUT'); });
      h.poller.poll();
      await flush();
      if (index < TIMEOUTS_BEFORE_FAILED - 1) expect(h.states).toEqual([]);
    }
    expect(h.states).toEqual([{ kind: 'blocked', reason: 'failed' }]);
    expect(h.scheduled).toEqual([2000, 4000, 8000]);
  });

  test('backoff tops out at 10 s and recovers on success', async () => {
    const h = pollerHarness();
    for (let index = 0; index < 6; index++) {
      h.answer(async () => { throw new HostError('SERVICE_FAILED'); });
      h.poller.poll();
      await flush();
    }
    expect(h.scheduled.at(-1)).toBe(10_000);
    h.answer(async () => ({ status: 200, body: JSON.stringify(stats(1)) }));
    h.poller.poll();
    await flush();
    expect(h.states.at(-1)).toEqual({ kind: 'ready', stats: stats(1) });
    expect(h.scheduled.at(-1)).toBe(2000);
  });

  test('a hidden frame does not ask', async () => {
    const h = pollerHarness();
    h.hide();
    h.poller.poll();
    await flush();
    expect(h.states).toEqual([]);
    expect(h.scheduled).toEqual([]);
  });
});

describe('stats boundary', () => {
  test('accepts a full answer and refuses partial ones', () => {
    expect(isStats(stats(1))).toBe(true);
    expect(readStats(JSON.stringify(stats(1)))).toEqual(stats(1));
    expect(readStats('{"sampledAt":1}')).toBeNull();
    expect(readStats('nope')).toBeNull();
    const broken = { ...stats(1), cpu: { status: 'ok' } };
    expect(isStats(broken)).toBe(false);
  });
});

describe('i18n', () => {
  const keys = Object.keys(LOCALES.en).sort();
  const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

  test('all 13 OpenChamber locales are present', () => {
    expect(Object.keys(LOCALES).sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW']);
  });

  test('System Monitor messages are complete and placeholder-safe in every host locale', () => {
    const english = monitorMessagesFor('en');
    const monitorKeys = Object.keys(english).sort();
    for (const locale of Object.keys(LOCALES)) {
      const messages = monitorMessagesFor(locale);
      expect(Object.keys(messages).sort()).toEqual(monitorKeys);
      for (const key of monitorKeys) {
        const text = Reflect.get(messages, key);
        expect(typeof text === 'string' && text.trim().length > 0).toBe(true);
        expect(placeholders(String(text))).toEqual(placeholders(String(Reflect.get(english, key))));
      }
    }
    expect(monitorMessagesFor('fr').overview).not.toBe(english.overview);
    expect(monitorMessagesFor('de').overview).not.toBe(english.overview);
  });

  for (const [locale, messages] of Object.entries(LOCALES)) {
    test(`${locale} has every key, filled, with the same placeholders`, () => {
      expect(Object.keys(messages).sort()).toEqual(keys);
      for (const key of keys) {
        const text = Reflect.get(messages, key);
        const english = Reflect.get(LOCALES.en, key);
        expect(typeof text === 'string' && text.trim().length > 0).toBe(true);
        expect(placeholders(String(text))).toEqual(placeholders(String(english)));
      }
    });
  }

  test('locale resolution', () => {
    expect(resolveLocale('de')).toBe('de');
    expect(resolveLocale('de-AT')).toBe('de');
    expect(resolveLocale('pt-br')).toBe('pt-BR');
    expect(resolveLocale('pt-PT')).toBe('pt-BR');
    expect(resolveLocale('zh-HK')).toBe('zh-TW');
    expect(resolveLocale('zh')).toBe('zh-CN');
    expect(resolveLocale('xx')).toBe('en');
    expect(messagesFor('fr').memory).toBe('Mémoire');
    expect(format('{used} of {total}', { used: 'a', total: 'b' })).toBe('a of b');
  });

  test('numbers follow the locale', () => {
    expect(formatBytes(17.56 * 1024 ** 3, 'de')).toBe('17,6 GB');
    expect(formatBytes(17.56 * 1024 ** 3, 'en')).toBe('17.6 GB');
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatPercent(47.4, 'en')).toBe('47%');
  });
});

describe('disk names', () => {
  const t = messagesFor('de');
  test('system disk, labelled volume, bare mount', () => {
    expect(diskName({ mount: '/', label: null }, t)).toBe('System (/)');
    expect(diskName({ mount: 'C:', label: 'Windows' }, t)).toBe('Windows (C:)');
    expect(diskName({ mount: '/data', label: null }, t)).toBe('/data');
  });
});
