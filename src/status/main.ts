// Compact Work Status section: health plus CPU, memory, busiest GPU and the fullest disk.
import { mountBadge, mountButton, mountProgress, mountSpinner, type BadgeHandle, type ProgressHandle, type Tone } from '@openchamber/sdk/ui';

import type { Messages } from '../i18n/messages.ts';
import type { MonitorMessages } from '../i18n/monitor.ts';
import { describeUnavailable, diskName, formatPercent } from '../frame/format.ts';
import { startFrame } from '../frame/host.ts';
import { BASE_CSS, element, installStyle, toneFor } from '../frame/ui.ts';
import { busiestGpu, diskPercent, fullestDisk, warningKey, type Stats, type WarningLevel } from '../shared/stats.ts';
import { blockedText } from '../frame/blocked.ts';

installStyle(`${BASE_CSS}
html,body{background:transparent;overflow:hidden}
#root{display:flex;flex-direction:column;gap:3px;padding:2px 0 4px}
.summary{display:flex;align-items:center;gap:6px;min-height:17px}
.summary-title{font-weight:600;font-size:11px}
.line{display:grid;grid-template-columns:minmax(70px,110px) minmax(40px,1fr) 38px;gap:7px;align-items:center;min-height:15px}
.line[hidden]{display:none!important}.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--oc-muted);font-size:11px}
.pct{text-align:right;color:var(--oc-muted);font-size:11px;font-variant-numeric:tabular-nums}
.pct.warn{color:var(--oc-warning-text)}.pct.critical{color:var(--oc-error-text)}
.line .oc-sdk-progress{margin:0;height:5px}.line .oc-sdk-progress-label{display:none}
.missing{grid-column:2/4;color:var(--oc-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.note{display:flex;align-items:center;gap:8px;color:var(--oc-muted);min-height:20px}
`);

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing root');

const summary = element('div', 'summary');
const summaryTitle = element('span', 'summary-title', 'System');
const healthSlot = element('span');
const healthBadge: BadgeHandle = mountBadge(healthSlot, { label: '…', tone: 'neutral' });
summary.append(summaryTitle, healthSlot);
const containerBadgeSlot = element('span');
summary.append(containerBadgeSlot);
root.replaceChildren(summary);

type CompactLine = {
  node: HTMLElement; name: HTMLElement; value: HTMLElement; progressSlot: HTMLElement; progress: ProgressHandle;
  update: (label: string, percent: number | null, missing: string | null, level: WarningLevel | null, locale: string) => void;
};
const makeLine = (label: string): CompactLine => {
  const node = element('div', 'line');
  node.hidden = true;
  const name = element('span', 'name', label);
  const progressSlot = element('div');
  const progress = mountProgress(progressSlot, { value: 0, tone: 'primary', label });
  const value = element('span', 'pct');
  node.append(name, progressSlot, value);
  root?.append(node);
  return {
    node, name, value, progressSlot, progress,
    update: (nextLabel, percent, missing, level, locale) => {
      name.textContent = nextLabel;
      node.hidden = false;
      if (percent === null) {
        progressSlot.hidden = true;
        value.textContent = '';
        value.className = 'pct';
        const note = element('span', 'missing', missing ?? '');
        const existing = node.querySelector('.missing');
        if (existing) existing.replaceWith(note); else node.append(note);
        return;
      }
      node.querySelector('.missing')?.remove();
      progressSlot.hidden = false;
      progress.update({ value: percent, tone: toneFor(level), label: nextLabel });
      value.textContent = formatPercent(percent, locale);
      value.className = `pct${level ? ` ${level}` : ''}`;
    },
  };
};
const cpuLine = makeLine('CPU');
const memoryLine = makeLine('Memory');
const gpuLine = makeLine('GPU');
const diskLine = makeLine('Disk');
const note = element('div', 'note');
root.append(note);

const warningLevel = (stats: Stats, kind: 'cpu' | 'memory' | 'gpu' | 'disk', target?: string | null): WarningLevel | null =>
  stats.warnings.find((item) => item.kind === kind && (target === undefined || item.target === target))?.level ?? null;

const stateLabel = (stats: Stats, tm: MonitorMessages): { label: string; tone: Tone } => stats.health.state === 'critical'
  ? { label: tm.critical, tone: 'error' }
  : stats.health.state === 'attention' ? { label: tm.attention, tone: 'warning' }
    : stats.health.state === 'unavailable' ? { label: tm.unavailableState, tone: 'neutral' }
      : { label: tm.healthy, tone: 'success' };

let badgeKey: string | null = null;
let reportedHeight = -1;
let host: ReturnType<typeof startFrame>;

host = startFrame(({ state, t, tm, locale, retry }) => {
  note.replaceChildren();
  if (state.kind === 'loading') {
    mountSpinner(note, { size: 'sm', label: t.measuring });
    note.hidden = false;
    return;
  }
  if (state.kind === 'blocked') {
    const message = blockedText(state.reason, t);
    note.append(element('span', '', message.body));
    if (state.reason === 'failed') mountButton(note, { label: t.retry, size: 'xs', variant: 'ghost', onClick: retry });
    note.hidden = false;
    return;
  }

  note.hidden = true;
  const { stats } = state;
  const stateInfo = stateLabel(stats, tm);
  healthBadge.update({ label: stateInfo.label, tone: stateInfo.tone });
  containerBadgeSlot.replaceChildren();
  if (stats.environment.container) {
    mountBadge(containerBadgeSlot, { label: t.container, tone: 'info' });
    containerBadgeSlot.title = t.containerHint;
  }
  cpuLine.update(t.cpu, stats.cpu.status === 'ok' ? stats.cpu.total : null,
    stats.cpu.status === 'ok' ? null : describeUnavailable(stats.cpu, t), warningLevel(stats, 'cpu'), locale);
  const memoryPercent = stats.memory.status === 'ok' && stats.memory.total > 0 ? stats.memory.used / stats.memory.total * 100 : null;
  memoryLine.update(t.memory, memoryPercent,
    stats.memory.status === 'ok' ? null : describeUnavailable(stats.memory, t), warningLevel(stats, 'memory'), locale);
  const gpu = busiestGpu(stats.gpus);
  if (stats.gpus.status === 'unavailable' && stats.gpus.reason === 'no-device') gpuLine.node.hidden = true;
  else gpuLine.update(t.gpu, gpu,
    stats.gpus.status === 'ok' ? (gpu === null ? t.notAvailable : null) : describeUnavailable(stats.gpus, t), warningLevel(stats, 'gpu'), locale);
  const disk = fullestDisk(stats.disks);
  diskLine.update(disk ? diskName(disk, t) : t.disk, disk ? diskPercent(disk) : null,
    disk ? null : stats.disks.status === 'ok' ? t.noDisks : describeUnavailable(stats.disks, t),
    warningLevel(stats, 'disk', disk?.mount ?? null), locale);

}, {
  onStats: (stats, client) => {
    const key = warningKey(stats.warnings);
    if (key === badgeKey) return;
    badgeKey = key;
    void client.setBadge(stats.warnings.length > 0 ? stats.warnings.length : null).catch(() => undefined);
  },
});

new ResizeObserver(() => {
  const height = Math.ceil(root.getBoundingClientRect().height);
  if (height === reportedHeight) return;
  reportedHeight = height;
  void host.setHeight(height).catch(() => undefined);
}).observe(root);
