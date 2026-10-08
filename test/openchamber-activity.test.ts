import { describe, expect, test } from 'bun:test';

import { filterSessions, sessionState } from '../src/shared/openchamber-activity.ts';
import type { GuestSessionRecord } from '@openchamber/sdk';

const session = (id: string, activity: GuestSessionRecord['activity'], outcome: GuestSessionRecord['outcome'], updatedAt: number, title = id): GuestSessionRecord => ({
  id, title, projectId: 'project', directory: '/private/project', parentId: null,
  createdAt: updatedAt - 1, updatedAt, archivedAt: null, worktree: null, activity, outcome, items: [],
});

describe('OpenChamber session activity projection', () => {
  test('uses observed activity before the last turn outcome', () => {
    expect(sessionState(session('live', 'running', 'failed', 2))).toBe('running');
    expect(sessionState(session('waiting', 'waiting-question', null, 3))).toBe('waiting-question');
    expect(sessionState(session('failed', 'idle', 'failed', 1))).toBe('failed');
  });

  test('filters by activity and title, sorts newest first, and caps the output', () => {
    const sessions = [
      session('old', 'running', null, 1, 'Build'),
      session('new', 'running', null, 3, 'build release'),
      session('wait', 'waiting-permission', null, 4, 'Deploy'),
      session('fail', 'idle', 'failed', 5, 'Broken build'),
    ];
    expect(filterSessions(sessions, 'active', 'build').map(({ id }) => id)).toEqual(['new', 'old']);
    expect(filterSessions(sessions, 'waiting', '').map(({ id }) => id)).toEqual(['wait']);
    expect(filterSessions(sessions, 'failed', '').map(({ id }) => id)).toEqual(['fail']);
    expect(filterSessions(Array.from({ length: 120 }, (_, index) => session(String(index), 'idle', null, index)), 'all', '')).toHaveLength(100);
  });
});
