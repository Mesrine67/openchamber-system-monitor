// Compact Work Status section: CPU, memory, busiest GPU and fullest disk.
// It also owns the rail badge, because it is the frame most likely to be on screen.
import { mountButton, mountProgress, mountSpinner } from '@openchamber/sdk/ui';

import type { Messages } from '../i18n/messages.ts';
import { describeUnavailable, formatPercent } from '../frame/format.ts';
import { startFrame } from '../frame/host.ts';
import { BASE_CSS, element, installStyle, toneFor } from '../frame/ui.ts';
import {
  busiestGpu,
  diskPercent,
  fullestDisk,
  warningKey,
  type Stats,
  type Unavailable,
  type Warning,
  type WarningLevel,
} from '../shared/stats.ts';
import { blockedText } from '../frame/blocked.ts';

installStyle(`${BASE_CSS}
html,body{background:transparent;overflow:hidden}
#root{display:grid;grid-template-columns:auto minmax(40px,1fr) auto;column-gap:8px;row-gap:4px;align-items:center;padding:2px 0 4px}
.line{display:contents}
.line .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
.line .pct{text-align:right;color:var(--oc-muted);min-width:34px}
.line .pct.warn{color:var(--oc-warning-text)}
.line .pct.critical{color:var(--oc-error-text)}
.line .na{grid-column:2/4;color:var(--oc-muted);font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.line .oc-sdk-progress-label{display:none}
.note,.tag{grid-column:1/-1}
.note{display:flex;align-items:center;gap:8px;color:var(--oc-muted);min-height:20px}
.tag{color:var(--oc-muted);font-size:11px}
`);

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing root');

type Line = { name: string; title?: string; percent: number | null; level: WarningLevel | null; missing?: string };

const levelOf = (warnings: Warning[], kind: Warning['kind'], target: string | null = null): WarningLevel | null =>
  warnings.find((warning) => warning.kind === kind && (target === null || warning.target === target))?.level ?? null;

const lines = (stats: Stats, t: Messages): Line[] => {
  const missing = (source: Unavailable) => describeUnavailable(source, t);
  const result: Line[] = [];
  const { cpu, memory, gpus, disks, warnings } = stats;
  result.push(cpu.status === 'ok'
    ? { name: t.cpu, percent: cpu.total, level: levelOf(warnings, 'cpu') }
    : { name: t.cpu, percent: null, level: null, missing: missing(cpu) });
  result.push(memory.status === 'ok'
    ? { name: t.memory, percent: memory.total > 0 ? (memory.used / memory.total) * 100 : null, level: levelOf(warnings, 'memory') }
    : { name: t.memory, percent: null, level: null, missing: missing(memory) });
  // No GPU at all is normal on servers; the compact view drops the row instead of saying so.
  if (gpus.status === 'ok' || gpus.reason !== 'no-device') {
    const busiest = busiestGpu(gpus);
    result.push(gpus.status === 'ok'
      ? { name: t.gpu, percent: busiest, level: levelOf(warnings, 'gpu'), missing: busiest === null ? t.notAvailable : undefined }
      : { name: t.gpu, percent: null, level: null, missing: missing(gpus) });
  }
  const disk = fullestDisk(disks);
  if (disks.status !== 'ok') {
    result.push({ name: t.disk, percent: null, level: null, missing: missing(disks) });
  } else if (disk) {
    const systemDisk = disk.mount === '/' || /^[A-Z]:$/i.test(disk.mount);
    result.push({
      name: systemDisk ? t.disk : `${t.disk} ${disk.label ?? disk.mount}`,
      title: disk.mount,
      percent: diskPercent(disk),
      level: levelOf(warnings, 'disk', disk.mount),
    });
  }
  return result;
};

const drawLine = (line: Line, locale: string): HTMLElement => {
  const node = element('div', 'line');
  const name = element('span', 'name', line.name);
  if (line.title) name.title = line.title;
  node.append(name);
  if (line.missing || line.percent === null) {
    node.append(element('span', 'na', line.missing ?? ''));
    return node;
  }
  const slot = element('div');
  mountProgress(slot, { value: line.percent, tone: toneFor(line.level), label: line.name });
  node.append(slot, element('span', `pct${line.level ? ` ${line.level}` : ''}`, formatPercent(line.percent, locale)));
  return node;
};

let badgeKey: string | null = null;

const host = startFrame(({ state, t, locale, retry }) => {
  if (state.kind === 'loading') {
    const note = element('div', 'note');
    mountSpinner(note, { size: 'sm', label: t.measuring });
    root.replaceChildren(note);
    return;
  }
  if (state.kind === 'blocked') {
    const note = element('div', 'note');
    note.append(element('span', '', blockedText(state.reason, t).body));
    if (state.reason === 'failed') mountButton(note, { label: t.retry, size: 'xs', variant: 'ghost', onClick: retry });
    root.replaceChildren(note);
    return;
  }
  const { stats } = state;
  const nodes = lines(stats, t).map((line) => drawLine(line, locale));
  if (stats.environment.container) {
    const tag = element('div', 'tag', t.container);
    tag.title = t.containerHint;
    nodes.push(tag);
  }
  root.replaceChildren(...nodes);
}, {
  // The badge counts active warnings and changes only when they do, so opening
  // the panel (which clears it) does not bring it straight back.
  onStats: (stats, client) => {
    const key = warningKey(stats.warnings);
    if (key === badgeKey) return;
    badgeKey = key;
    void client.setBadge(stats.warnings.length > 0 ? stats.warnings.length : null).catch(() => undefined);
  },
});

// The Work Status panel sizes this frame to its content.
let reportedHeight = -1;
new ResizeObserver(() => {
  const height = Math.ceil(root.getBoundingClientRect().height);
  if (height === reportedHeight) return;
  reportedHeight = height;
  void host.setHeight(height).catch(() => undefined);
}).observe(root);
