// Rail panel: every value the service measures, with history and per-core bars.
import { mountBadge, mountBanner, mountButton, mountSpinner } from '@openchamber/sdk/ui';

import { format, type Messages } from '../i18n/messages.ts';
import { blockedText } from '../frame/blocked.ts';
import { describeUnavailable, diskName, formatBytes, formatCores, formatNumber, formatPercent } from '../frame/format.ts';
import { startFrame } from '../frame/host.ts';
import { sparkline, SPARKLINE_CSS } from '../frame/sparkline.ts';
import { BASE_CSS, createMeter, element, installStyle } from '../frame/ui.ts';
import {
  diskPercent,
  levelForPercent,
  type CpuStats,
  type DiskStats,
  type GpuStats,
  type MemoryStats,
  type Stats,
  type Unavailable,
  type Warning,
} from '../shared/stats.ts';

installStyle(`${BASE_CSS}${SPARKLINE_CSS}
html,body{background:var(--oc-bg);min-height:100%}
#root{display:flex;flex-direction:column;gap:18px;padding:14px 14px 20px;container-type:inline-size}
section{display:flex;flex-direction:column;gap:8px;min-width:0}
section+section{border-top:1px solid var(--oc-border);padding-top:14px}
h2{margin:0;font-size:12px;font-weight:600;display:flex;align-items:baseline;gap:8px;min-width:0}
h2 .sub{font-weight:400;color:var(--oc-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.caption{display:flex;justify-content:space-between;gap:8px;color:var(--oc-muted);font-size:11px}
.cores{display:grid;gap:2px;height:28px;align-items:end}
.core{background:color-mix(in srgb,var(--oc-primary) 22%,transparent);border-radius:2px 2px 0 0;height:100%;position:relative;overflow:hidden}
.core>i{position:absolute;left:0;right:0;bottom:0;background:var(--oc-primary)}
.device{display:flex;flex-direction:column;gap:6px}
.device+.device{margin-top:6px}
.top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.center{display:flex;align-items:center;gap:8px;color:var(--oc-muted);padding:24px 0}
.info-row{display:flex;justify-content:space-between;gap:10px;color:var(--oc-muted);font-size:11px}
.info-row span:last-child{text-align:right;color:var(--oc-fg);overflow-wrap:anywhere}
`);

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing root');

const section = (title: string, sub: string | null = null): HTMLElement => {
  const node = element('section');
  const heading = element('h2', '', title);
  if (sub) heading.append(element('span', 'sub', sub));
  node.append(heading);
  return node;
};

const unavailableLine = (parent: HTMLElement, source: Unavailable, t: Messages) => {
  parent.append(element('div', 'unavailable', `${t.notAvailable}: ${describeUnavailable(source, t)}`));
};

const warningText = (warning: Warning, stats: Stats, t: Messages): string => {
  if (warning.kind === 'cpu') return t.warnCpu;
  if (warning.kind === 'gpu') return t.warnGpu;
  if (warning.kind === 'memory') return t.warnMemory;
  const disk = stats.disks.status === 'ok' ? stats.disks.items.find((item) => item.mount === warning.target) : undefined;
  return format(t.warnDisk, { target: disk ? diskName(disk, t) : warning.target ?? t.disk });
};

const cpuSection = (cpu: CpuStats | Unavailable, stats: Stats, t: Messages, locale: string): HTMLElement => {
  const computer = stats.environment.computer?.details;
  const model = cpu.status === 'ok' ? cpu.model : null;
  const frequency = computer?.cpuMaxMHz
    ? ` · ${format(t.maxSpeed, { n: (computer.cpuMaxMHz / 1000).toLocaleString(locale, { maximumFractionDigits: 2 }) })}`
    : '';
  const node = section(t.cpu, model ? `${model}${frequency}` : null);
  if (cpu.status !== 'ok') {
    unavailableLine(node, cpu, t);
    return node;
  }
  const sustained = stats.warnings.some((warning) => warning.kind === 'cpu');
  const coreText = cpu.limitCores !== null
    ? format(t.coreLimit, { n: formatCores(cpu.limitCores, locale) })
    : format(t.cores, { n: cpu.cores });
  createMeter(node).update({
    label: coreText,
    percent: cpu.total,
    value: formatPercent(cpu.total, locale),
    level: sustained ? 'warn' : null,
  });
  node.append(sparkline(stats.history.cpu, `${t.cpu} · ${t.history}`));
  if (computer?.physicalCores || computer?.logicalProcessors) {
    const details = element('div', 'caption');
    details.textContent = [
      computer.physicalCores ? format(t.physicalCores, { n: computer.physicalCores }) : null,
      computer.logicalProcessors ? format(t.logicalProcessors, { n: computer.logicalProcessors }) : null,
    ].filter(Boolean).join(' · ');
    node.append(details);
  }
  const caption = element('div', 'caption');
  caption.append(element('span', '', t.history));
  if (cpu.load) {
    caption.append(element('span', '', `${t.load} ${cpu.load.map((value) => formatNumber(value, locale)).join(' · ')}`));
  }
  node.append(caption);
  if (cpu.perCore.length > 1) {
    const cores = element('div', 'cores');
    cores.style.gridTemplateColumns = `repeat(${cpu.perCore.length}, minmax(0, 1fr))`;
    cores.setAttribute('role', 'img');
    cores.setAttribute('aria-label', t.perCore);
    cpu.perCore.forEach((value, index) => {
      const core = element('div', 'core');
      core.title = `#${index + 1}: ${formatPercent(value, locale)}`;
      const fill = element('i');
      fill.style.height = `${Math.round(value)}%`;
      core.append(fill);
      cores.append(core);
    });
    node.append(cores);
  }
  return node;
};

const memorySection = (memory: MemoryStats | Unavailable, t: Messages, locale: string): HTMLElement => {
  const node = section(t.memory);
  if (memory.status !== 'ok') {
    unavailableLine(node, memory, t);
    return node;
  }
  const percent = memory.total > 0 ? (memory.used / memory.total) * 100 : 0;
  createMeter(node).update({
    label: formatPercent(percent, locale),
    percent,
    value: format(t.usedOfTotal, { used: formatBytes(memory.used, locale), total: formatBytes(memory.total, locale) }),
    level: levelForPercent(percent),
  });
  if (memory.available !== undefined) {
    node.append(element('div', 'caption', `${t.availableMemory}: ${formatBytes(memory.available, locale)}`));
  }
  if (memory.swapTotal !== null && memory.swapUsed !== null) {
    const swapPercent = memory.swapTotal > 0 ? (memory.swapUsed / memory.swapTotal) * 100 : 0;
    createMeter(node).update({
      label: t.swap,
      percent: swapPercent,
      value: format(t.usedOfTotal, { used: formatBytes(memory.swapUsed, locale), total: formatBytes(memory.swapTotal, locale) }),
      level: null,
    });
  }
  return node;
};

const gpuSection = (gpus: GpuStats | Unavailable, stats: Stats, t: Messages, locale: string): HTMLElement => {
  const node = section(t.gpu);
  if (gpus.status !== 'ok') {
    unavailableLine(node, gpus, t);
    return node;
  }
  const sustained = stats.warnings.some((warning) => warning.kind === 'gpu');
  for (const device of gpus.devices) {
    const block = element('div', 'device');
    createMeter(block).update({
      label: device.name,
      percent: device.utilization,
      value: device.utilization === null ? t.notAvailable : formatPercent(device.utilization, locale),
      unavailable: device.utilization === null,
      level: sustained ? 'warn' : null,
    });
    if (device.memUsed !== null && device.memTotal !== null && device.memTotal > 0) {
      const percent = (device.memUsed / device.memTotal) * 100;
      createMeter(block).update({
      label: t.dedicatedMemory,
        percent,
        value: format(t.usedOfTotal, { used: formatBytes(device.memUsed, locale), total: formatBytes(device.memTotal, locale) }),
        level: null,
      });
    } else if (device.memUsed !== null) {
      block.append(element('div', 'caption', `${t.dedicatedMemory}: ${format(t.inUse, { used: formatBytes(device.memUsed, locale) })}`));
    }
    if (device.memBudget !== null && device.memBudget !== undefined) {
      block.append(element('div', 'caption', `${t.dedicatedMemory} · ${t.budget}: ${formatBytes(device.memBudget, locale)}`));
    }
    if (device.sharedMemUsed !== null && device.sharedMemUsed !== undefined) {
      const value = format(t.inUse, { used: formatBytes(device.sharedMemUsed, locale) });
      block.append(element('div', 'caption', `${t.sharedMemory}: ${value}`));
    }
    if (device.sharedMemTotal !== null && device.sharedMemTotal !== undefined) {
      block.append(element('div', 'caption', `${t.sharedMemory} · ${t.budget}: ${formatBytes(device.sharedMemTotal, locale)}`));
    }
    node.append(block);
  }
  if (stats.history.gpu.some((point) => point !== null)) {
    node.append(sparkline(stats.history.gpu, `${t.gpu} · ${t.history}`));
    const caption = element('div', 'caption');
    caption.append(element('span', '', t.history));
    node.append(caption);
  }
  return node;
};

const diskSection = (disks: DiskStats | Unavailable, t: Messages, locale: string): HTMLElement => {
  const node = section(t.disks);
  if (disks.status !== 'ok') {
    unavailableLine(node, disks, t);
    return node;
  }
  if (disks.items.length === 0) {
    node.append(element('div', 'unavailable', t.noDisks));
    return node;
  }
  for (const disk of disks.items) {
    const percent = diskPercent(disk);
    const meter = createMeter(node);
    meter.update({
      label: diskName(disk, t),
      percent,
      value: format(t.usedOfTotal, { used: formatBytes(disk.used, locale), total: formatBytes(disk.total, locale) }),
      level: levelForPercent(percent),
    });
    meter.node.title = formatPercent(percent, locale);
    const details = [
      disk.fileSystem,
      disk.driveType === 'fixed' ? t.fixedDrive : disk.driveType === 'removable' ? t.removableDrive : null,
      `${t.freeSpace}: ${formatBytes(disk.total - disk.used, locale)}`,
    ].filter(Boolean).join(' · ');
    if (details) node.append(element('div', 'caption', details));
  }
  return node;
};

const computerSection = (computer: NonNullable<Stats['environment']['computer']>, t: Messages, locale: string): HTMLElement => {
  const details = computer.details;
  const node = section(t.computer, [details?.manufacturer, details?.model].filter(Boolean).join(' · ') || null);
  const addRow = (label: string, value: string | null) => {
    const row = element('div', 'info-row');
    row.append(element('span', '', label), element('span', '', value || t.notAvailable));
    node.append(row);
  };
  addRow(t.hostName, computer.hostName);
  const osDetails = [
    details?.osName ?? computer.operatingSystem,
    details?.osVersion,
    details?.osBuild ? format(t.build, { n: details.osBuild }) : null,
  ].filter(Boolean).join(' · ');
  addRow(t.operatingSystem, osDetails || null);
  addRow(t.architecture, computer.architecture);
  if (details?.firmware) addRow(t.firmware, details.firmware);
  if (computer.uptimeSeconds !== undefined && computer.uptimeSeconds !== null) {
    const days = Math.floor(computer.uptimeSeconds / 86400);
    const hours = Math.floor((computer.uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((computer.uptimeSeconds % 3600) / 60);
    addRow(t.uptime, [days ? `${days} d` : null, `${hours} h ${minutes} min`].filter(Boolean).join(' '));
  }
  if (details?.memoryModules || details?.memorySpeedMHz) {
    addRow(t.memoryModules, [
      details.memoryModules ? `${details.memoryModules} ${t.memoryModules.toLowerCase()}` : null,
      details.memorySpeedMHz ? `${details.memorySpeedMHz} MHz` : null,
    ].filter(Boolean).join(' · '));
  }
  return node;
};

let openStorageSettings: (() => Promise<unknown>) | null = null;

startFrame(({ state, t, locale, retry }) => {
  if (state.kind === 'loading') {
    const note = element('div', 'center');
    mountSpinner(note, { size: 'sm', label: t.measuring });
    root.replaceChildren(note);
    return;
  }
  if (state.kind === 'blocked') {
    const slot = element('div');
    const text = blockedText(state.reason, t);
    mountBanner(slot, {
      tone: state.reason === 'failed' ? 'error' : 'warning',
      title: text.title,
      body: text.body,
      action: state.reason === 'failed' ? { label: t.retry, onClick: retry } : undefined,
    });
    root.replaceChildren(slot);
    return;
  }

  const { stats } = state;
  const nodes: HTMLElement[] = [];
  if (stats.environment.container) {
    const top = element('div', 'top');
    const badge = element('span');
    badge.title = t.containerHint;
    mountBadge(badge, { label: t.container, tone: 'info' });
    top.append(badge);
    nodes.push(top);
  }
  nodes.push(
    cpuSection(stats.cpu, stats, t, locale),
    memorySection(stats.memory, t, locale),
    gpuSection(stats.gpus, stats, t, locale),
    diskSection(stats.disks, t, locale),
  );
  if (stats.environment.computer) nodes.push(computerSection(stats.environment.computer, t, locale));
  if (stats.environment.platform === 'win32') {
    const storage = section(t.storageSettings);
    storage.append(element('div', 'caption', t.storageTip));
    if (openStorageSettings) {
      const action = element('div');
      mountButton(action, { label: t.openStorage, onClick: () => { void openStorageSettings?.().catch(() => undefined); } });
      storage.append(action);
    }
    nodes.push(storage);
  }
  if (stats.warnings.length > 0) {
    const slot = element('div');
    const critical = stats.warnings.some((warning) => warning.level === 'critical');
    mountBanner(slot, {
      tone: critical ? 'error' : 'warning',
      title: t.warnings,
      body: stats.warnings.map((warning) => warningText(warning, stats, t)).join('\n'),
    });
    nodes.push(slot);
  }
  root.replaceChildren(...nodes.filter((node) => node.childNodes.length > 0));
}, {
  onStats: (_stats, host) => {
    openStorageSettings = () => host.serviceRequest({ method: 'POST', path: '/open-storage-settings' });
  },
});
