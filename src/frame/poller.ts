import { SAMPLE_INTERVAL_MS, type Stats } from '../shared/stats.ts';
import { readStats } from './read-stats.ts';

export const MAX_BACKOFF_MS = 10_000;
/** Host timeouts in a row before the frame admits the service is gone. */
export const TIMEOUTS_BEFORE_FAILED = 3;

export type BlockedReason = 'not-allowed' | 'paused' | 'failed';

export type PollState =
  | { kind: 'loading' }
  | { kind: 'ready'; stats: Stats }
  | { kind: 'blocked'; reason: BlockedReason };

export type PollerDeps = {
  /** `host.serviceRequest` for `GET /stats`. Throws `HostRequestError`-like errors with a `code`. */
  request: () => Promise<{ status: number; body: string }>;
  onState: (state: PollState) => void;
  visible: () => boolean;
  schedule: (fn: () => void, ms: number) => () => void;
};

const errorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : null;
};

export type Poller = {
  /** Asks now, e.g. after Retry or when the frame becomes visible. */
  poll: () => void;
  dispose: () => void;
};

export const createPoller = (deps: PollerDeps): Poller => {
  let inFlight = false;
  let disposed = false;
  let failures = 0;
  let timeouts = 0;
  let shownAt = 0;
  let blocked = false;
  let cancel: (() => void) | null = null;

  const next = (ms: number) => {
    cancel?.();
    cancel = deps.schedule(() => {
      cancel = null;
      poll();
    }, ms);
  };

  const backoff = () => Math.min(MAX_BACKOFF_MS, SAMPLE_INTERVAL_MS * 2 ** Math.max(0, failures - 1));

  const fail = (reason: BlockedReason | null) => {
    failures += 1;
    if (reason) {
      blocked = true;
      deps.onState({ kind: 'blocked', reason });
    }
    next(backoff());
  };

  const poll = () => {
    if (disposed || inFlight) return;
    // A hidden frame does not measure; `visibilitychange` asks again.
    if (!deps.visible()) return;
    inFlight = true;
    void deps.request().then(
      (response) => {
        inFlight = false;
        if (disposed) return;
        const stats = response.status === 200 ? readStats(response.body) : null;
        if (!stats) {
          // 503 while the service warms up, or an answer we cannot read.
          timeouts += 1;
          fail(timeouts >= TIMEOUTS_BEFORE_FAILED ? 'failed' : null);
          return;
        }
        failures = 0;
        timeouts = 0;
        // An answer older than what is shown arrived late; keep the newer one.
        if (stats.sampledAt >= shownAt || blocked) {
          shownAt = stats.sampledAt;
          blocked = false;
          deps.onState({ kind: 'ready', stats });
        }
        next(SAMPLE_INTERVAL_MS);
      },
      (error: unknown) => {
        inFlight = false;
        if (disposed) return;
        const code = errorCode(error);
        if (code === 'NO_SERVICE') {
          fail('not-allowed');
        } else if (code === 'DISABLED') {
          fail('paused');
        } else if (code === 'HOST_TIMEOUT') {
          timeouts += 1;
          fail(timeouts >= TIMEOUTS_BEFORE_FAILED ? 'failed' : null);
        } else {
          fail('failed');
        }
      },
    );
  };

  return {
    poll: () => {
      cancel?.();
      cancel = null;
      poll();
    },
    dispose: () => {
      disposed = true;
      cancel?.();
      cancel = null;
    },
  };
};
