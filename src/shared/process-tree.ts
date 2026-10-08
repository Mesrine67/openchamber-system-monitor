import type { ProcessEntry } from './stats.ts';

export type ProcessTreeRow = {
  item: ProcessEntry;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
};

/** Flatten a bounded process inventory into a stable tree, breaking orphan/cyclic links safely. */
export const flattenProcessTree = (
  entries: ProcessEntry[],
  collapsedPids: ReadonlySet<number> = new Set(),
  compare: (left: ProcessEntry, right: ProcessEntry) => number = (left, right) => left.pid - right.pid,
): ProcessTreeRow[] => {
  const byPid = new Map(entries.map((item) => [item.pid, item]));
  const children = new Map<number, ProcessEntry[]>();
  for (const item of entries) {
    const parentPid = item.parentPid;
    if (parentPid === undefined || parentPid === null || parentPid === item.pid || !byPid.has(parentPid)) continue;
    const siblings = children.get(parentPid) ?? [];
    siblings.push(item);
    children.set(parentPid, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compare);

  const visited = new Set<number>();
  const hidden = new Set<number>();
  const rows: ProcessTreeRow[] = [];
  const hideDescendants = (item: ProcessEntry): void => {
    for (const child of children.get(item.pid) ?? []) {
      if (hidden.has(child.pid) || visited.has(child.pid)) continue;
      hidden.add(child.pid);
      hideDescendants(child);
    }
  };
  const visit = (item: ProcessEntry, depth: number): void => {
    if (visited.has(item.pid) || hidden.has(item.pid)) return;
    visited.add(item.pid);
    const descendants = children.get(item.pid) ?? [];
    const collapsed = collapsedPids.has(item.pid);
    rows.push({ item, depth, hasChildren: descendants.length > 0, collapsed });
    if (!collapsed) for (const child of descendants) visit(child, depth + 1);
    else hideDescendants(item);
  };

  const roots = entries.filter((item) => item.parentPid === undefined || item.parentPid === null
    || item.parentPid === item.pid || !byPid.has(item.parentPid)).sort(compare);
  for (const item of roots) visit(item, 0);
  // Malformed parent cycles have no root; surface each remaining process once instead of losing it.
  for (const item of [...entries].sort(compare)) visit(item, 0);
  return rows;
};
