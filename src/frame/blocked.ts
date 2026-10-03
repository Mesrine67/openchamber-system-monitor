import type { Messages } from '../i18n/messages.ts';
import type { BlockedReason } from './poller.ts';

export const blockedText = (reason: BlockedReason, t: Messages): { title: string; body: string } => {
  if (reason === 'not-allowed') return { title: t.allowTitle, body: t.allowBody };
  if (reason === 'paused') return { title: t.pausedTitle, body: t.pausedBody };
  return { title: t.failedTitle, body: t.failedBody };
};
