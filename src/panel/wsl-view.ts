import { mountBadge, mountButton, mountSelect, mountTextField, type ButtonVariant } from '@openchamber/sdk/ui';
import { format, type Messages } from '../i18n/messages.ts';
import type { MonitorMessages } from '../i18n/monitor.ts';
import { inspectWslConfig, type WslAction, type WslCatalog, type WslConfigDocument, type WslConfigTarget, type WslDiagnostics, type WslDistribution, type WslSnapshot } from '../shared/wsl.ts';
import { withWslConfigSetting } from '../service/collectors/parse-wsl-conf.ts';
import { element } from '../frame/ui.ts';

type ConfirmableAction = Extract<WslAction, { action: 'unregister' | 'shutdown' | 'force-shutdown' | 'set-version' | 'compact' | 'move' | 'resize' | 'clone' | 'rename' | 'set-default-user' | 'set-default-version' | 'update-wsl' | 'install-from-file' }>;

const fieldDrafts = new Map<string, string>();
const configSettingDrafts = new Map<string, string>();
let selectedWslDistro: string | null = null;
let selectedImportVersion: 1 | 2 = 2;
let selectedImportFormat: 'tar' | 'vhd' = 'tar';
let selectedPackageInstallVersion: 1 | 2 = 2;
const exportFormats = new Map<string, 'tar' | 'vhd'>();
let distroSearch = '';
let distroStateFilter = 'all';
let distroVersionFilter = 'all';
let distroSourceFilter = 'all';
let wslProcessSearch = '';
let wslProcessSort: 'cpu' | 'memory' = 'cpu';

export type WslPanelOptions = {
  snapshot: WslSnapshot | null;
  loading: boolean;
  busy: boolean;
  statusMessage: string | null;
  catalog: WslCatalog | null;
  catalogLoading: boolean;
  config: WslConfigDocument | null;
  configLoading: boolean;
  pendingRestarts: WslConfigTarget[];
  diagnostics: Record<string, WslDiagnostics | undefined>;
  diagnosticsLoading: string | null;
  t: Messages;
  tm: MonitorMessages;
  locale: string;
  onRefresh: () => void;
  onLoadCatalog: () => void;
  onAction: (action: WslAction) => void;
  onLoadConfig: (target: WslConfigTarget) => void;
  onSaveConfig: (target: WslConfigTarget, text: string) => void;
  onLoadDiagnostics: (distro: string) => void;
};

const byteText = (value: number | null, locale: string): string => value === null ? '—' : `${(value / 1_073_741_824).toLocaleString(locale, { maximumFractionDigits: 1 })} GB`;

const row = (parent: HTMLElement, label: string, value: string | null): void => {
  const line = element('div', 'row');
  line.append(element('span', 'muted', label), element('span', 'value', value || '—'));
  parent.append(line);
};

const actionButton = (parent: HTMLElement, label: string, onClick: () => void, disabled: boolean, variant: ButtonVariant = 'secondary'): void => {
  const slot = element('span', 'wsl-action');
  mountButton(slot, { label, variant, size: 'xs', disabled, onClick });
  parent.append(slot);
};

const textField = (parent: HTMLElement, key: string, label: string, placeholder: string, mono = true): (() => string) => {
  const slot = element('div');
  mountTextField(slot, { label, value: fieldDrafts.get(key) ?? '', placeholder, mono, onChange: (next) => { fieldDrafts.set(key, next); } });
  parent.append(slot);
  return () => (fieldDrafts.get(key) ?? '').trim();
};

const textArea = (parent: HTMLElement, key: string, label: string, initial: string, onChange?: (value: string) => void): (() => string) => {
  const slot = element('div', 'wsl-config-field');
  if (!fieldDrafts.has(key)) fieldDrafts.set(key, initial);
  mountTextField(slot, { label, value: fieldDrafts.get(key) ?? '', multiline: true, rows: 16, mono: true, onChange: (next) => { fieldDrafts.set(key, next); onChange?.(next); } });
  parent.append(slot);
  return () => fieldDrafts.get(key) ?? '';
};

const exactConfirm = <T,>(options: {
  title: string;
  body: string;
  expected: string;
  tm: MonitorMessages;
  action: (confirmation: string) => T;
  onAction: (action: T) => void;
}): void => {
  const dialog = document.createElement('dialog');
  dialog.className = 'wsl-confirm';
  dialog.setAttribute('aria-labelledby', 'wsl-confirm-title');
  const form = element('form', 'wsl-confirm-form');
  form.method = 'dialog';
  const title = element('h2', 'section-title', options.title);
  title.id = 'wsl-confirm-title';
  const body = element('p', 'caption', options.body);
  const expected = element('p', 'caption', format(options.tm.confirmExact, { value: options.expected }));
  const inputSlot = element('div');
  let value = '';
  const input = mountTextField(inputSlot, {
    label: options.tm.confirmAction,
    value,
    mono: true,
    onChange: (next) => {
      value = next;
      confirmButton.update({ label: options.tm.confirmAction, size: 'xs', variant: 'default', disabled: value !== options.expected, onClick: submit });
    },
  });
  const buttons = element('div', 'wsl-confirm-actions');
  const cancelSlot = element('span');
  mountButton(cancelSlot, { label: options.tm.cancel, size: 'xs', variant: 'secondary', onClick: () => dialog.close() });
  const confirmSlot = element('span');
  const submit = () => {
    if (value !== options.expected) return;
    dialog.close();
    options.onAction(options.action(value));
  };
  const confirmButton = mountButton(confirmSlot, { label: options.tm.confirmAction, size: 'xs', variant: 'default', disabled: true, onClick: submit });
  buttons.append(cancelSlot, confirmSlot);
  form.append(title, body, expected, inputSlot, buttons);
  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  input.update({ label: options.tm.confirmAction, value, mono: true, onChange: (next) => {
    value = next;
    confirmButton.update({ label: options.tm.confirmAction, size: 'xs', variant: 'default', disabled: value !== options.expected, onClick: submit });
  } });
  dialog.showModal();
};

const confirmable = (options: WslPanelOptions, action: ConfirmableAction): void => {
  const distroName = 'distro' in action ? action.distro : '';
  const expected = action.action === 'update-wsl' ? 'UPDATE WSL'
    : action.action === 'set-default-version' ? `DEFAULT WSL ${action.version}`
    : action.action === 'shutdown' ? 'SHUTDOWN WSL'
    : action.action === 'force-shutdown' ? 'FORCE SHUTDOWN WSL'
    : action.action === 'install-from-file' ? `INSTALL ${distroName} FROM FILE`
    : action.action === 'compact' ? `COMPACT ${distroName}`
      : action.action === 'set-version' ? `SET VERSION ${distroName} ${action.version}`
      : action.action === 'clone' || action.action === 'rename' ? `${action.action.toLocaleUpperCase()} ${distroName} AS ${action.newDistro}`
        : action.action === 'resize' ? `RESIZE ${distroName}`
          : action.action === 'set-default-user' ? `USER ${action.username}` : distroName;
  const body = action.action === 'update-wsl' ? options.tm.updateWslWarning
    : action.action === 'set-default-version' ? options.tm.defaultVersionWarning
    : action.action === 'unregister' ? options.tm.dataRemovedWarning
    : action.action === 'force-shutdown' ? options.tm.forceShutdownWarning
      : action.action === 'shutdown' ? options.tm.shutdownWarning
        : action.action === 'install-from-file' ? options.tm.installFromFileWarning
        : action.action === 'compact' ? format(options.tm.compactWarning, { distro: distroName })
        : action.action === 'set-version' ? options.tm.setVersionWarning
        : action.action === 'clone' ? options.tm.cloneWarning
        : action.action === 'rename' ? options.tm.renameWarning
        : action.action === 'move' ? format(options.tm.moveWarning, { distro: distroName })
          : action.action === 'resize' ? format(options.tm.resizeWarning, { distro: distroName })
            : options.tm.defaultUserWarning;
  exactConfirm({
    title: action.action === 'update-wsl' ? options.tm.updateWsl
      : action.action === 'set-default-version' ? options.tm.defaultWslVersion
      : action.action === 'unregister' ? options.tm.unregisterDistro : action.action === 'compact' ? options.tm.compactDisk : action.action === 'clone' ? options.tm.cloneDistro : action.action === 'rename' ? options.tm.renameDistro
      : action.action === 'set-version' ? options.tm.setVersion
        : action.action === 'move' ? options.tm.moveDistro : action.action === 'resize' ? options.tm.resizeDisk
          : action.action === 'set-default-user' ? options.tm.setDefaultUser
          : action.action === 'install-from-file' ? options.tm.installFromFile
        : action.action === 'force-shutdown' ? options.tm.forceShutdown : options.tm.shutdownAll,
    body,
    expected,
    tm: options.tm,
    action: (confirmation) => ({ ...action, confirmation }) as WslAction,
    onAction: options.onAction,
  });
};

const distroCard = (options: WslPanelOptions, distro: WslDistribution): HTMLElement => {
  const card = element('article', 'card wsl-distro');
  card.dataset.state = distro.state;
  card.dataset.version = distro.version === null ? 'unknown' : String(distro.version);
  card.dataset.source = distro.source;
  card.dataset.search = `${distro.name} ${distro.osName ?? ''} ${distro.osVersion ?? ''}`.toLocaleLowerCase();
  const header = element('div', 'wsl-distro-header');
  const title = element('h3', 'card-title', distro.name);
  const badgeSlot = element('span');
  const statusText = distro.state === 'running' ? options.tm.running : distro.state === 'stopped' ? options.tm.stopped : options.tm.unavailableState;
  mountBadge(badgeSlot, { label: statusText, tone: distro.state === 'running' ? 'success' : distro.state === 'stopped' ? 'neutral' : 'warning' });
  header.append(title, badgeSlot);
  if (distro.isDefault) header.append(element('span', 'wsl-default-label', options.tm.setDefaultDistro));
  card.append(header);
  const meta = element('div', 'caption');
  meta.textContent = [distro.version ? `WSL ${distro.version}` : null, distro.osName, distro.osVersion].filter(Boolean).join(' · ') || options.tm.unavailableState;
  card.append(meta);
  const detailGrid = element('div', 'wsl-detail-grid');
  row(detailGrid, options.tm.kernelVersion, distro.kernel);
  row(detailGrid, options.tm.source, distro.source === 'store' ? options.tm.storeSource : distro.source === 'imported' ? options.tm.importedSource : options.tm.unknownSource);
  row(detailGrid, options.tm.virtualDiskSize, byteText(distro.virtualDiskBytes, options.locale));
  row(detailGrid, options.tm.storage, distro.rootUsedBytes === null || distro.rootTotalBytes === null
    ? null : `${byteText(distro.rootUsedBytes, options.locale)} / ${byteText(distro.rootTotalBytes, options.locale)}`);
  row(detailGrid, options.tm.processes, distro.processCount?.toLocaleString(options.locale) ?? null);
  if (distro.state === 'running') row(detailGrid, options.t.cpu, options.tm.cpuPerDistroUnavailable);
  if (distro.gpu) {
    detailGrid.append(element('h4', 'card-title wsl-detail-heading', options.tm.gpuSupport));
    const state = (value: boolean | null): string => value === null ? options.t.notAvailable : value ? options.tm.gpuAvailable : options.tm.gpuUnavailable;
    row(detailGrid, options.tm.directXGpu, state(distro.gpu.directX));
    row(detailGrid, options.tm.cudaLibrary, state(distro.gpu.cudaLibrary));
    row(detailGrid, options.tm.nvidiaToolkit, state(distro.gpu.nvidiaToolkit));
    row(detailGrid, options.tm.cdiSpec, state(distro.gpu.cdiSpec));
  }
  card.append(detailGrid);

  if (distro.state === 'running' && distro.version === 2) {
    const diagnostics = options.diagnostics[distro.name];
    actionButton(card, options.diagnosticsLoading === distro.name ? options.tm.actionInProgress : options.tm.wslDiagnostics,
      () => options.onLoadDiagnostics(distro.name), options.busy || options.diagnosticsLoading !== null, 'ghost');
    if (diagnostics) {
      const diagnosticsView = element('div', 'wsl-detail-grid');
      diagnosticsView.setAttribute('aria-label', options.tm.wslDiagnostics);
      diagnosticsView.append(element('h4', 'card-title wsl-detail-heading', options.tm.processes));
      if (diagnostics.processes.status === 'unavailable') diagnosticsView.append(element('div', 'caption', diagnostics.processes.reason));
      else if (diagnostics.processes.items.length === 0) diagnosticsView.append(element('div', 'caption', options.tm.noProcesses));
      else {
        diagnosticsView.append(element('div', 'caption', options.tm.wslProcessSample));
        const processControls = element('div', 'wsl-process-controls');
        const searchSlot = element('div');
        const applyProcessView = (): void => {
          const query = wslProcessSearch.trim().toLocaleLowerCase(options.locale);
          const sorted = [...diagnostics.processes.items].sort((left, right) => {
            const primary = wslProcessSort === 'cpu' ? left.cpuPercent : left.memoryPercent;
            const secondary = wslProcessSort === 'cpu' ? right.cpuPercent : right.memoryPercent;
            return (secondary ?? -1) - (primary ?? -1);
          });
          processRows.replaceChildren();
          let visible = 0;
          for (const process of sorted) {
            if (query && !process.name.toLocaleLowerCase(options.locale).includes(query) && !String(process.pid).includes(query)) continue;
            const line = element('div', 'wsl-process-row');
            line.append(
              element('span', 'value', process.name),
              element('span', 'muted', `${options.tm.pid} ${process.pid}`),
              element('span', 'value', `${options.tm.cpu} ${process.cpuPercent?.toLocaleString(options.locale, { maximumFractionDigits: 1 }) ?? '—'}%`),
              element('span', 'value', `${options.tm.memory} ${process.memoryPercent?.toLocaleString(options.locale, { maximumFractionDigits: 1 }) ?? '—'}%`),
            );
            processRows.append(line);
            visible += 1;
          }
          noProcessMatch.hidden = visible > 0;
        };
        mountTextField(searchSlot, {
          label: options.tm.searchWslProcesses,
          value: wslProcessSearch,
          onChange: (value) => { wslProcessSearch = value; applyProcessView(); },
        });
        const sortSlot = element('div');
        mountSelect(sortSlot, {
          label: options.tm.sortWslProcesses,
          value: wslProcessSort,
          options: [
            { id: 'cpu', label: options.tm.sortWslByCpu },
            { id: 'memory', label: options.tm.sortWslByMemory },
          ],
          onChange: (value) => { if (value === 'cpu' || value === 'memory') { wslProcessSort = value; applyProcessView(); } },
        });
        processControls.append(searchSlot, sortSlot);
        diagnosticsView.append(processControls);
        const processRows = element('div', 'wsl-process-list');
        const noProcessMatch = element('div', 'caption', options.tm.noWslProcessMatches);
        noProcessMatch.hidden = true;
        diagnosticsView.append(processRows, noProcessMatch);
        applyProcessView();
      }
      diagnosticsView.append(element('h4', 'card-title wsl-detail-heading', options.tm.network));
      if (diagnostics.network.status === 'unavailable') diagnosticsView.append(element('div', 'caption', options.tm.wslNetworkUnavailable));
      else {
        row(diagnosticsView, options.tm.wslConfiguredMode, diagnostics.network.configuredMode ?? options.t.notAvailable);
        row(diagnosticsView, options.tm.wslAddresses, diagnostics.network.addresses.join(', ') || options.t.notAvailable);
        row(diagnosticsView, options.tm.wslGateway, diagnostics.network.gateway);
        row(diagnosticsView, options.tm.wslDnsServers, diagnostics.network.dnsServers.join(', ') || options.t.notAvailable);
      }
      if (diagnostics.listeningPorts.status === 'unavailable') diagnosticsView.append(element('div', 'caption', diagnostics.listeningPorts.reason));
      else if (diagnostics.listeningPorts.items.length === 0) diagnosticsView.append(element('div', 'caption', options.tm.noListeningPorts));
      else for (const listening of diagnostics.listeningPorts.items) {
        const line = element('div', 'row');
        const owner = listening.processName
          ? `${listening.processName}${listening.pid === null ? '' : ` · PID ${listening.pid}`} · ${listening.address}`
          : listening.address;
        line.append(element('span', 'value', `${listening.protocol.toUpperCase()} ${listening.port}`), element('span', 'muted', owner));
        diagnosticsView.append(line);
      }
      diagnosticsView.append(element('h4', 'card-title wsl-detail-heading', options.tm.wslMounts));
      if (diagnostics.mounts.status === 'unavailable') diagnosticsView.append(element('div', 'caption', options.tm.wslMountsUnavailable));
      else if (diagnostics.mounts.items.length === 0) diagnosticsView.append(element('div', 'caption', options.tm.wslMountsUnavailable));
      else {
        const mountRows = element('div', 'wsl-detail-grid');
        for (const mount of diagnostics.mounts.items) {
          row(mountRows, mount.target, `${mount.source} · ${mount.fileSystem}`);
        }
        diagnosticsView.append(mountRows);
      }
      diagnosticsView.append(element('h4', 'card-title wsl-detail-heading', options.tm.wslServices));
      if (diagnostics.services.status === 'unavailable') diagnosticsView.append(element('div', 'caption', diagnostics.services.reason));
      else if (diagnostics.services.items.length === 0) diagnosticsView.append(element('div', 'caption', options.tm.noWslServices));
      else {
        const details = element('details', 'wsl-service-details');
        details.append(element('summary', 'card-title wsl-detail-heading', format(options.tm.wslServicesCount, { count: diagnostics.services.items.length })));
        const serviceList = element('div', 'wsl-service-list');
        for (const service of diagnostics.services.items) {
          const line = element('div', 'wsl-service-row');
          const identity = element('span', 'value');
          identity.append(element('strong', '', service.unit));
          const state = element('span', 'wsl-service-description', `${service.activeState} · ${service.subState}${service.description ? ` · ${service.description}` : ''}`);
          line.append(identity, state);
          serviceList.append(line);
        }
        details.append(serviceList);
        diagnosticsView.append(details);
      }
      card.append(diagnosticsView);
    }
  }

  const actions = element('div', 'wsl-actions');
  const busy = options.busy || options.loading;
  if (distro.state === 'running') {
    actionButton(actions, options.tm.stopDistro, () => options.onAction({ action: 'stop', distro: distro.name }), busy);
    actionButton(actions, options.tm.restartDistro, () => options.onAction({ action: 'restart', distro: distro.name }), busy);
    actionButton(actions, options.tm.openTerminal, () => options.onAction({ action: 'open-terminal', distro: distro.name }), busy, 'ghost');
    actionButton(actions, options.tm.openFiles, () => options.onAction({ action: 'open-files', distro: distro.name }), busy, 'ghost');
    actionButton(actions, options.tm.openVscode, () => options.onAction({ action: 'open-vscode', distro: distro.name }), busy, 'ghost');
    if (distro.remoteDesktopPort !== null) actionButton(actions, options.tm.remoteDesktop, () => options.onAction({ action: 'open-rdp', distro: distro.name }), busy, 'ghost');
  } else {
    actionButton(actions, options.tm.startDistro, () => options.onAction({ action: 'start', distro: distro.name }), busy);
  }
  if (!distro.isDefault) actionButton(actions, options.tm.setDefaultDistro, () => options.onAction({ action: 'set-default', distro: distro.name }), busy, 'ghost');
  if (distro.version !== null) {
    const targetVersion: 1 | 2 = distro.version === 1 ? 2 : 1;
    actionButton(actions, `${options.tm.setVersion}: WSL ${targetVersion}`, () => confirmable(options, {
      action: 'set-version', distro: distro.name, version: targetVersion, confirmation: `SET VERSION ${distro.name} ${targetVersion}`,
    }), busy, 'ghost');
  }
  const unregister = element('span', 'wsl-action');
  mountButton(unregister, { label: options.tm.unregisterDistro, size: 'xs', variant: 'destructive', disabled: busy, onClick: () => confirmable(options, { action: 'unregister', distro: distro.name, confirmation: distro.name }) });
  actions.append(unregister);
  card.append(actions);

  const manage = element('details', 'wsl-manage');
  manage.append(element('summary', 'card-title', options.tm.manageSection));
  const fields = element('div', 'wsl-fields');
  actionButton(fields, options.tm.editConfig, () => options.onLoadConfig({ kind: 'distribution', distro: distro.name }), busy, 'ghost');
  const user = textField(fields, `user:${distro.name}`, options.tm.setDefaultUser, options.tm.usernamePlaceholder);
  actionButton(fields, options.tm.setDefaultUser, () => {
    const username = user();
    if (/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) confirmable(options, { action: 'set-default-user', distro: distro.name, username, confirmation: `USER ${username}` });
  }, busy, 'outline');
  if (distro.version === 2) {
    const moveTo = textField(fields, `move:${distro.name}`, options.tm.moveDistro, options.tm.pathPlaceholder);
    actionButton(fields, options.tm.moveDistro, () => {
      const location = moveTo();
      if (location) confirmable(options, { action: 'move', distro: distro.name, location, confirmation: distro.name });
    }, busy, 'outline');
    const size = textField(fields, `size:${distro.name}`, options.tm.resizeDisk, '80GB');
    actionButton(fields, options.tm.resizeDisk, () => {
      const nextSize = size();
      if (/^\d+(?:B|KB|MB|GB|TB)?$/i.test(nextSize)) confirmable(options, { action: 'resize', distro: distro.name, size: nextSize, confirmation: `RESIZE ${distro.name}` });
    }, busy, 'outline');
    actionButton(fields, options.tm.compactDisk, () => confirmable(options, { action: 'compact', distro: distro.name, confirmation: `COMPACT ${distro.name}` }), busy, 'ghost');
    actionButton(fields, options.tm.enableSparse, () => options.onAction({ action: 'set-sparse', distro: distro.name, enabled: true }), busy, 'ghost');
    actionButton(fields, options.tm.disableSparse, () => options.onAction({ action: 'set-sparse', distro: distro.name, enabled: false }), busy, 'ghost');
  } else {
    fields.append(element('div', 'caption', options.tm.wsl2Required));
  }
  const archiveFormatSlot = element('div');
  const archiveFormat = exportFormats.get(distro.name) ?? 'tar';
  mountSelect(archiveFormatSlot, {
    label: options.tm.archiveFormat,
    value: distro.version === 2 ? archiveFormat : 'tar',
    options: [{ id: 'tar', label: options.tm.tarFormat }, ...(distro.version === 2 ? [{ id: 'vhd', label: options.tm.vhdFormat }] : [])],
    onChange: (next) => { if (next === 'tar' || next === 'vhd') exportFormats.set(distro.name, next); },
  });
  fields.append(archiveFormatSlot);
  const archive = textField(fields, `export:${distro.name}`, options.tm.exportTo, distro.version === 2 && archiveFormat === 'vhd' ? 'D:\\Backups\\Ubuntu.vhdx' : options.tm.archivePlaceholder);
  actionButton(fields, options.tm.exportDistribution, () => {
    const file = archive();
    if (file) options.onAction({ action: 'export', distro: distro.name, file, format: exportFormats.get(distro.name) ?? 'tar' });
  }, busy, 'outline');
  const cloneName = textField(fields, `clone:name:${distro.name}`, options.tm.cloneName, `${distro.name}-copy`);
  const cloneLocation = textField(fields, `clone:location:${distro.name}`, options.tm.cloneLocation, options.tm.pathPlaceholder);
  actionButton(fields, options.tm.cloneDistro, () => {
    const newDistro = cloneName(); const location = cloneLocation();
    if (newDistro && location) confirmable(options, {
      action: 'clone', distro: distro.name, newDistro, location, version: distro.version ?? 2,
      confirmation: `CLONE ${distro.name} AS ${newDistro}`,
    });
  }, busy, 'outline');
  actionButton(fields, options.tm.renameDistro, () => {
    const newDistro = cloneName(); const location = cloneLocation();
    if (newDistro && location) confirmable(options, {
      action: 'rename', distro: distro.name, newDistro, location, version: distro.version ?? 2,
      confirmation: `RENAME ${distro.name} AS ${newDistro}`,
    });
  }, busy, 'outline');
  manage.append(fields);
  card.append(manage);
  return card;
};

export const renderWslView = (options: WslPanelOptions): HTMLElement => {
  const view = element('div', 'view section wsl-view');
  const header = element('div', 'wsl-section-head');
  header.append(element('h2', 'section-title', options.tm.distributions));
  actionButton(header, options.tm.refresh, options.onRefresh, options.loading || options.busy, 'ghost');
  view.append(header);
  if (options.statusMessage) view.append(element('div', 'wsl-status', options.statusMessage));
  if (options.pendingRestarts.length > 0) {
    const pending = element('div', 'wsl-config-warning');
    pending.setAttribute('role', 'status');
    pending.append(element('strong', 'card-title', options.tm.pendingRestartTitle));
    for (const target of options.pendingRestarts) {
      pending.append(element('div', 'caption', target.kind === 'global'
        ? options.tm.pendingRestartGlobal
        : format(options.tm.pendingRestartDistribution, { distro: target.distro })));
    }
    view.append(pending);
  }

  const snapshot = options.snapshot;
  if (options.loading && !snapshot) {
    view.append(element('div', 'empty', options.t.measuring));
    return view;
  }
  if (!snapshot?.supported) {
    view.append(element('div', 'empty', snapshot?.error ?? options.tm.wslUnavailable));
    return view;
  }

  const meta = element('div', 'wsl-summary');
  const version = [snapshot.version ? `${options.tm.wslVersion} ${snapshot.version}` : null, snapshot.kernelVersion ? `${options.tm.kernelVersion} ${snapshot.kernelVersion}` : null].filter(Boolean).join(' · ');
  meta.append(element('span', 'caption', [version, `${options.tm.defaultWslVersion}: ${snapshot.defaultVersion ?? '—'}`].filter(Boolean).join(' · ') || options.tm.unavailableState));
  meta.append(element('span', 'caption', format(options.tm.runningCount, { running: snapshot.distributions.filter(({ state }) => state === 'running').length, total: snapshot.distributions.length })));
  if (snapshot.memoryUsedBytes !== null && snapshot.memoryTotalBytes !== null) {
    meta.append(element('span', 'caption', `${options.tm.vmMemory}: ${byteText(snapshot.memoryUsedBytes, options.locale)} / ${byteText(snapshot.memoryTotalBytes, options.locale)}`));
  }
  const defaultDistro = snapshot.distributions.find(({ isDefault }) => isDefault)?.name ?? options.t.notAvailable;
  meta.append(element('span', 'caption', `${options.tm.defaultDistro}: ${defaultDistro}`));
  const nextDefaultVersion: 1 | 2 = snapshot.defaultVersion === 1 ? 2 : snapshot.defaultVersion === 2 ? 1 : 2;
  actionButton(meta, format(options.tm.setDefaultWslVersion, { version: nextDefaultVersion }), () => confirmable(options, { action: 'set-default-version', version: nextDefaultVersion, confirmation: `DEFAULT WSL ${nextDefaultVersion}` }), options.busy, 'ghost');
  actionButton(meta, options.tm.updateWsl, () => confirmable(options, { action: 'update-wsl', confirmation: 'UPDATE WSL' }), options.busy, 'ghost');
  actionButton(meta, options.tm.shutdownAll, () => confirmable(options, { action: 'shutdown', confirmation: '' }), options.busy, 'secondary');
  actionButton(meta, options.tm.forceShutdown, () => confirmable(options, { action: 'force-shutdown', confirmation: '' }), options.busy, 'destructive');
  view.append(meta);

  const globalConfig = element('article', 'card wsl-operations');
  globalConfig.append(element('h3', 'card-title', options.tm.globalConfig));
  const configDescription = element('div', 'caption', options.tm.configNotice);
  globalConfig.append(configDescription);
  actionButton(globalConfig, options.tm.editConfig, () => options.onLoadConfig({ kind: 'global' }), options.busy || options.configLoading, 'outline');
  view.append(globalConfig);

  if (options.config) {
    const configCard = element('article', 'card wsl-config-card');
    const configTarget = options.config.target;
    const configKey = configTarget.kind === 'global' ? 'config:global' : `config:distro:${configTarget.distro}`;
    configCard.append(element('h3', 'card-title', configTarget.kind === 'global'
      ? options.tm.globalConfig : format(options.tm.distributionConfig, { distro: configTarget.distro })));
    configCard.append(element('div', 'caption', options.tm.configNotice));
    const insightHeading = element('h4', 'card-title wsl-detail-heading', options.tm.configSummary);
    const insightSummary = element('div', 'wsl-detail-grid');
    const bootWarning = element('div', 'wsl-config-warning', options.tm.configBootCommandWarning);
    const networkWarning = element('div', 'wsl-config-warning', options.tm.configNetworkingDisabledWarning);
    const renderInsights = (text: string): void => {
      const configInsights = inspectWslConfig(text);
      insightSummary.replaceChildren();
      for (const setting of configInsights.insights) row(insightSummary, `[${setting.section}] ${setting.key}`, setting.value);
      insightHeading.hidden = configInsights.insights.length === 0;
      insightSummary.hidden = configInsights.insights.length === 0;
      bootWarning.hidden = !configInsights.hasBootCommand;
      networkWarning.hidden = !configInsights.networkingDisabled;
    };
    renderInsights(fieldDrafts.get(configKey) ?? options.config.text);
    configCard.append(insightHeading, insightSummary, bootWarning, networkWarning);
    const advanced = element('details', 'wsl-config-advanced');
    advanced.append(element('summary', 'card-title', options.tm.configAdvanced));
    const value = textArea(advanced, configKey, configTarget.kind === 'global' ? '.wslconfig' : '/etc/wsl.conf', options.config.text, renderInsights);
    const guided = element('details', 'wsl-config-guided');
    guided.append(element('summary', 'card-title', options.tm.configGuided));
    const known = new Map(inspectWslConfig(options.config.text).insights.map(({ section, key, value: setting }) => [`${section}.${key}`, setting]));
    const settings = configTarget.kind === 'global'
      ? [
        { section: 'wsl2', key: 'memory', label: options.tm.configVmMemory, kind: 'text' as const },
        { section: 'wsl2', key: 'processors', label: options.tm.configVmProcessors, kind: 'text' as const },
        { section: 'wsl2', key: 'swap', label: options.tm.configVmSwap, kind: 'text' as const },
        { section: 'wsl2', key: 'defaultVhdSize', label: options.tm.configDefaultVhdSize, kind: 'text' as const },
        { section: 'wsl2', key: 'networkingMode', label: options.tm.configNetworkingMode, kind: 'select' as const, choices: ['', 'nat', 'mirrored', 'none', 'consomme'] },
        { section: 'wsl2', key: 'dnsProxy', label: options.tm.configDnsProxy, kind: 'boolean' as const },
        { section: 'wsl2', key: 'hostAddressLoopback', label: options.tm.configHostAddressLoopback, kind: 'boolean' as const },
        { section: 'wsl2', key: 'ignoredPorts', label: options.tm.configIgnoredPorts, kind: 'text' as const },
        { section: 'wsl2', key: 'dnsTunneling', label: options.tm.configDnsTunneling, kind: 'boolean' as const },
        { section: 'wsl2', key: 'firewall', label: options.tm.configFirewall, kind: 'boolean' as const },
        { section: 'wsl2', key: 'autoProxy', label: options.tm.configAutoProxy, kind: 'boolean' as const },
        { section: 'wsl2', key: 'guiApplications', label: options.tm.configGuiApplications, kind: 'boolean' as const },
        { section: 'wsl2', key: 'gpuSupport', label: options.tm.configGpuSupport, kind: 'boolean' as const },
        { section: 'wsl2', key: 'localhostForwarding', label: options.tm.configLocalhostForwarding, kind: 'boolean' as const },
        { section: 'wsl2', key: 'nestedVirtualization', label: options.tm.configNestedVirtualization, kind: 'boolean' as const },
        { section: 'wsl2', key: 'debugConsole', label: options.tm.configDebugConsole, kind: 'boolean' as const },
        { section: 'wsl2', key: 'vmIdleTimeout', label: options.tm.configVmIdleTimeout, kind: 'text' as const },
        { section: 'experimental', key: 'sparseVhd', label: options.tm.configSparseVhd, kind: 'boolean' as const },
        { section: 'experimental', key: 'bestEffortDnsParsing', label: options.tm.configBestEffortDnsParsing, kind: 'boolean' as const },
        { section: 'experimental', key: 'autoMemoryReclaim', label: options.tm.configAutoMemoryReclaim, kind: 'select' as const, choices: ['', 'disabled', 'gradual', 'dropCache'] },
        { section: 'general', key: 'instanceIdleTimeout', label: options.tm.configInstanceIdleTimeout, kind: 'text' as const },
      ]
      : [
        { section: 'boot', key: 'systemd', label: options.tm.configSystemd, kind: 'boolean' as const },
        { section: 'boot', key: 'protectBinfmt', label: options.tm.configProtectBinfmt, kind: 'boolean' as const },
        { section: 'boot', key: 'initTimeout', label: options.tm.configInitTimeout, kind: 'text' as const },
        { section: 'automount', key: 'enabled', label: options.tm.configAutoMount, kind: 'boolean' as const },
        { section: 'automount', key: 'mountFstab', label: options.tm.configMountFstab, kind: 'boolean' as const },
        { section: 'interop', key: 'enabled', label: options.tm.configInterop, kind: 'boolean' as const },
        { section: 'interop', key: 'appendWindowsPath', label: options.tm.configWindowsPath, kind: 'boolean' as const },
        { section: 'network', key: 'generateHosts', label: options.tm.configGenerateHosts, kind: 'boolean' as const },
        { section: 'network', key: 'generateResolvConf', label: options.tm.configGenerateResolvConf, kind: 'boolean' as const },
        { section: 'gpu', key: 'enabled', label: options.tm.configGpuEnabled, kind: 'boolean' as const },
        { section: 'gpu', key: 'appendLibPath', label: options.tm.configAppendGpuLibPath, kind: 'boolean' as const },
        { section: 'time', key: 'useWindowsTimezone', label: options.tm.configUseWindowsTimezone, kind: 'boolean' as const },
      ];
    const guidedBody = element('div', 'wsl-fields');
    for (const setting of settings) {
      const path = `${setting.section}.${setting.key.toLocaleLowerCase()}`;
      const draftKey = `${configKey}:${path}`;
      const current = configSettingDrafts.get(draftKey) ?? known.get(path) ?? '';
      const slot = element('div');
      const choices = setting.kind === 'boolean' ? ['', 'true', 'false'] : setting.kind === 'select' ? setting.choices : null;
      if (choices) {
        const selected = current === '' ? '__unchanged__' : current.toLocaleLowerCase();
        mountSelect(slot, {
          label: setting.label,
          value: selected,
          options: choices.map((choice) => ({ id: choice === '' ? '__unchanged__' : choice, label: choice === '' ? options.tm.configNoChange : choice })),
          onChange: (next) => { configSettingDrafts.set(draftKey, next === '__unchanged__' ? '' : next); },
        });
      } else {
        mountTextField(slot, { label: setting.label, value: current, placeholder: options.tm.configNoChange, mono: true, onChange: (next) => { configSettingDrafts.set(draftKey, next.trim()); } });
      }
      guidedBody.append(slot);
    }
    guided.append(guidedBody);
    configCard.append(guided);
    configCard.append(advanced);
    actionButton(configCard, options.tm.saveConfig, () => {
      const expected = configTarget.kind === 'global' ? 'SAVE GLOBAL WSL CONFIG' : `SAVE WSL CONFIG ${configTarget.distro}`;
      exactConfirm({
        title: options.tm.saveConfig,
        body: options.tm.configNotice,
        expected,
        tm: options.tm,
        action: (confirmation) => {
          let text = value();
          for (const setting of settings) {
            const path = `${setting.section}.${setting.key.toLocaleLowerCase()}`;
            const draft = configSettingDrafts.get(`${configKey}:${path}`);
            if (draft === undefined || draft === '') continue;
            text = withWslConfigSetting(text, setting.section, setting.key, draft);
          }
          return { target: configTarget, text, confirmation };
        },
        onAction: ({ target, text }) => options.onSaveConfig(target, text),
      });
    }, options.busy || options.configLoading, 'default');
    view.append(configCard);
  }

  const catalog = element('article', 'card wsl-operations');
  catalog.append(element('h3', 'card-title', options.tm.installDistribution));
  const catalogRow = element('div', 'wsl-fields');
  const catalogSelect = element('div');
  const catalogItems = options.catalog?.items ?? [];
  if (selectedWslDistro && !catalogItems.some(({ name }) => name === selectedWslDistro)) selectedWslDistro = null;
  mountSelect(catalogSelect, {
    label: options.tm.selectDistribution,
    value: selectedWslDistro,
    placeholder: options.tm.selectDistribution,
    searchable: true,
    options: catalogItems.map((item) => ({ id: item.name, label: item.friendlyName, hint: item.name })),
    onChange: (id) => { selectedWslDistro = id; },
  });
  catalogRow.append(catalogSelect);
  actionButton(catalogRow, options.tm.loadCatalog, options.onLoadCatalog, options.catalogLoading || options.busy, 'ghost');
  actionButton(catalogRow, options.tm.installDistribution, () => {
    if (selectedWslDistro) options.onAction({ action: 'install', distro: selectedWslDistro });
  }, options.busy || !selectedWslDistro, 'default');
  catalog.append(catalogRow);
  if (options.catalog?.error) catalog.append(element('div', 'caption', options.catalog.error));
  if (options.catalog && options.catalog.items.length === 0) catalog.append(element('div', 'caption', options.tm.noCatalogItems));
  view.append(catalog);

  const packageCard = element('article', 'card wsl-operations');
  packageCard.append(element('h3', 'card-title', options.tm.installFromFile));
  packageCard.append(element('div', 'caption', options.tm.installFromFileHelp));
  const packageFields = element('div', 'wsl-fields');
  const packageName = textField(packageFields, 'install-file:name', options.tm.distroName, 'MyLinux');
  const packageLocation = textField(packageFields, 'install-file:location', options.tm.installLocation, options.tm.pathPlaceholder);
  const packageFile = textField(packageFields, 'install-file:file', options.tm.wslPackageFile, 'D:\\Downloads\\Distribution.wsl');
  const packageVersionSlot = element('div');
  const packageVersionOptions = [{ id: '1', label: 'WSL 1' }, { id: '2', label: 'WSL 2' }];
  const packageVersion = mountSelect(packageVersionSlot, {
    label: options.tm.versionLabel,
    value: String(selectedPackageInstallVersion),
    options: packageVersionOptions,
    onChange: (id) => {
      selectedPackageInstallVersion = id === '1' ? 1 : 2;
      packageVersion.update({ value: String(selectedPackageInstallVersion) });
    },
  });
  packageFields.append(packageVersionSlot);
  actionButton(packageFields, options.tm.installFromFile, () => {
    const distro = packageName(); const location = packageLocation(); const file = packageFile();
    if (distro && location && file) confirmable(options, {
      action: 'install-from-file', distro, location, file, version: selectedPackageInstallVersion,
      confirmation: `INSTALL ${distro} FROM FILE`,
    });
  }, options.busy, 'outline');
  packageCard.append(packageFields);
  view.append(packageCard);

  const importCard = element('article', 'card wsl-operations');
  importCard.append(element('h3', 'card-title', options.tm.importDistribution));
  const importFields = element('div', 'wsl-fields');
  const importName = textField(importFields, 'import:name', options.tm.distroName, 'UbuntuBackup');
  const importLocation = textField(importFields, 'import:location', options.tm.installLocation, options.tm.pathPlaceholder);
  const importFile = textField(importFields, 'import:file', options.tm.importArchive, options.tm.archivePlaceholder);
  const importFormatSlot = element('div');
  const versionSlot = element('div');
  const versionOptions = [{ id: '1', label: 'WSL 1' }, { id: '2', label: 'WSL 2' }];
  const versionControl = mountSelect(versionSlot, {
    label: options.tm.versionLabel,
    value: String(selectedImportFormat === 'vhd' ? 2 : selectedImportVersion),
    options: versionOptions,
    onChange: (id) => { selectedImportVersion = selectedImportFormat === 'vhd' ? 2 : id === '1' ? 1 : 2; },
  });
  const vhdNotice = element('div', 'caption', options.tm.vhdRequiresWsl2);
  vhdNotice.hidden = selectedImportFormat !== 'vhd';
  mountSelect(importFormatSlot, {
    label: options.tm.archiveFormat,
    value: selectedImportFormat,
    options: [{ id: 'tar', label: options.tm.tarFormat }, { id: 'vhd', label: options.tm.vhdFormat }],
    onChange: (next) => {
      if (next === 'tar' || next === 'vhd') selectedImportFormat = next;
      if (selectedImportFormat === 'vhd') selectedImportVersion = 2;
      versionControl.update({
        label: options.tm.versionLabel,
        value: String(selectedImportVersion),
        options: versionOptions,
        onChange: (id) => { selectedImportVersion = selectedImportFormat === 'vhd' ? 2 : id === '1' ? 1 : 2; },
      });
      vhdNotice.hidden = selectedImportFormat !== 'vhd';
    },
  });
  importFields.append(importFormatSlot);
  importFields.append(versionSlot);
  importFields.append(vhdNotice);
  actionButton(importFields, options.tm.importDistribution, () => {
    const distro = importName(); const location = importLocation(); const file = importFile();
    if (distro && location && file) options.onAction({ action: 'import', distro, location, file, version: selectedImportFormat === 'vhd' ? 2 : selectedImportVersion, format: selectedImportFormat });
  }, options.busy, 'outline');
  importCard.append(importFields);
  view.append(importCard);

  const inPlaceCard = element('article', 'card wsl-operations');
  inPlaceCard.append(element('h3', 'card-title', options.tm.importVhdInPlace));
  inPlaceCard.append(element('div', 'caption', options.tm.importVhdInPlaceHelp));
  const inPlaceFields = element('div', 'wsl-fields');
  const inPlaceName = textField(inPlaceFields, 'import-in-place:name', options.tm.distroName, 'UbuntuVhd');
  const inPlaceFile = textField(inPlaceFields, 'import-in-place:file', options.tm.importArchive, 'D:\\Backups\\Ubuntu.vhdx');
  actionButton(inPlaceFields, options.tm.importVhdInPlace, () => {
    const distro = inPlaceName(); const file = inPlaceFile();
    if (distro && file) options.onAction({ action: 'import-in-place', distro, file });
  }, options.busy, 'outline');
  inPlaceCard.append(inPlaceFields);
  view.append(inPlaceCard);

  if (snapshot.error) view.append(element('div', 'caption', snapshot.error));
  if (snapshot.distributions.length === 0) {
    view.append(element('div', 'empty', options.tm.noDistributions));
  }
  const cards = element('div', 'wsl-list');
  const orderedDistributions = [...snapshot.distributions].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)
    || Number(b.state === 'running') - Number(a.state === 'running')
    || a.name.localeCompare(b.name, options.locale));
  for (const distro of orderedDistributions) cards.append(distroCard(options, distro));
  if (snapshot.distributions.length > 0) {
    const filters = element('div', 'wsl-filters');
    const searchSlot = element('div');
    mountTextField(searchSlot, {
      label: options.tm.searchDistributions, value: distroSearch, onChange: (value) => { distroSearch = value; applyFilters(); },
    });
    const stateSlot = element('div');
    mountSelect(stateSlot, {
      label: options.tm.stateFilter, value: distroStateFilter,
      options: [
        { id: 'all', label: options.tm.allDistributions },
        { id: 'running', label: options.tm.runningFilter },
        { id: 'stopped', label: options.tm.stoppedFilter },
      ],
      onChange: (value) => { distroStateFilter = value; applyFilters(); },
    });
    const versionSlotFilter = element('div');
    mountSelect(versionSlotFilter, {
      label: options.tm.versionFilter, value: distroVersionFilter,
      options: [
        { id: 'all', label: options.tm.allDistributions },
        { id: '1', label: 'WSL 1' }, { id: '2', label: 'WSL 2' },
      ],
      onChange: (value) => { distroVersionFilter = value; applyFilters(); },
    });
    const sourceSlotFilter = element('div');
    mountSelect(sourceSlotFilter, {
      label: options.tm.sourceFilter, value: distroSourceFilter,
      options: [
        { id: 'all', label: options.tm.allDistributions },
        { id: 'store', label: options.tm.storeSource },
        { id: 'imported', label: options.tm.importedSource },
        { id: 'unknown', label: options.tm.unknownSource },
      ],
      onChange: (value) => { distroSourceFilter = value; applyFilters(); },
    });
    filters.append(searchSlot, stateSlot, versionSlotFilter, sourceSlotFilter);
    const filteredEmpty = element('div', 'empty', options.tm.noFilteredDistributions);
    filteredEmpty.hidden = true;
    filteredEmpty.setAttribute('role', 'status');
    const applyFilters = (): void => {
      const query = distroSearch.trim().toLocaleLowerCase();
      let visible = 0;
      for (const card of cards.children) {
        if (!(card instanceof HTMLElement)) continue;
        const matches = (!query || (card.dataset.search ?? '').includes(query))
          && (distroStateFilter === 'all' || card.dataset.state === distroStateFilter)
          && (distroVersionFilter === 'all' || card.dataset.version === distroVersionFilter)
          && (distroSourceFilter === 'all' || card.dataset.source === distroSourceFilter);
        card.hidden = !matches;
        if (matches) visible += 1;
      }
      filteredEmpty.hidden = visible > 0;
    };
    applyFilters();
    view.append(filters, filteredEmpty, cards);
  }
  return view;
};

export const showWslConfirmation = (options: WslPanelOptions, action: ConfirmableAction): void => confirmable(options, action);
