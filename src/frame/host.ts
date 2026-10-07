import { connectHost, type HostClient } from '@openchamber/sdk';
import type { GuestHostSurface } from '@openchamber/sdk';

import type { Stats } from '../shared/stats.ts';
import { applyHostReady } from '@openchamber/sdk/ui';

import { messagesFor, type Messages } from '../i18n/messages.ts';
import { monitorMessagesFor, type MonitorMessages } from '../i18n/monitor.ts';
import { createPoller, type PollState } from './poller.ts';

export type FrameContext = {
  state: PollState; t: Messages; tm: MonitorMessages; locale: string; retry: () => void;
  host: HostClient; surface: GuestHostSurface; setPollingInterval: (ms: number) => void;
};

export type FrameOptions = {
  /** Every new reading, with the host client, for effects beyond drawing (the badge). */
  onStats?: (stats: Stats, host: HostClient) => void;
};

/**
 * Shared wiring of both frames: theme and locale from the host, `/stats`
 * polling while the frame is visible, and a render on every change.
 */
export const startFrame = (render: (context: FrameContext) => void, options: FrameOptions = {}): HostClient => {
  const host = connectHost();
  let state: PollState = { kind: 'loading' };
  let locale = 'en';
  let surface: GuestHostSurface = 'panel';
  let t = messagesFor(locale);
  let tm = monitorMessagesFor(locale);

  const poller = createPoller({
    request: () => host.serviceRequest({ method: 'GET', path: '/stats' }),
    onState: (next) => {
      state = next;
      draw();
      if (next.kind === 'ready') options.onStats?.(next.stats, host);
    },
    visible: () => document.visibilityState === 'visible',
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  });

  const draw = () => render({
    state, t, tm, locale, retry: poller.poll, host, surface,
    setPollingInterval: (ms) => poller.setInterval(ms),
  });

  host.onReady((context) => {
    applyHostReady(context, document.documentElement);
    surface = context.surface;
    if (context.locale !== locale) {
      locale = context.locale;
      t = messagesFor(locale);
      tm = monitorMessagesFor(locale);
      document.documentElement.lang = locale;
    }
    draw();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poller.poll();
  });
  window.addEventListener('pagehide', () => {
    poller.dispose();
    host.dispose();
  });

  draw();
  poller.poll();
  return host;
};
