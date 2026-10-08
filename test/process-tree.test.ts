import { describe, expect, test } from 'bun:test';
import { flattenProcessTree } from '../src/shared/process-tree.ts';
import type { ProcessEntry } from '../src/shared/stats.ts';

const processEntry = (pid: number, parentPid: number | null, name = `process-${pid}`): ProcessEntry => ({
  pid, parentPid, name, cpuPercent: null, memoryBytes: null,
});

describe('process tree', () => {
  test('keeps parent and child groups together and orders siblings by the selected comparator', () => {
    const rows = flattenProcessTree([
      processEntry(40, 20), processEntry(20, null), processEntry(21, 20), processEntry(10, null),
    ], new Set(), (left, right) => left.pid - right.pid);
    expect(rows.map(({ item, depth }) => [item.pid, depth])).toEqual([[10, 0], [20, 0], [21, 1], [40, 1]]);
    expect(rows.find(({ item }) => item.pid === 20)?.hasChildren).toBe(true);
  });

  test('omits collapsed descendants but keeps the parent row', () => {
    const rows = flattenProcessTree([processEntry(1, null), processEntry(2, 1), processEntry(3, 2)], new Set([1]));
    expect(rows.map(({ item, depth, collapsed }) => [item.pid, depth, collapsed])).toEqual([[1, 0, true]]);
  });

  test('surfaces missing parents and cyclic records exactly once', () => {
    const rows = flattenProcessTree([processEntry(5, 99), processEntry(7, 8), processEntry(8, 7)]);
    expect(rows.map(({ item }) => item.pid).sort((a, b) => a - b)).toEqual([5, 7, 8]);
    expect(new Set(rows.map(({ item }) => item.pid)).size).toBe(3);
  });
});
