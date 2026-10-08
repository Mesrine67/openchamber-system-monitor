import type { GuestSessionRecord } from '@openchamber/sdk';

export type SessionFilter = 'all' | 'active' | 'waiting' | 'failed';
export type SessionState = 'running' | 'retrying' | 'waiting-permission' | 'waiting-question' | 'failed' | 'completed' | 'idle';

export const sessionState = (session: GuestSessionRecord): SessionState => {
  if (session.activity === 'running' || session.activity === 'retrying' || session.activity === 'waiting-permission' || session.activity === 'waiting-question') return session.activity;
  if (session.outcome === 'failed') return 'failed';
  if (session.outcome === 'completed') return 'completed';
  return 'idle';
};

export const filterSessions = (sessions: GuestSessionRecord[], filter: SessionFilter, query: string): GuestSessionRecord[] => {
  const needle = query.trim().toLocaleLowerCase();
  return sessions
    .filter((session) => {
      const state = sessionState(session);
      const matchesFilter = filter === 'all'
        || (filter === 'active' && (state === 'running' || state === 'retrying'))
        || (filter === 'waiting' && (state === 'waiting-permission' || state === 'waiting-question'))
        || (filter === 'failed' && state === 'failed');
      return matchesFilter && (!needle || session.title.toLocaleLowerCase().includes(needle));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 100);
};
