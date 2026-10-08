import {
  mountBadge, mountBanner, mountButton, mountProgress, mountSearchField, mountSelect, mountSpinner, mountSwitch, mountTabs,
  type BadgeHandle, type ButtonHandle, type ProgressHandle, type TabsHandle, type Tone,
} from '@openchamber/sdk/ui';
import type { JsonValue } from '@openchamber/sdk';
import type { GuestProject, GuestSessionRecord, GuestSessionsSnapshot } from '@openchamber/sdk';

import { format, type Messages } from '../i18n/messages.ts';
import { monitorMessagesFor, type MonitorMessages } from '../i18n/monitor.ts';
import { blockedText } from '../frame/blocked.ts';
import { describeUnavailable, diskName, formatBytes, formatCores, formatNumber, formatPercent } from '../frame/format.ts';
import { startFrame, type FrameContext } from '../frame/host.ts';
import { sparkline, sparklineFromValues, SPARKLINE_CSS } from '../frame/sparkline.ts';
import { BASE_CSS, element, installStyle, toneFor } from '../frame/ui.ts';
import { renderWslView } from './wsl-view.ts';
import { flattenProcessTree, type ProcessTreeRow } from '../shared/process-tree.ts';
import { filterSessions, sessionState, type SessionFilter, type SessionState } from '../shared/openchamber-activity.ts';
import type { WslAction, WslCatalog, WslConfigDocument, WslConfigTarget, WslDiagnostics, WslJob, WslSnapshot } from '../shared/wsl.ts';
import {
  busiestGpu, DEFAULT_MONITOR_SETTINGS, diskPercent, fullestDisk, normalizeMonitorSettings,
  type MonitorSettings, type ProcessEntry, type Stats, type Warning,
} from '../shared/stats.ts';

const SETTINGS_KEY = 'system-monitor.settings.v2';
const TABS = ['overview', 'processes', 'performance', 'storage', 'hardware', 'health', 'optimization', 'openchamber', 'wsl', 'settings'] as const;
type TabId = typeof TABS[number];
type ProcessFilter = 'all' | 'cpu' | 'memory';
type ProcessSort = 'cpu' | 'memory' | 'name' | 'pid';
type SortDirection = 'ascending' | 'descending';

installStyle(`${BASE_CSS}${SPARKLINE_CSS}
html,body{height:100%;min-height:100%;background:var(--oc-bg);overflow:auto}
#root{min-height:100%;container-type:inline-size}
.shell{display:flex;min-height:100%;flex-direction:column;gap:0;color:var(--oc-fg)}
.header{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--oc-bg);border-bottom:1px solid var(--oc-border)}
.heading{min-width:0;flex:1;display:flex;align-items:center;gap:8px}.title{font-size:13px;font-weight:650;white-space:nowrap}.updated{color:var(--oc-muted);font-size:10px;white-space:nowrap}
.header-actions{display:flex;gap:4px;align-items:center}.header-actions [data-oc-button]{white-space:nowrap}
.nav-wrap{position:sticky;top:46px;z-index:4;background:var(--oc-bg);padding:6px 10px 2px;border-bottom:1px solid var(--oc-border);overflow-x:auto;scrollbar-width:none}.nav-wrap::-webkit-scrollbar{display:none;height:0}
.tabs-slot{min-width:max-content}.content{padding:12px;display:flex;flex-direction:column;gap:12px;min-width:0}
.page .content{width:100%;max-width:1440px;margin:0 auto;padding:20px clamp(16px,3vw,40px) 36px;gap:18px}
.page .header{padding:14px clamp(16px,3vw,40px)}.page .nav-wrap{padding:8px clamp(12px,2vw,28px) 4px}
.section{display:flex;flex-direction:column;gap:9px;min-width:0}.section-title{font-size:12px;font-weight:650;display:flex;gap:8px;align-items:center;margin:0}
.muted{color:var(--oc-muted)}.small{font-size:11px}.caption{color:var(--oc-muted);font-size:11px;line-height:1.45}.row{display:flex;justify-content:space-between;gap:12px;align-items:baseline;min-width:0}.row>*{min-width:0}.row .value{text-align:right;color:var(--oc-fg);overflow-wrap:anywhere}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,155px),1fr));gap:8px;min-width:0}.metric-card,.card{min-width:0;border:1px solid var(--oc-border);border-radius:var(--oc-radius,8px);padding:10px;background:var(--oc-bg-elevated,var(--oc-bg))}
.metric-label{font-size:11px;color:var(--oc-muted)}.metric-value{font-size:19px;font-weight:650;letter-spacing:-.02em;margin:2px 0 4px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.metric-detail{color:var(--oc-muted);font-size:10px;min-height:14px;overflow-wrap:anywhere}.metric-card .meter{margin-top:8px}
.card{display:flex;flex-direction:column;gap:8px}.card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.card-title{font-weight:650;font-size:12px}.meter{gap:4px}.meter .oc-sdk-progress{transition:opacity 160ms ease}.meter-value.warn,.warn{color:var(--oc-warning-text)}.meter-value.critical,.critical{color:var(--oc-error-text)}
.chart-card{min-width:0}.chart{height:70px}.chart .spark{height:52px}.chart .caption{display:flex;justify-content:space-between}.core-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(40px,1fr));gap:5px}.core-cell{display:flex;flex-direction:column;gap:3px;min-width:0}.core-fill{height:5px;border-radius:4px;background:var(--oc-primary);transition:width 180ms ease}.core-track{height:5px;border-radius:4px;background:var(--oc-subtle)}
.warning-list{display:flex;flex-direction:column;gap:5px}.warning-row{border-left:2px solid var(--oc-warning);padding:4px 8px;background:color-mix(in srgb,var(--oc-warning) 7%,transparent);border-radius:0 5px 5px 0}.warning-row[data-level=critical]{border-color:var(--oc-error);background:color-mix(in srgb,var(--oc-error) 7%,transparent)}.warning-row>summary{display:flex;justify-content:space-between;align-items:baseline;gap:8px;cursor:pointer;list-style-position:inside}.warning-row>summary strong{font-size:11px}.warning-row .severity{font-size:10px;color:var(--oc-warning-text);white-space:nowrap}.warning-row[data-level=critical] .severity{color:var(--oc-error-text)}
.info-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:8px}.info-block{display:flex;flex-direction:column;gap:7px}.process-table{display:flex;flex-direction:column;gap:5px}.process-row{display:grid;grid-template-columns:minmax(90px,1fr) auto 56px 64px;gap:8px;align-items:center;font-size:11px}.process-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.process-row+.process-row{border-top:1px solid var(--oc-border);padding-top:5px}.empty{padding:12px;color:var(--oc-muted);border:1px dashed var(--oc-border);border-radius:var(--oc-radius,8px)}
.process-controls{display:grid;grid-template-columns:minmax(180px,2fr) minmax(150px,1fr) auto;gap:8px;align-items:center}.processes-grid{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}.processes-grid th,.processes-grid td{padding:8px 10px;border-bottom:1px solid var(--oc-border);text-align:left}.processes-grid th{color:var(--oc-muted);font-weight:550}.processes-grid td.value{text-align:right;font-variant-numeric:tabular-nums}.processes-grid th:nth-child(2),.processes-grid td:nth-child(2){width:90px}.processes-grid th:nth-child(3),.processes-grid td:nth-child(3),.processes-grid th:nth-child(4),.processes-grid td:nth-child(4){width:120px}.process-sort{border:0;background:transparent;color:inherit;font:inherit;padding:2px 0;cursor:pointer}.process-sort:focus-visible{outline:2px solid var(--oc-primary);outline-offset:2px;border-radius:3px}.process-meta{display:block;color:var(--oc-muted);font-size:10px;margin-top:2px;overflow-wrap:anywhere}.process-name-cell{overflow:hidden}.process-name-control{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:0;border:0;background:transparent;color:var(--oc-fg);font:inherit;text-align:left;cursor:pointer}.process-name-control[aria-current=true]{color:var(--oc-primary-text);font-weight:600}.process-name-control:focus-visible,.process-tree-toggle:focus-visible{outline:2px solid var(--oc-primary);outline-offset:2px;border-radius:3px}.process-tree-toggle{flex:0 0 18px;width:18px;height:18px;padding:0;border:1px solid var(--oc-border);border-radius:4px;background:var(--oc-bg);color:var(--oc-muted);font:inherit;cursor:pointer}.process-tree-spacer{flex:0 0 18px}.process-detail{margin-top:8px}.process-detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:6px 14px}
.recommendation{padding:9px 10px;border:1px solid var(--oc-border);border-radius:var(--oc-radius,8px);display:flex;flex-direction:column;gap:6px}.recommendation strong{font-size:12px}.settings-group{display:flex;flex-direction:column;gap:9px}.select-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,225px),1fr));gap:10px}.select-field{display:flex;flex-direction:column;gap:5px;min-width:0}.switch-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:8px}.settings-note{border-left:2px solid var(--oc-info);padding:7px 9px;color:var(--oc-muted);font-size:11px;background:color-mix(in srgb,var(--oc-info) 5%,transparent)}
.loading{min-height:140px;display:grid;place-items:center}.header [data-tone=success]{color:var(--oc-success-text)}
.workspace-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:8px}.workspace-session-list{display:flex;flex-direction:column;gap:7px}.workspace-session{gap:6px}.workspace-session-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.workspace-session-title{min-width:0;overflow-wrap:anywhere}.workspace-session-state{flex:0 0 auto;padding:2px 7px;border-radius:999px;color:var(--oc-muted);background:var(--oc-subtle);font-size:10px}.workspace-session-state[data-state=running],.workspace-session-state[data-state=retrying]{color:var(--oc-primary-text)}.workspace-session-state[data-state=waiting-permission],.workspace-session-state[data-state=waiting-question]{color:var(--oc-warning-text)}.workspace-session-state[data-state=failed]{color:var(--oc-error-text)}.workspace-session-action{display:flex;justify-content:flex-end}
.wsl-view{gap:10px}.wsl-section-head,.wsl-summary,.wsl-distro-header,.wsl-actions,.wsl-confirm-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.wsl-section-head{justify-content:space-between}.wsl-summary{justify-content:space-between;padding:8px 10px;border:1px solid var(--oc-border);border-radius:var(--oc-radius,8px)}.wsl-list{display:flex;flex-direction:column;gap:8px}.wsl-distro{gap:8px}.wsl-distro-header .card-title{min-width:0;overflow-wrap:anywhere}.wsl-default-label{font-size:10px;color:var(--oc-primary-text)}.wsl-detail-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:5px 10px}.wsl-detail-heading{grid-column:1/-1;margin:4px 0 0}.wsl-actions{padding-top:3px;border-top:1px solid var(--oc-border)}.wsl-action{display:inline-flex}.wsl-status{border-left:2px solid var(--oc-info);padding:7px 9px;color:var(--oc-info-text);background:color-mix(in srgb,var(--oc-info) 6%,transparent);font-size:11px}.wsl-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));align-items:end;gap:8px}.wsl-fields>.wsl-action{align-self:end}.wsl-filters,.wsl-process-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:8px;align-items:end}.wsl-process-list{display:flex;flex-direction:column;gap:4px;max-height:360px;overflow:auto}.wsl-process-row{display:grid;grid-template-columns:minmax(110px,1fr) 90px minmax(90px,.7fr) minmax(110px,.8fr);align-items:center;gap:8px;padding:5px 6px;border-bottom:1px solid var(--oc-border);font-size:11px}.wsl-process-row>*{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wsl-process-row .value:last-child,.wsl-process-row .value:nth-last-child(2){text-align:right;font-variant-numeric:tabular-nums}.wsl-config-card{gap:10px}.wsl-config-field{min-width:0}.wsl-config-field textarea.oc-sdk-input{min-height:280px;resize:vertical;tab-size:2}.wsl-config-warning{border-left:2px solid var(--oc-warning);padding:7px 9px;color:var(--oc-warning-text);background:color-mix(in srgb,var(--oc-warning) 7%,transparent);font-size:11px}.wsl-confirm{color:var(--oc-fg);background:var(--oc-bg);border:1px solid var(--oc-border);border-radius:var(--oc-radius,8px);padding:16px;max-width:min(480px,calc(100vw - 32px));box-shadow:0 18px 50px #0005}.wsl-confirm::backdrop{background:#0008}.wsl-confirm-form{display:flex;flex-direction:column;gap:10px}.wsl-confirm-actions{justify-content:flex-end}
.skeleton{height:68px;border-radius:var(--oc-radius,8px);background:var(--oc-subtle);opacity:.7}.refreshing{animation:refresh-pulse 180ms ease-out}@keyframes refresh-pulse{50%{opacity:.7}}
@container (min-width:720px){.page .grid{grid-template-columns:repeat(4,minmax(0,1fr))}.page .wide-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:520px){.updated{display:none}.header{gap:5px;padding:8px}.header-actions{gap:2px}.content{padding:9px}.process-row{grid-template-columns:minmax(72px,1fr) auto 48px 54px;font-size:10px}.process-controls{grid-template-columns:1fr}.processes-grid{font-size:11px}.processes-grid th,.processes-grid td{padding:7px 5px}.processes-grid th:nth-child(2),.processes-grid td:nth-child(2){width:54px}.processes-grid th:nth-child(3),.processes-grid td:nth-child(3),.processes-grid th:nth-child(4),.processes-grid td:nth-child(4){width:76px}.metric-value{font-size:17px}.wsl-filters,.wsl-process-controls{grid-template-columns:1fr}.wsl-process-row{grid-template-columns:minmax(80px,1fr) 62px minmax(68px,.7fr) minmax(84px,.8fr);gap:5px;font-size:10px}.wsl-filters>div:first-child{grid-column:1/-1}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
`);

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing root');

let settings = structuredClone(DEFAULT_MONITOR_SETTINGS);
let current: FrameContext | null = null;
let lastStats: Stats | null = null;
let activeTab: TabId = 'overview';
let cpuView: 'overall' | 'per-core' = 'overall';
let storageView: 'capacity' | 'activity' = 'capacity';
let processQuery = '';
let processFilter: ProcessFilter = 'all';
let processSort: ProcessSort = 'cpu';
let processSortDirection: SortDirection = 'descending';
let processTreeMode = false;
let selectedProcessPid: number | null = null;
const collapsedProcessPids = new Set<number>();
let lastLocale = '';
let lastSurface = '';
let loadingSettings = false;
let settingsLoaded = false;
let wslSnapshot: WslSnapshot | null = null;
let wslCatalog: WslCatalog | null = null;
let wslLoading = false;
let wslCatalogLoading = false;
let wslBusy = false;
let wslJobId: string | null = null;
let wslJobPollActive = false;
let wslStatusMessage: string | null = null;
let wslConfig: WslConfigDocument | null = null;
let wslConfigLoading = false;
const wslDiagnostics: Record<string, WslDiagnostics | undefined> = {};
let wslDiagnosticsLoading: string | null = null;
let wslRefreshTimer: ReturnType<typeof setInterval> | null = null;
let workspaceProjects: GuestProject[] = [];
let workspaceSessions: GuestSessionRecord[] = [];
let workspaceProjectId: string | null = null;
let workspaceState: 'loading' | 'ready' | 'error' = 'loading';
let workspaceCoveragePartial = false;
let workspaceError: 'permission' | 'unavailable' | null = null;
let workspaceFilter: SessionFilter = 'all';
let workspaceQuery = '';
let workspaceProjectUnsubscribe: (() => void) | null = null;
let workspaceSessionUnsubscribe: (() => void) | null = null;
let workspaceRequestId = 0;

const shell = element('div', 'shell');
const header = element('header', 'header');
const heading = element('div', 'heading');
const title = element('span', 'title', 'System Monitor');
const badgeSlot = element('span');
const badge: BadgeHandle = mountBadge(badgeSlot, { label: '…', tone: 'neutral' });
const updated = element('span', 'updated');
heading.append(title, badgeSlot, updated);
const actions = element('div', 'header-actions');
const refreshAction = () => {
  refreshButtonSlot.classList.remove('refreshing');
  void refreshButtonSlot.offsetWidth;
  refreshButtonSlot.classList.add('refreshing');
  current?.retry();
};
const refreshButton: ButtonHandle = mountButton(actions, { label: 'Refresh', size: 'xs', variant: 'ghost', onClick: () => {
  refreshAction();
} });
const refreshButtonSlot = actions.lastElementChild as HTMLElement;
const pauseButton: ButtonHandle = mountButton(actions, { label: 'Pause', size: 'xs', variant: 'secondary', onClick: () => {
  void saveSettings({ ...settings, paused: !settings.paused });
} });
const dashboardButton: ButtonHandle = mountButton(actions, { label: 'Dashboard', size: 'xs', variant: 'outline', onClick: () => {
  void current?.host.toast({ kind: 'info', message: current.tm.dashboardMenuHint }).catch(() => undefined);
} });
header.append(heading, actions);

const navWrap = element('nav', 'nav-wrap');
navWrap.setAttribute('aria-label', 'System Monitor sections');
const tabsSlot = element('div', 'tabs-slot');
navWrap.append(tabsSlot);
const content = element('main', 'content');
shell.append(header, navWrap, content);
root.replaceChildren(shell);

const tabLabels = (tm: MonitorMessages) => [
  { id: 'overview', label: tm.overview }, { id: 'processes', label: tm.processes }, { id: 'performance', label: tm.performance },
  { id: 'storage', label: tm.storage }, { id: 'hardware', label: tm.hardware },
  { id: 'health', label: tm.health }, { id: 'optimization', label: tm.optimization }, { id: 'openchamber', label: tm.openchamber }, { id: 'wsl', label: tm.wsl }, { id: 'settings', label: tm.settings },
];
const tabs: TabsHandle = mountTabs(tabsSlot, {
  items: tabLabels(monitorMessagesFor('en')), activeId: activeTab, trackBackground: true,
  onChange: (id) => changeTab(id),
});

const isPermissionError = (error: unknown): boolean => error instanceof Error && /NOT_GRANTED|capabilit|permission/i.test(error.message);

const subscribeWorkspaceProjects = async (): Promise<void> => {
  if (!current || workspaceProjectUnsubscribe) return;
  workspaceState = 'loading';
  const host = current.host;
  try {
    const unsubscribe = await host.onProjects((snapshot) => {
      workspaceProjects = snapshot.projects;
      if (snapshot.state === 'error') {
        workspaceState = 'error';
        workspaceError = 'unavailable';
        renderActive();
        return;
      }
      workspaceState = snapshot.state;
      workspaceError = null;
      if (!workspaceProjects.some((project) => project.id === workspaceProjectId)) {
        workspaceProjectId = workspaceProjects[0]?.id ?? null;
        void subscribeWorkspaceSessions(workspaceProjectId);
      }
      renderActive();
    });
    workspaceProjectUnsubscribe = unsubscribe;
  } catch (error) {
    workspaceState = 'error';
    workspaceError = isPermissionError(error) ? 'permission' : 'unavailable';
    renderActive();
  }
};

const subscribeWorkspaceSessions = async (projectId: string | null): Promise<void> => {
  workspaceSessionUnsubscribe?.();
  workspaceSessionUnsubscribe = null;
  workspaceProjectId = projectId;
  workspaceSessions = [];
  workspaceCoveragePartial = false;
  if (!projectId || !current) { renderActive(); return; }
  const requestId = ++workspaceRequestId;
  workspaceState = 'loading';
  workspaceError = null;
  renderActive();
  try {
    const unsubscribe = await current.host.onSessions(projectId, (snapshot: GuestSessionsSnapshot) => {
      if (requestId !== workspaceRequestId || snapshot.projectId !== workspaceProjectId) return;
      if (snapshot.state === 'error') {
        workspaceState = 'error';
        workspaceError = 'unavailable';
      } else {
        workspaceState = snapshot.state;
        workspaceSessions = [...snapshot.sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
        workspaceCoveragePartial = snapshot.coverage.some((entry) => entry.state !== 'ready');
        workspaceError = null;
      }
      renderActive();
    });
    if (requestId === workspaceRequestId) workspaceSessionUnsubscribe = unsubscribe;
    else unsubscribe();
  } catch (error) {
    if (requestId !== workspaceRequestId) return;
    workspaceState = 'error';
    workspaceError = isPermissionError(error) ? 'permission' : 'unavailable';
    renderActive();
  }
};

const sessionStateLabel = (state: SessionState, tm: MonitorMessages): string => ({
  running: tm.sessionRunning, retrying: tm.sessionRetrying, 'waiting-permission': tm.sessionWaitingPermission,
  'waiting-question': tm.sessionWaitingQuestion, failed: tm.sessionFailed, completed: tm.sessionCompleted, idle: tm.sessionIdle,
})[state];

const renderOpenChamberTab = (tm: MonitorMessages, locale: string): HTMLElement => {
  const view = element('div', 'section openchamber-view');
  const intro = element('p', 'caption', tm.sessionObservedActivity);
  view.append(element('h2', 'section-title', tm.workspaceActivity), intro);
  const controls = element('div', 'workspace-controls');
  const projectSlot = element('div');
  mountSelect(projectSlot, {
    label: tm.selectProject,
    value: workspaceProjectId,
    options: workspaceProjects.map((project) => ({ id: project.id, label: project.name })),
    placeholder: tm.selectProject,
    searchable: true,
    searchPlaceholder: tm.selectProject,
    onChange: (id) => { void subscribeWorkspaceSessions(id); },
    disabled: workspaceState === 'loading' && workspaceProjects.length === 0,
  });
  const filterSlot = element('div');
  mountSelect(filterSlot, {
    label: tm.sessionFilter,
    value: workspaceFilter,
    options: [
      { id: 'all', label: tm.allSessions }, { id: 'active', label: tm.activeSessions },
      { id: 'waiting', label: tm.waitingSessions }, { id: 'failed', label: tm.failedSessions },
    ],
    onChange: (id) => { if (id === 'all' || id === 'active' || id === 'waiting' || id === 'failed') { workspaceFilter = id; renderActive(); } },
  });
  controls.append(projectSlot, filterSlot);
  const searchSlot = element('div');
  mountSearchField(searchSlot, { value: workspaceQuery, label: tm.searchSessions, placeholder: tm.searchSessions, onChange: (value) => { workspaceQuery = value; renderActive(); } });
  view.append(controls, searchSlot);
  if (workspaceCoveragePartial) view.append(element('p', 'settings-note', tm.sessionCoveragePartial));
  if (workspaceState === 'loading') {
    const loading = element('div', 'loading'); mountSpinner(loading, { size: 'default', label: tm.workspaceActivity }); view.append(loading); return view;
  }
  if (workspaceState === 'error') {
    const slot = element('div');
    mountBanner(slot, { tone: 'warning', title: workspaceError === 'permission' ? tm.sessionsPermissionRequired : tm.sessionsUnavailable });
    view.append(slot); return view;
  }
  if (!workspaceProjects.length) { view.append(element('div', 'empty', tm.noProjects)); return view; }
  if (!workspaceSessions.length) { view.append(element('div', 'empty', tm.noSessions)); return view; }
  const sessions = filterSessions(workspaceSessions, workspaceFilter, workspaceQuery);
  if (!sessions.length) { view.append(element('div', 'empty', tm.noMatchingSessions)); return view; }
  const list = element('div', 'workspace-session-list');
  for (const session of sessions) {
    const card = element('article', 'card workspace-session');
    const head = element('div', 'workspace-session-head');
    const identity = element('div', 'workspace-session-title');
    identity.append(element('strong', '', session.title || tm.openSession));
    const state = sessionState(session);
    const status = element('span', 'workspace-session-state', sessionStateLabel(state, tm));
    status.dataset.state = state;
    head.append(identity, status);
    const meta = element('div', 'caption', `${tm.sessionUpdated} ${new Date(session.updatedAt).toLocaleString(locale)}`);
    if (session.archivedAt !== null) meta.append(` · ${tm.archivedSession}`);
    const actionSlot = element('div', 'workspace-session-action');
    mountButton(actionSlot, { label: tm.openSession, size: 'xs', variant: 'outline', onClick: () => {
      void current?.host.openSession(session.id).catch((error: unknown) => current?.host.toast({ kind: 'error', message: error instanceof Error ? error.message : tm.sessionsUnavailable }));
    } });
    card.append(head, meta, actionSlot);
    list.append(card);
  }
  view.append(list);
  return view;
};

type MetricTile = {
  node: HTMLElement; value: HTMLElement; detail: HTMLElement; barSlot: HTMLElement; bar: ProgressHandle;
  update: (label: string, currentValue: string, caption: string, percent: number | null, tone: Tone) => void;
};
const metricTile = (label: string): MetricTile => {
  const node = element('article', 'metric-card');
  const titleNode = element('div', 'metric-label', label);
  const value = element('div', 'metric-value', '—');
  const detail = element('div', 'metric-detail');
  const barSlot = element('div');
  const bar = mountProgress(barSlot, { value: 0, tone: 'primary', label });
  node.append(titleNode, value, detail, barSlot);
  return {
    node, value, detail, barSlot, bar,
    update: (nextLabel, currentValue, caption, percent, tone) => {
      titleNode.textContent = nextLabel;
      value.textContent = currentValue;
      detail.textContent = caption;
      barSlot.hidden = percent === null;
      if (percent !== null) bar.update({ value: percent, tone, label: nextLabel });
    },
  };
};
const overviewGrid = element('div', 'grid');
const tiles = {
  cpu: metricTile('CPU'), memory: metricTile('Memory'), gpu: metricTile('GPU'), storage: metricTile('Storage'), network: metricTile('Network'),
};
Object.values(tiles).forEach((tile) => overviewGrid.append(tile.node));
const overviewView = element('div', 'view section');
const overviewWarnings = element('div', 'section');
overviewView.append(overviewGrid, overviewWarnings);

const section = (parent: HTMLElement, label: string, className = 'section'): HTMLElement => {
  const node = element('section', className);
  node.append(element('h2', 'section-title', label));
  parent.append(node);
  return node;
};

const row = (parent: HTMLElement, label: string, value: string | null | undefined): HTMLElement => {
  const node = element('div', 'row');
  node.append(element('span', 'muted', label), element('span', 'value', value || '—'));
  parent.append(node);
  return node;
};

const healthLabel = (stats: Stats, tm: MonitorMessages): string => ({
  healthy: tm.healthy, attention: tm.attention, critical: tm.critical, unavailable: tm.unavailableState,
})[stats.health.state];

const healthTone = (stats: Stats): Tone => stats.health.state === 'critical' ? 'error'
  : stats.health.state === 'attention' ? 'warning' : stats.health.state === 'healthy' ? 'success' : 'neutral';

const percentOfMemory = (stats: Stats): number | null =>
  stats.memory.status === 'ok' && stats.memory.total > 0 ? stats.memory.used / stats.memory.total * 100 : null;

const warningTitle = (warning: Warning, stats: Stats, t: Messages, tm: MonitorMessages): string => {
  if (warning.kind === 'memory') return tm.issueMemory;
  if (warning.kind === 'cpu') return tm.issueCpu;
  if (warning.kind === 'gpu') return tm.issueGpu;
  if (warning.kind === 'swap') return tm.issueSwap;
  const disk = stats.disks.status === 'ok' ? stats.disks.items.find((item) => item.mount === warning.target) : undefined;
  return format(tm.issueDisk, { target: disk ? diskName(disk, t) : warning.target ?? t.disk });
};

const warningRecommendation = (warning: Warning, tm: MonitorMessages): string => warning.kind === 'disk'
  ? tm.storageRecommendation : warning.kind === 'cpu' ? tm.cpuRecommendation : tm.memoryRecommendation;

const warningDisclosure = (warning: Warning, stats: Stats, t: Messages, tm: MonitorMessages): HTMLElement => {
  const item = element('details', 'warning-row');
  item.dataset.level = warning.level;
  const summary = element('summary');
  summary.append(element('strong', '', warningTitle(warning, stats, t, tm)), element('span', 'severity', warning.level === 'critical' ? tm.critical : tm.attention));
  item.append(summary, element('div', 'caption', warningRecommendation(warning, tm)));
  return item;
};

const rateText = (value: number | null, locale: string): string => value === null ? '—' : `${formatBytes(value, locale)}/s`;
const selectedHistory = (values: (number | null)[], stats: Stats): (number | null)[] => {
  const count = Math.max(1, Math.floor(settings.historyMinutes * 60_000 / stats.history.sampleIntervalMs));
  return values.slice(-count);
};

const updateOverviewTiles = (stats: Stats, t: Messages, tm: MonitorMessages, locale: string): void => {
  const cpu = stats.cpu.status === 'ok' ? stats.cpu.total : null;
  tiles.cpu.update(t.cpu, cpu === null ? t.notAvailable : formatPercent(cpu, locale),
    stats.cpu.status === 'ok' ? stats.cpu.model ?? format(t.cores, { n: stats.cpu.cores }) : describeUnavailable(stats.cpu, t),
    cpu, toneFor(stats.warnings.find((item) => item.kind === 'cpu')?.level ?? null));

  const memory = percentOfMemory(stats);
  tiles.memory.update(t.memory, memory === null ? t.notAvailable : formatPercent(memory, locale),
    stats.memory.status === 'ok' ? format(t.usedOfTotal, { used: formatBytes(stats.memory.used, locale), total: formatBytes(stats.memory.total, locale) }) : describeUnavailable(stats.memory, t),
    memory, toneFor(stats.warnings.find((item) => item.kind === 'memory')?.level ?? null));

  const gpu = busiestGpu(stats.gpus);
  const gpuName = stats.gpus.status === 'ok' ? stats.gpus.devices.find((item) => item.utilization === gpu)?.name ?? tm.unavailableState : describeUnavailable(stats.gpus, t);
  tiles.gpu.update(t.gpu, gpu === null ? (stats.gpus.status === 'ok' ? tm.unavailableState : t.notAvailable) : formatPercent(gpu, locale),
    gpuName, gpu, toneFor(stats.warnings.find((item) => item.kind === 'gpu')?.level ?? null));

  const disk = fullestDisk(stats.disks);
  const diskPercentValue = disk ? diskPercent(disk) : null;
  tiles.storage.update(t.disks, disk && diskPercentValue !== null ? formatPercent(diskPercentValue, locale) : t.notAvailable,
    disk ? `${diskName(disk, t)} · ${formatBytes(disk.total - disk.used, locale)} ${tm.free.toLowerCase()}` : stats.disks.status === 'ok' ? t.noDisks : describeUnavailable(stats.disks, t),
    diskPercentValue, toneFor(stats.warnings.find((item) => item.kind === 'disk' && item.target === disk?.mount)?.level ?? null));

  const interfaces = stats.network.status === 'ok' ? stats.network.interfaces : [];
  const complete = interfaces.length > 0 && interfaces.every((item) => item.downloadBytesPerSecond !== null && item.uploadBytesPerSecond !== null);
  const down = complete ? interfaces.reduce((sum, item) => sum + (item.downloadBytesPerSecond ?? 0), 0) : null;
  const up = complete ? interfaces.reduce((sum, item) => sum + (item.uploadBytesPerSecond ?? 0), 0) : null;
  tiles.network.update(tm.network, down === null || up === null ? t.notAvailable : `↓ ${rateText(down, locale)}  ↑ ${rateText(up, locale)}`,
    stats.network.status === 'ok' ? format(tm.interfaceCount, { n: interfaces.length }) : describeUnavailable(stats.network, t),
    null, 'primary');
};

const renderOverview = (stats: Stats, t: Messages, tm: MonitorMessages, locale: string): HTMLElement => {
  updateOverviewTiles(stats, t, tm, locale);
  overviewWarnings.replaceChildren();
  if (stats.health.warningCount > 0) {
    const warnings = section(overviewWarnings, format(tm.issuesDetected, { n: stats.health.warningCount }));
    const list = element('div', 'warning-list');
    for (const warning of stats.warnings.slice(0, 3)) {
      list.append(warningDisclosure(warning, stats, t, tm));
    }
    warnings.append(list);
  } else {
    const note = element('div', 'caption', tm.noIssues);
    overviewWarnings.append(note);
  }
  return overviewView;
};

const chart = (parent: HTMLElement, label: string, values: (number | null)[], locale: string, suffix = '%'): void => {
  const wrap = element('section', 'chart-card');
  wrap.append(element('div', 'caption', label));
  const selected = values;
  const line = suffix === '%' ? sparkline(selected, label) : sparklineFromValues(selected, label);
  wrap.append(line);
  const known = selected.filter((value): value is number => value !== null);
  const detail = element('div', 'caption');
  const seconds = (selected.length * (lastStats?.history.sampleIntervalMs ?? 2_000)) / 1000;
  const windowText = seconds < 60 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
  detail.append(element('span', '', windowText));
  if (known.length) {
    const max = Math.max(...known); const min = Math.min(...known);
    detail.append(element('span', '', `${formatNumber(min, locale, 1)}${suffix} – ${formatNumber(max, locale, 1)}${suffix}`));
  }
  wrap.append(detail);
  parent.append(wrap);
};

const addProcesses = (parent: HTMLElement, stats: Stats, tm: MonitorMessages, t: Messages, locale: string): void => {
  if (stats.processes.status !== 'ok') {
    parent.append(element('div', 'empty', describeUnavailable(stats.processes, t)));
    return;
  }
  const show = (label: string, items: ProcessEntry[], cpu: boolean) => {
    const card = element('div', 'card');
    card.append(element('div', 'card-title', label));
    if (items.length === 0) card.append(element('div', 'caption', tm.noProcesses));
    else {
      const list = element('div', 'process-table');
      for (const item of items.slice(0, settings.processLimit)) {
        const line = element('div', 'process-row');
        line.append(
          element('span', 'process-name', item.name),
          element('span', 'muted', `PID ${item.pid}`),
          element('span', 'value', item.cpuPercent === null ? '—' : formatPercent(item.cpuPercent, locale)),
          element('span', 'value', item.memoryBytes === null ? '—' : formatBytes(item.memoryBytes, locale)),
        );
        list.append(line);
      }
      card.append(list);
    }
    parent.append(card);
  };
  show(tm.topCpu, stats.processes.topCpu, true);
  show(tm.topMemory, stats.processes.topMemory, false);
};

const renderProcesses = (stats: Stats, tm: MonitorMessages, t: Messages, locale: string): HTMLElement => {
  const view = element('div', 'view section');
  const card = section(view, tm.processes, 'card');
  card.append(element('div', 'caption', tm.processScopeNotice));
  if (stats.processes.status !== 'ok') {
    card.append(element('div', 'empty', describeUnavailable(stats.processes, t)));
    return view;
  }

  // Prefer the bounded PID-ordered inventory. Keep compatibility with an older host service.
  const byPid = new Map<number, ProcessEntry>();
  for (const item of stats.processes.items ?? [...stats.processes.topCpu, ...stats.processes.topMemory]) {
    byPid.set(item.pid, { ...byPid.get(item.pid), ...item });
  }
  const controls = element('div', 'process-controls');
  const searchSlot = element('div');
  mountSearchField(searchSlot, {
    value: processQuery, label: tm.searchProcesses, placeholder: tm.searchProcesses,
    onChange: (value) => { processQuery = value; renderActive(); },
  });
  const filterSlot = element('div');
  mountSelect(filterSlot, {
    value: processFilter, label: tm.processFilter,
    options: [
      { id: 'all', label: tm.allProcesses },
      { id: 'cpu', label: tm.highCpuProcesses },
      { id: 'memory', label: tm.highMemoryProcesses },
    ],
    onChange: (id) => {
      if (id === 'all' || id === 'cpu' || id === 'memory') { processFilter = id; renderActive(); }
    },
  });
  const treeToggle = element('div');
  mountButton(treeToggle, { label: processTreeMode ? tm.listView : tm.treeView, size: 'xs', variant: processTreeMode ? 'secondary' : 'outline', onClick: () => { processTreeMode = !processTreeMode; renderActive(); } });
  controls.append(searchSlot, filterSlot, treeToggle);
  card.append(controls);

  const query = processQuery.trim().toLocaleLowerCase(locale);
  const cpuThreshold = 5;
  const memoryThreshold = 512 * 1024 * 1024;
  const rows = [...byPid.values()].filter((item) => {
    const matchesQuery = !query || item.name.toLocaleLowerCase(locale).includes(query) || String(item.pid).includes(query);
    const matchesFilter = processFilter === 'all'
      || (processFilter === 'cpu' && item.cpuPercent !== null && item.cpuPercent >= cpuThreshold)
      || (processFilter === 'memory' && item.memoryBytes !== null && item.memoryBytes >= memoryThreshold);
    return matchesQuery && matchesFilter;
  });
  const compareProcesses = (a: ProcessEntry, b: ProcessEntry): number => {
    const comparison = processSort === 'name' ? a.name.localeCompare(b.name, locale)
      : processSort === 'pid' ? a.pid - b.pid
        : processSort === 'cpu' ? (a.cpuPercent ?? -1) - (b.cpuPercent ?? -1)
          : (a.memoryBytes ?? -1) - (b.memoryBytes ?? -1);
    return processSortDirection === 'ascending' ? comparison : -comparison;
  };
  rows.sort(compareProcesses);
  const visibleRows: ProcessTreeRow[] = processTreeMode
    ? flattenProcessTree(rows, collapsedProcessPids, compareProcesses)
    : rows.map((item) => ({ item, depth: 0, hasChildren: false, collapsed: false }));

  const table = element('table', 'processes-grid');
  table.setAttribute('aria-label', tm.processes);
  const thead = element('thead');
  const headings = element('tr');
  const sortColumns: { label: string; key: ProcessSort }[] = [
    { label: tm.process, key: 'name' }, { label: tm.pid, key: 'pid' },
    { label: tm.cpu, key: 'cpu' }, { label: tm.memory, key: 'memory' },
  ];
  sortColumns.forEach(({ label, key }) => {
    const th = element('th');
    if (processSort === key) th.setAttribute('aria-sort', processSortDirection);
    const sortButton = document.createElement('button');
    sortButton.type = 'button';
    sortButton.className = 'process-sort';
    sortButton.textContent = `${label}${processSort === key ? processSortDirection === 'ascending' ? ' ↑' : ' ↓' : ''}`;
    sortButton.setAttribute('aria-label', format(tm.sortProcessesBy, { column: label }));
    sortButton.addEventListener('click', () => {
      if (processSort === key) processSortDirection = processSortDirection === 'ascending' ? 'descending' : 'ascending';
      else {
        processSort = key;
        processSortDirection = key === 'name' || key === 'pid' ? 'ascending' : 'descending';
      }
      renderActive();
    });
    th.append(sortButton);
    headings.append(th);
  });
  thead.append(headings);
  table.append(thead);
  const tbody = element('tbody');
  visibleRows.forEach(({ item, depth, hasChildren, collapsed }) => {
    const tr = element('tr');
    const nameCell = element('td', 'process-name-cell');
    nameCell.style.paddingInlineStart = `${10 + depth * 16}px`;
    if (processTreeMode && hasChildren) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'process-tree-toggle';
      toggle.textContent = collapsed ? '+' : '−';
      toggle.setAttribute('aria-label', format(collapsed ? tm.expandProcess : tm.collapseProcess, { name: item.name }));
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.addEventListener('click', () => {
        if (collapsedProcessPids.has(item.pid)) collapsedProcessPids.delete(item.pid);
        else collapsedProcessPids.add(item.pid);
        renderActive();
      });
      nameCell.append(toggle);
    } else if (processTreeMode) nameCell.append(element('span', 'process-tree-spacer'));
    const nameButton = document.createElement('button');
    nameButton.type = 'button';
    nameButton.className = 'process-name-control';
    nameButton.textContent = item.name;
    if (selectedProcessPid === item.pid) nameButton.setAttribute('aria-current', 'true');
    nameButton.addEventListener('click', () => { selectedProcessPid = item.pid; renderActive(); });
    nameCell.append(nameButton);
    tr.append(
      nameCell,
      (() => {
        const cell = element('td', 'muted', String(item.pid));
        const details = [
          item.parentPid !== undefined && item.parentPid !== null ? `${tm.parentPid} ${item.parentPid}` : '',
          item.threadCount !== undefined && item.threadCount !== null ? `${item.threadCount} ${tm.threadCount.toLocaleLowerCase(locale)}` : '',
        ].filter(Boolean).join(' · ');
        if (details) cell.append(element('span', 'process-meta', details));
        return cell;
      })(),
      element('td', 'value', item.cpuPercent === null ? t.notAvailable : formatPercent(item.cpuPercent, locale)),
      element('td', 'value', item.memoryBytes === null ? t.notAvailable : formatBytes(item.memoryBytes, locale)),
    );
    tbody.append(tr);
  });
  table.append(tbody);
  if (rows.length === 0) card.append(element('div', 'empty', tm.noMatchingProcesses));
  else card.append(table);
  const selectedProcess = selectedProcessPid === null ? null : byPid.get(selectedProcessPid) ?? null;
  if (selectedProcessPid !== null) {
    const details = element('section', 'card process-detail');
    details.setAttribute('aria-label', tm.processDetails);
    details.append(element('div', 'card-title', selectedProcess ? `${tm.selectedProcess}: ${selectedProcess.name}` : tm.processNoLongerSampled));
    if (selectedProcess) {
      const detailGrid = element('div', 'process-detail-grid');
      row(detailGrid, tm.pid, String(selectedProcess.pid));
      row(detailGrid, tm.parentPid, selectedProcess.parentPid === undefined || selectedProcess.parentPid === null ? t.notAvailable : String(selectedProcess.parentPid));
      row(detailGrid, tm.threadCount, selectedProcess.threadCount === undefined || selectedProcess.threadCount === null ? t.notAvailable : String(selectedProcess.threadCount));
      row(detailGrid, tm.processState, selectedProcess.state ?? t.notAvailable);
      row(detailGrid, tm.cpu, selectedProcess.cpuPercent === null ? t.notAvailable : formatPercent(selectedProcess.cpuPercent, locale));
      row(detailGrid, tm.memory, selectedProcess.memoryBytes === null ? t.notAvailable : formatBytes(selectedProcess.memoryBytes, locale));
      details.append(detailGrid);
    }
    card.append(details);
  }
  const inventoryTotal = stats.processes.totalProcesses ?? byPid.size;
  const inventoryNote = stats.processes.inventoryTruncated
    ? ` ${tm.processInventoryCapped.replace('{count}', String(byPid.size)).replace('{total}', String(inventoryTotal))}`
    : ` ${tm.processInventoryComplete.replace('{total}', String(inventoryTotal))}`;
  card.append(element('div', 'caption', `${format(tm.processRowsShown, { count: rows.length, total: rows.length })}${inventoryNote}`));
  return view;
};

const renderPerformance = (stats: Stats, t: Messages, tm: MonitorMessages, locale: string): HTMLElement => {
  const view = element('div', 'view info-grid');
  const cpu = section(view, t.cpu, 'card');
  if (stats.cpu.status === 'ok') {
    const frequency = stats.cpu.frequencyMHz && stats.cpu.frequencyMHz > 0 ? ` · ${formatNumber(stats.cpu.frequencyMHz / 1000, locale)} GHz` : '';
    cpu.append(element('div', 'metric-value', formatPercent(stats.cpu.total, locale)), element('div', 'caption', `${stats.cpu.model ?? ''}${frequency}`));
    const cpuTabsSlot = element('div');
    mountTabs(cpuTabsSlot, { items: [{ id: 'overall', label: tm.overall }, { id: 'per-core', label: tm.perCore }], activeId: cpuView, onChange: (id) => {
      if (id !== 'overall' && id !== 'per-core') return;
      cpuView = id;
      renderActive();
    } });
    cpu.append(cpuTabsSlot);
    if (cpuView === 'overall') chart(cpu, `${t.cpu} · ${t.history}`, selectedHistory(stats.history.cpu, stats), locale);
    if (stats.cpu.load) row(cpu, t.load, stats.cpu.load.map((value) => formatNumber(value, locale)).join(' · '));
    if (cpuView === 'per-core' && stats.cpu.perCore.length > 0) {
      const cores = element('div', 'core-grid');
      cores.setAttribute('aria-label', tm.perCore);
      stats.cpu.perCore.forEach((value, index) => {
        const cell = element('div', 'core-cell');
        const label = element('div', 'caption', `${index + 1}: ${formatPercent(value, locale)}`);
        const track = element('div', 'core-track');
        const fill = element('div', 'core-fill');
        fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
        track.append(fill); cell.append(label, track); cores.append(cell);
      });
      cpu.append(cores);
    } else if (cpuView === 'per-core') cpu.append(element('div', 'caption', t.notAvailable));
  } else cpu.append(element('div', 'caption', describeUnavailable(stats.cpu, t)));

  const memory = section(view, t.memory, 'card');
  if (stats.memory.status === 'ok') {
    const percent = percentOfMemory(stats);
    memory.append(element('div', 'metric-value', percent === null ? t.notAvailable : formatPercent(percent, locale)));
    row(memory, tm.used, formatBytes(stats.memory.used, locale));
    row(memory, tm.free, stats.memory.available === undefined ? null : formatBytes(stats.memory.available, locale));
    row(memory, t.swap, stats.memory.swapUsed === null || stats.memory.swapTotal === null ? null : format(t.usedOfTotal, { used: formatBytes(stats.memory.swapUsed, locale), total: formatBytes(stats.memory.swapTotal, locale) }));
    if (stats.memory.cached !== undefined && stats.memory.cached !== null) row(memory, tm.cached, formatBytes(stats.memory.cached, locale));
    if (stats.memory.committed !== undefined && stats.memory.committed !== null) row(memory, tm.committed, formatBytes(stats.memory.committed, locale));
    if (stats.memory.commitLimit !== undefined && stats.memory.commitLimit !== null) row(memory, tm.commitLimit, formatBytes(stats.memory.commitLimit, locale));
    if (stats.memory.pressure) row(memory, tm.pressure, stats.memory.pressure);
    chart(memory, `${t.memory} · ${tm.historyWindow.toLowerCase()}`, selectedHistory(stats.history.memory, stats), locale);
  } else memory.append(element('div', 'caption', describeUnavailable(stats.memory, t)));

  const gpu = section(view, t.gpu, 'card');
  if (stats.gpus.status !== 'ok') gpu.append(element('div', 'caption', describeUnavailable(stats.gpus, t)));
  else if (stats.gpus.devices.length === 0) gpu.append(element('div', 'caption', t.reasonNoDevice));
  else for (const device of stats.gpus.devices) {
    const deviceCard = element('div', 'info-block');
    deviceCard.append(element('div', 'card-title', device.name));
    row(deviceCard, tm.utilization, device.utilization === null ? null : formatPercent(device.utilization, locale));
    row(deviceCard, t.dedicatedMemory, device.memUsed !== null && device.memTotal !== null ? format(t.usedOfTotal, { used: formatBytes(device.memUsed, locale), total: formatBytes(device.memTotal, locale) }) : null);
    row(deviceCard, tm.temperature, device.temperatureC === null || device.temperatureC === undefined ? null : `${formatNumber(device.temperatureC, locale, 1)} °C`);
    row(deviceCard, tm.frequency, device.frequencyMHz === null || device.frequencyMHz === undefined ? null : `${formatNumber(device.frequencyMHz, locale, 0)} MHz`);
    row(deviceCard, tm.power, device.powerW === null || device.powerW === undefined ? null : `${formatNumber(device.powerW, locale, 1)} W`);
    row(deviceCard, tm.fanSpeed, device.fanPercent === null || device.fanPercent === undefined ? null : formatPercent(device.fanPercent, locale));
    row(deviceCard, tm.driver, device.driverVersion ?? null);
    gpu.append(deviceCard);
  }

  const network = section(view, tm.network, 'card');
  if (stats.network.status !== 'ok') network.append(element('div', 'caption', describeUnavailable(stats.network, t)));
  else {
    const interfaces = stats.network.interfaces;
    for (const item of interfaces) {
      const iface = element('div', 'info-block');
      iface.append(element('div', 'card-title', item.name));
      row(iface, tm.route, item.isDefault === true ? tm.defaultRoute : item.isDefault === false ? tm.otherInterface : null);
      row(iface, tm.download, rateText(item.downloadBytesPerSecond, locale));
      row(iface, tm.upload, rateText(item.uploadBytesPerSecond, locale));
      row(iface, tm.receivedSent, `${formatBytes(item.receivedBytes, locale)} / ${formatBytes(item.sentBytes, locale)}`);
      row(iface, tm.linkSpeed, item.linkSpeedBps === null ? null : `${formatBytes(item.linkSpeedBps / 8, locale)}/s`);
      network.append(iface);
    }
    chart(network, tm.download, selectedHistory(stats.history.networkDown, stats), locale, ' B/s');
    chart(network, tm.upload, selectedHistory(stats.history.networkUp, stats), locale, ' B/s');
  }

  const processSection = section(view, tm.processes, 'card');
  addProcesses(processSection, stats, tm, t, locale);
  return view;
};

const renderStorage = (stats: Stats, t: Messages, tm: MonitorMessages, locale: string): HTMLElement => {
  const view = element('div', 'view section');
  const storageTabsSlot = element('div');
  mountTabs(storageTabsSlot, { items: [{ id: 'capacity', label: tm.capacity }, { id: 'activity', label: tm.activity }], activeId: storageView, onChange: (id) => {
    if (id !== 'capacity' && id !== 'activity') return;
    storageView = id;
    renderActive();
  } });
  view.append(storageTabsSlot);
  if (stats.disks.status !== 'ok') {
    view.append(element('div', 'empty', describeUnavailable(stats.disks, t)));
    return view;
  }
  if (stats.disks.items.length === 0) view.append(element('div', 'empty', t.noDisks));
  for (const [index, disk] of stats.disks.items.entries()) {
    const card = element('article', 'card');
    const percent = diskPercent(disk);
    const diskKey = disk.device?.replace(/^\/dev\//, '') ?? disk.mount;
    const activity = stats.diskActivity.status === 'ok'
      ? stats.diskActivity.items.find((item) => item.device === diskKey || item.device === disk.device || item.device === disk.mount)
      : null;
    const head = element('div', 'card-head');
    head.append(element('div', 'card-title', diskName(disk, t)), element('span', 'value', storageView === 'capacity' ? (percent === null ? t.notAvailable : formatPercent(percent, locale)) : ''));
    card.append(head);
    if (storageView === 'capacity') {
      const barSlot = element('div');
      if (percent !== null) mountProgress(barSlot, { value: percent, tone: toneFor(stats.warnings.find((warning) => warning.kind === 'disk' && warning.target === disk.mount)?.level ?? null), label: diskName(disk, t) });
      else barSlot.hidden = true;
      card.append(barSlot);
      row(card, tm.used, percent === null ? t.notAvailable : `${formatBytes(disk.used, locale)} / ${formatBytes(disk.total, locale)}`);
      row(card, tm.free, percent === null ? t.notAvailable : formatBytes(Math.max(0, disk.total - disk.used), locale));
      row(card, tm.fileSystem, disk.fileSystem ?? null);
      row(card, tm.device, [disk.driveType, disk.deviceType, disk.device ? `Disk ${index + 1}` : null].filter(Boolean).join(' · ') || null);
    } else if (activity) {
      row(card, `${tm.read} / ${tm.write}`, `${rateText(activity.readBytesPerSecond, locale)} / ${rateText(activity.writeBytesPerSecond, locale)}`);
      row(card, tm.readIops, activity.readIops === null ? null : formatNumber(activity.readIops, locale, 0));
      row(card, tm.writeIops, activity.writeIops === null ? null : formatNumber(activity.writeIops, locale, 0));
      row(card, tm.activeTime, activity.activePercent === null ? null : formatPercent(activity.activePercent, locale));
      row(card, tm.responseTime, activity.responseMs === null ? null : `${formatNumber(activity.responseMs, locale, 1)} ms`);
    } else row(card, tm.activity, stats.diskActivity.status === 'unavailable' ? describeUnavailable(stats.diskActivity, t) : t.notAvailable);
    view.append(card);
  }
  return view;
};

const renderHardware = (stats: Stats, t: Messages, tm: MonitorMessages, locale: string): HTMLElement => {
  const view = element('div', 'view info-grid');
  const computer = stats.environment.computer;
  const details = computer?.details;
  const system = section(view, tm.computer, 'card');
  if (computer) {
    row(system, t.hostName, computer.hostName);
    row(system, t.operatingSystem, [details?.osName ?? computer.operatingSystem, details?.osDisplayVersion, details?.osBuild ? format(t.build, { n: details.osBuild }) : null].filter(Boolean).join(' · ') || null);
    row(system, t.architecture, computer.architecture);
    row(system, t.uptime, computer.uptimeSeconds === undefined || computer.uptimeSeconds === null ? null : `${Math.floor(computer.uptimeSeconds / 86400)} d ${Math.floor(computer.uptimeSeconds % 86400 / 3600)} h`);
    row(system, t.container, stats.environment.container ? t.containerHint : null);
  }
  row(system, t.computer, [details?.manufacturer, details?.model].filter(Boolean).join(' · ') || null);
  row(system, tm.motherboard, details?.motherboard ?? null);
  row(system, t.firmware, details?.firmware ?? null);

  const cpu = section(view, t.cpu, 'card');
  row(cpu, tm.device, stats.cpu.status === 'ok' ? stats.cpu.model : null);
  row(cpu, t.physicalCores.replace('{n}', ''), details?.physicalCores ? String(details.physicalCores) : null);
  row(cpu, t.logicalProcessors.replace('{n}', ''), details?.logicalProcessors ? String(details.logicalProcessors) : stats.cpu.status === 'ok' ? String(stats.cpu.cores) : null);
  row(cpu, t.maxSpeed.replace('{n}', ''), details?.cpuMaxMHz ? `${formatNumber(details.cpuMaxMHz / 1000, locale)} GHz` : null);
  const memory = section(view, t.memory, 'card');
  row(memory, tm.used, stats.memory.status === 'ok' ? formatBytes(stats.memory.total, locale) : null);
  row(memory, t.memoryModules, details?.memoryModules ? String(details.memoryModules) : null);
  row(memory, tm.memorySpeed, details?.memorySpeedMHz ? `${details.memorySpeedMHz} MHz` : null);

  const gpu = section(view, t.gpu, 'card');
  if (stats.gpus.status !== 'ok') gpu.append(element('div', 'caption', describeUnavailable(stats.gpus, t)));
  else for (const device of stats.gpus.devices) {
    row(gpu, tm.device, device.name);
    row(gpu, tm.driver, device.driverVersion ?? details?.displayAdapters.find((item) => item.startsWith(device.name))?.split(' · ').at(-1) ?? null);
    row(gpu, tm.temperature, device.temperatureC === null || device.temperatureC === undefined ? null : `${device.temperatureC} °C`);
  }
  if (details?.displayAdapters.length) row(gpu, t.displayAdapters, details.displayAdapters.join(' · '));
  return view;
};

const renderHealth = (stats: Stats, t: Messages, tm: MonitorMessages, locale: string): HTMLElement => {
  const view = element('div', 'view section');
  const summary = element('article', 'card');
  const titleNode = element('div', 'card-head');
  titleNode.append(element('div', 'card-title', tm.health), element('span', 'value', healthLabel(stats, tm)));
  titleNode.dataset.state = stats.health.state;
  summary.append(titleNode, element('div', 'caption', stats.health.warningCount ? format(tm.issuesDetected, { n: stats.health.warningCount }) : tm.noIssues));
  view.append(summary);

  const all = section(view, t.warnings);
  if (!stats.warnings.length) all.append(element('div', 'caption', tm.noIssues));
  for (const warning of stats.warnings) all.append(warningDisclosure(warning, stats, t, tm));

  if (stats.sensors.status === 'ok' && stats.sensors.readings.length) {
    const sensors = section(view, tm.temperature);
    for (const reading of stats.sensors.readings) row(sensors, reading.name, `${formatNumber(reading.temperatureC, locale, 1)} °C`);
  }
  if (stats.battery.status === 'ok') {
    const battery = section(view, tm.battery);
    row(battery, tm.used, formatPercent(stats.battery.percent, locale));
    row(battery, tm.battery, stats.battery.state === 'charging' ? tm.charging : stats.battery.state === 'discharging' ? tm.discharging : stats.battery.state === 'full' ? tm.full : tm.unavailableState);
    row(battery, tm.acConnected, stats.battery.acConnected === null ? null : stats.battery.acConnected ? tm.connected : tm.disconnected);
    row(battery, tm.remaining, stats.battery.remainingSeconds === null ? null : `${Math.round(stats.battery.remainingSeconds / 60)} min`);
    row(battery, tm.batteryHealth, stats.battery.healthPercent === null ? null : formatPercent(stats.battery.healthPercent, locale));
  }

  const copy = element('div');
  mountButton(copy, { label: tm.copyDiagnostics, size: 'sm', variant: 'secondary', onClick: () => {
    const currentStats = lastStats;
    if (!currentStats) return;
    const currentTm = current?.tm ?? tm;
    const sanitized = {
      system: {
        os: [currentStats.environment.computer?.details?.osName ?? currentStats.environment.computer?.operatingSystem, currentStats.environment.computer?.details?.osDisplayVersion].filter(Boolean).join(' ') || null,
        architecture: currentStats.environment.computer?.architecture ?? null,
        manufacturer: currentStats.environment.computer?.details?.manufacturer ?? null,
        model: currentStats.environment.computer?.details?.model ?? null,
        cpu: currentStats.cpu.status === 'ok' ? { model: currentStats.cpu.model, cores: currentStats.cpu.cores, utilizationPercent: Math.round(currentStats.cpu.total) } : null,
        memory: currentStats.memory.status === 'ok' ? { totalBytes: currentStats.memory.total, usedBytes: currentStats.memory.used, swapTotalBytes: currentStats.memory.swapTotal, swapUsedBytes: currentStats.memory.swapUsed } : null,
        gpus: currentStats.gpus.status === 'ok' ? currentStats.gpus.devices.map((item) => ({ name: item.name, utilizationPercent: item.utilization, memoryUsedBytes: item.memUsed, memoryTotalBytes: item.memTotal })) : null,
        disks: currentStats.disks.status === 'ok' ? currentStats.disks.items.map((item, index) => ({ name: `Disk ${index + 1}`, totalBytes: item.total, usedBytes: item.used, fileSystem: item.fileSystem ?? null })) : null,
        network: currentStats.network.status === 'ok' ? currentStats.network.interfaces.map((item) => ({ interface: `Interface ${item.isDefault === true ? 'default' : 'other'}`, downloadBytesPerSecond: item.downloadBytesPerSecond, uploadBytesPerSecond: item.uploadBytesPerSecond })) : null,
        warnings: currentStats.warnings.map((item) => ({ kind: item.kind, level: item.level, target: item.kind === 'disk' ? 'Disk' : item.target })),
      },
    };
    const markdown = '# System Monitor diagnostics\n\n```json\n' + JSON.stringify(sanitized, null, 2) + '\n```';
    void current?.host.writeClipboard(markdown).then(() => current?.host.toast({ kind: 'success', message: currentTm.copied })).catch(() => undefined);
  } });
  view.append(copy);
  return view;
};

const renderOptimization = (stats: Stats, t: Messages, tm: MonitorMessages, locale: string): HTMLElement => {
  const view = element('div', 'view section');
  const recommendations: { title: string; body: string; action?: string; run?: () => void }[] = [];
  if (stats.disks.status === 'ok' && stats.disks.items.some((disk) => (diskPercent(disk) ?? -1) >= settings.thresholds.diskWarning)) {
    recommendations.push({ title: tm.issueDisk.replace('{target}', t.disk), body: tm.storageRecommendation, action: stats.environment.platform === 'win32' ? tm.openSystemSettings : undefined, run: () => { void current?.host.serviceRequest({ method: 'POST', path: '/open-storage-settings' }).catch(() => undefined); } });
  }
  if (percentOfMemory(stats) !== null && (percentOfMemory(stats) ?? 0) >= settings.thresholds.memoryWarning) {
    recommendations.push({ title: tm.issueMemory, body: tm.memoryRecommendation, action: tm.processes, run: () => { activeTab = 'performance'; tabs.update({ items: tabLabels(current?.tm ?? tm), activeId: activeTab, trackBackground: true, onChange: changeTab }); renderActive(); } });
  }
  if (stats.cpu.status === 'ok' && stats.cpu.total >= settings.thresholds.cpuWarning) {
    recommendations.push({ title: tm.issueCpu, body: tm.cpuRecommendation, action: tm.processes, run: () => { activeTab = 'performance'; tabs.update({ items: tabLabels(current?.tm ?? tm), activeId: activeTab, trackBackground: true, onChange: changeTab }); renderActive(); } });
  }
  if (recommendations.length === 0) view.append(element('div', 'empty', tm.noIssues));
  for (const recommendation of recommendations) {
    const card = element('article', 'recommendation');
    card.append(element('strong', '', recommendation.title), element('div', 'caption', recommendation.body));
    if (recommendation.action && recommendation.run) {
      const button = element('div');
      mountButton(button, { label: recommendation.action, size: 'xs', variant: 'outline', onClick: recommendation.run });
      card.append(button);
    }
    view.append(card);
  }
  view.append(element('div', 'settings-note', tm.readOnly));
  if (stats.environment.platform === 'win32') row(view, tm.openSystemSettings, tm.storageRecommendation);
  return view;
};

const selectField = (parent: HTMLElement, label: string, value: string, options: { id: string; label: string }[], onChange: (id: string) => void): void => {
  const node = element('label', 'select-field');
  const select = element('div');
  mountSelect(select, { label, value, options, onChange });
  node.append(select); parent.append(node);
};

const saveSettings = async (next: MonitorSettings): Promise<void> => {
  settings = normalizeMonitorSettings(next);
  current?.setPollingInterval(settings.refreshSeconds * 1000);
  syncHeader();
  renderActive();
  if (current) {
    const json = JSON.stringify(settings);
    await current.host.storage.set(SETTINGS_KEY, JSON.parse(json) as JsonValue).catch(() => undefined);
    await current.host.serviceRequest({ method: 'POST', path: '/settings', body: json }).catch(() => undefined);
  }
};

const renderSettings = (tm: MonitorMessages, t: Messages): HTMLElement => {
  const view = element('div', 'view section');
  const general = section(view, tm.settings, 'card settings-group');
  const selects = element('div', 'select-grid');
  selectField(selects, tm.refreshInterval, String(settings.refreshSeconds), [
    { id: '2', label: tm.everyTwoSeconds }, { id: '5', label: tm.everyFiveSeconds }, { id: '10', label: tm.everyTenSeconds },
  ], (id) => { void saveSettings({ ...settings, refreshSeconds: Number(id) as 2 | 5 | 10 }); });
  selectField(selects, tm.historyWindow, String(settings.historyMinutes), [
    { id: '2', label: tm.lastTwoMinutes }, { id: '5', label: tm.lastFiveMinutes }, { id: '15', label: tm.lastFifteenMinutes }, { id: '30', label: tm.lastThirtyMinutes },
  ], (id) => { void saveSettings({ ...settings, historyMinutes: Number(id) as 2 | 5 | 15 | 30 }); });
  selectField(selects, tm.processLimit, String(settings.processLimit), [
    { id: '5', label: tm.showTop5 }, { id: '10', label: tm.showTop10 }, { id: '20', label: tm.showTop20 },
  ], (id) => { void saveSettings({ ...settings, processLimit: Number(id) as 5 | 10 | 20 }); });
  general.append(selects);

  const modules = section(view, tm.modules, 'card settings-group');
  const switches = element('div', 'switch-list');
  for (const key of ['network', 'processes', 'battery', 'sensors'] as const) {
    const holder = element('div');
    mountSwitch(holder, {
      label: key === 'sensors' ? tm.temperature : tm[key], checked: settings.modules[key],
      onChange: (checked) => { void saveSettings({ ...settings, modules: { ...settings.modules, [key]: checked } }); },
    });
    switches.append(holder);
  }
  modules.append(switches);

  const alertCard = section(view, tm.alerts, 'card settings-group');
  const alertGrid = element('div', 'select-grid');
  const thresholdOptions = [70, 75, 80, 85, 90, 95].map((value) => ({ id: String(value), label: `${value}%` }));
  for (const [kind, warningKey, criticalKey] of [
    ['memory', 'memoryWarning', 'memoryCritical'], ['disk', 'diskWarning', 'diskCritical'],
    ['cpu', 'cpuWarning', 'cpuCritical'], ['gpu', 'gpuWarning', 'gpuCritical'],
  ] as const) {
    const titleText = kind === 'memory' ? t.memory : kind === 'disk' ? t.disks : kind === 'cpu' ? t.cpu : t.gpu;
    selectField(alertGrid, `${titleText} · ${tm.warningThreshold}`, String(settings.thresholds[warningKey]), thresholdOptions,
      (id) => { void saveSettings({ ...settings, thresholds: { ...settings.thresholds, [warningKey]: Number(id) } }); });
    selectField(alertGrid, `${titleText} · ${tm.criticalThreshold}`, String(settings.thresholds[criticalKey]), thresholdOptions,
      (id) => { void saveSettings({ ...settings, thresholds: { ...settings.thresholds, [criticalKey]: Number(id) } }); });
  }
  selectField(alertGrid, tm.sustainedFor, String(settings.thresholds.sustainedSeconds), [
    { id: '30', label: '30 s' }, { id: '60', label: '60 s' }, { id: '120', label: '120 s' },
  ], (id) => { void saveSettings({ ...settings, thresholds: { ...settings.thresholds, sustainedSeconds: Number(id) as 30 | 60 | 120 } }); });
  alertCard.append(alertGrid);
  view.append(element('div', 'settings-note', tm.readOnly));
  const privacy = section(view, tm.privacy, 'card');
  privacy.append(element('div', 'caption', tm.readOnly));
  return view;
};

const renderWslTab = (): void => {
  if (!current) return;
  const view = renderWslView({
    snapshot: wslSnapshot,
    loading: wslLoading,
    busy: wslBusy,
    statusMessage: wslStatusMessage,
    catalog: wslCatalog,
    catalogLoading: wslCatalogLoading,
    config: wslConfig,
    configLoading: wslConfigLoading,
    diagnostics: wslDiagnostics,
    diagnosticsLoading: wslDiagnosticsLoading,
    t: current.t,
    tm: current.tm,
    locale: current.locale,
    onRefresh: () => { void refreshWslSnapshot(); },
    onLoadCatalog: () => { void refreshWslCatalog(); },
    onAction: (action) => { void runWslActionFromPanel(action); },
    onLoadConfig: (target) => { void loadWslConfig(target); },
    onSaveConfig: (target, text) => { void saveWslConfig(target, text); },
    onLoadDiagnostics: (distro) => { void loadWslDiagnostics(distro); },
  });
  content.replaceChildren(view);
  renderedTab = 'wsl';
};

const loadWslDiagnostics = async (distro: string): Promise<void> => {
  if (!current || activeTab !== 'wsl' || wslDiagnosticsLoading) return;
  wslDiagnosticsLoading = distro;
  renderWslTab();
  try {
    const query = new URLSearchParams({ distro });
    const response = await current.host.serviceRequest({ method: 'GET', path: `/wsl/diagnostics?${query.toString()}` });
    const result = JSON.parse(response.body) as WslDiagnostics | { error?: string };
    if (response.status !== 200 || !('processes' in result)) throw new Error('error' in result ? result.error : current.tm.diagnosticsUnavailable);
    wslDiagnostics[distro] = result;
  } catch (error) {
    wslStatusMessage = error instanceof Error ? error.message : current.tm.diagnosticsUnavailable;
  } finally {
    wslDiagnosticsLoading = null;
    renderWslTab();
  }
};

const loadWslConfig = async (target: WslConfigTarget): Promise<void> => {
  if (!current || activeTab !== 'wsl' || wslConfigLoading) return;
  const host = current.host;
  wslConfigLoading = true;
  renderWslTab();
  try {
    const query = new URLSearchParams({ kind: target.kind });
    if (target.kind === 'distribution') query.set('distro', target.distro);
    const response = await host.serviceRequest({ method: 'GET', path: `/wsl/config?${query.toString()}` });
    const body = JSON.parse(response.body) as WslConfigDocument | { error?: string };
    if (response.status !== 200 || !('text' in body)) throw new Error('error' in body ? body.error : 'WSL configuration could not be loaded.');
    wslConfig = body;
    wslStatusMessage = null;
  } catch (error) {
    wslStatusMessage = error instanceof Error ? error.message : current.tm.actionFailed;
    await host.toast({ kind: 'error', message: wslStatusMessage }).catch(() => undefined);
  } finally {
    wslConfigLoading = false;
    renderWslTab();
  }
};

const saveWslConfig = async (target: WslConfigTarget, text: string): Promise<void> => {
  if (!current || activeTab !== 'wsl' || wslBusy) return;
  const host = current.host;
  const confirmation = target.kind === 'global' ? 'SAVE GLOBAL WSL CONFIG' : `SAVE WSL CONFIG ${target.distro}`;
  wslBusy = true;
  renderWslTab();
  try {
    const response = await host.serviceRequest({
      method: 'POST', path: '/wsl/config',
      body: JSON.stringify({ ...target, text, confirmation }),
    });
    const result = JSON.parse(response.body) as { ok?: boolean; message?: string };
    if (response.status !== 200 || !result.ok) throw new Error(result.message ?? current.tm.actionFailed);
    wslConfig = { target, text, exists: true };
    wslStatusMessage = current.tm.configSaved;
    await host.toast({ kind: 'success', message: current.tm.configSaved }).catch(() => undefined);
  } catch (error) {
    wslStatusMessage = error instanceof Error ? error.message : current.tm.actionFailed;
    await host.toast({ kind: 'error', message: wslStatusMessage }).catch(() => undefined);
  } finally {
    wslBusy = false;
    renderWslTab();
  }
};

const setWslAutoRefresh = (enabled: boolean): void => {
  if (wslRefreshTimer) clearInterval(wslRefreshTimer);
  wslRefreshTimer = null;
  if (enabled) {
    wslRefreshTimer = setInterval(() => {
      if (activeTab === 'wsl' && document.visibilityState === 'visible' && !wslLoading && !wslBusy) void refreshWslSnapshot();
    }, 30_000);
  }
};

const refreshWslCatalog = async (): Promise<void> => {
  if (!current || activeTab !== 'wsl' || wslCatalogLoading) return;
  const host = current.host;
  wslCatalogLoading = true;
  renderWslTab();
  try {
    const response = await host.serviceRequest({ method: 'GET', path: '/wsl/catalog?refresh=1' });
    if (response.status !== 200) throw new Error(`WSL catalog request failed (${response.status})`);
    wslCatalog = JSON.parse(response.body) as WslCatalog;
  } catch (error) {
    wslCatalog = { supported: false, items: [], error: error instanceof Error ? error.message : 'WSL catalog unavailable.' };
  } finally {
    wslCatalogLoading = false;
    renderWslTab();
  }
};

const refreshWslSnapshot = async (): Promise<void> => {
  if (!current || activeTab !== 'wsl' || wslLoading) return;
  const host = current.host;
  wslLoading = true;
  wslStatusMessage = null;
  renderWslTab();
  try {
    const response = await host.serviceRequest({ method: 'GET', path: '/wsl' });
    if (response.status !== 200) throw new Error(`WSL request failed (${response.status})`);
    wslSnapshot = JSON.parse(response.body) as WslSnapshot;
  } catch (error) {
    wslStatusMessage = error instanceof Error ? error.message : current?.tm.wslUnavailable ?? 'WSL request failed';
    wslSnapshot = {
      supported: false, reason: 'failed', version: null, defaultVersion: null, kernelVersion: null, wslgVersion: null,
      memoryUsedBytes: null, memoryTotalBytes: null, distributions: [], sampledAt: Date.now(), error: wslStatusMessage,
    };
  } finally {
    wslLoading = false;
    renderWslTab();
  }
};

const pollWslJob = async (jobId: string): Promise<void> => {
  if (wslJobPollActive) return;
  wslJobPollActive = true;
  try {
    while (wslJobId === jobId && current && activeTab === 'wsl' && document.visibilityState === 'visible') {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (wslJobId !== jobId || !current || activeTab !== 'wsl' || document.visibilityState !== 'visible') return;
      let response: { status: number; body: string };
      try { response = await current.host.serviceRequest({ method: 'GET', path: `/wsl/jobs/${jobId}` }); }
      catch { continue; }
      if (response.status !== 200) continue;
      const job = JSON.parse(response.body) as WslJob;
      if (job.state === 'running') continue;
      wslJobId = null;
      wslBusy = false;
      wslStatusMessage = job.message;
      const host = current.host;
      await host.toast({ kind: job.state === 'succeeded' ? 'success' : 'error', message: job.message }).catch(() => undefined);
      renderWslTab();
      if (job.state === 'succeeded') await refreshWslSnapshot();
      return;
    }
  } finally {
    wslJobPollActive = false;
  }
};

const resumeWslJobPolling = (): void => {
  if (wslJobId) void pollWslJob(wslJobId);
};

const runWslActionFromPanel = async (action: WslAction): Promise<void> => {
  if (!current || wslBusy) return;
  const host = current.host;
  wslBusy = true;
  wslStatusMessage = current.tm.actionInProgress;
  renderWslTab();
  try {
    const response = await host.serviceRequest({ method: 'POST', path: '/wsl/action', body: JSON.stringify(action) });
    const body = JSON.parse(response.body) as WslJob | { ok?: boolean; message?: string };
    if (response.status !== 202 || !('id' in body) || typeof body.id !== 'string') {
      wslBusy = false;
      wslStatusMessage = body.message ?? current?.tm.actionFailed ?? 'WSL action failed';
      await host.toast({ kind: 'error', message: wslStatusMessage }).catch(() => undefined);
      renderWslTab();
      return;
    }
    wslJobId = body.id;
    wslStatusMessage = current?.tm.actionInProgress ?? 'Working…';
    renderWslTab();
    resumeWslJobPolling();
  } catch (error) {
    wslBusy = false;
    wslStatusMessage = error instanceof Error ? error.message : current?.tm.actionFailed ?? 'WSL action failed';
    await host.toast({ kind: 'error', message: wslStatusMessage }).catch(() => undefined);
    renderWslTab();
  }
};

const changeTab = (id: string): void => {
  if (!TABS.includes(id as TabId)) return;
  activeTab = id as TabId;
  setWslAutoRefresh(activeTab === 'wsl');
  tabs.update({ items: tabLabels(current?.tm ?? monitorMessagesFor('en')), activeId: activeTab, trackBackground: true, onChange: changeTab });
  renderActive();
  if (activeTab === 'openchamber') void subscribeWorkspaceProjects();
  if (activeTab === 'wsl') {
    if (!wslSnapshot) void refreshWslSnapshot();
    resumeWslJobPolling();
  }
};

const patchNode = (target: Node, source: Node): Node => {
  if (target === source) return target;
  if (target.nodeType === Node.TEXT_NODE && source.nodeType === Node.TEXT_NODE) {
    if (target.textContent !== source.textContent) target.textContent = source.textContent;
    return target;
  }
  if (!(target instanceof Element) || !(source instanceof Element) || target.tagName !== source.tagName) {
    target.parentNode?.replaceChild(source, target);
    return source;
  }

  for (const attribute of [...target.attributes]) {
    if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
  }
  for (const attribute of [...source.attributes]) {
    if (target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value);
  }

  const sourceChildren = [...source.childNodes];
  const targetChildren = [...target.childNodes];
  for (let index = 0; index < sourceChildren.length; index += 1) {
    const sourceChild = sourceChildren[index];
    if (!sourceChild) continue;
    const targetChild = targetChildren[index];
    if (targetChild) patchNode(targetChild, sourceChild);
    else target.append(sourceChild.cloneNode(true));
  }
  for (let index = targetChildren.length - 1; index >= sourceChildren.length; index -= 1) {
    targetChildren[index]?.parentNode?.removeChild(targetChildren[index]!);
  }
  return target;
};

let renderedTab: TabId | null = null;

const renderActive = (): void => {
  if (!current) return;
  if (activeTab === 'wsl') {
    renderWslTab();
    return;
  }
  const { state, t, tm, locale } = current;
  if (activeTab === 'openchamber') {
    const view = renderOpenChamberTab(tm, locale);
    content.replaceChildren(view);
    renderedTab = activeTab;
    return;
  }
  if (state.kind === 'loading') {
    const loading = element('div', 'loading'); mountSpinner(loading, { size: 'default', label: t.measuring });
    content.replaceChildren(loading); return;
  }
  if (state.kind === 'blocked') {
    const details = blockedText(state.reason, t);
    const slot = element('div');
    mountBanner(slot, { tone: state.reason === 'failed' ? 'error' : 'warning', title: details.title, body: details.body, action: state.reason === 'failed' ? { label: t.retry, onClick: current.retry } : undefined });
    content.replaceChildren(slot); return;
  }
  const stats = state.stats;
  lastStats = stats;
  const view = activeTab === 'overview' ? renderOverview(stats, t, tm, locale)
    : activeTab === 'processes' ? renderProcesses(stats, tm, t, locale)
      : activeTab === 'performance' ? renderPerformance(stats, t, tm, locale)
      : activeTab === 'storage' ? renderStorage(stats, t, tm, locale)
        : activeTab === 'hardware' ? renderHardware(stats, t, tm, locale)
          : activeTab === 'health' ? renderHealth(stats, t, tm, locale)
            : activeTab === 'optimization' ? renderOptimization(stats, t, tm, locale)
              : renderSettings(tm, t);
  if (activeTab === 'settings') view.classList.add('settings-view');
  if (activeTab === 'overview') {
    if (content.firstElementChild !== overviewView) content.replaceChildren(overviewView);
  } else if (renderedTab === activeTab && content.firstElementChild && activeTab !== 'settings') {
    patchNode(content.firstElementChild, view);
  } else if (content.firstElementChild !== view) {
    content.replaceChildren(view);
  }
  renderedTab = activeTab;
};

const syncHeader = (): void => {
  if (!current) return;
  const { t, tm, locale, surface, state } = current;
  if (surface === 'page') shell.classList.add('page'); else shell.classList.remove('page');
  dashboardButton.update({ label: tm.dashboard, size: 'xs', variant: 'outline', onClick: () => { void current?.host.toast({ kind: 'info', message: current.tm.dashboardMenuHint }).catch(() => undefined); } });
  const dashboardNode = actions.lastElementChild as HTMLElement | null;
  if (dashboardNode) dashboardNode.hidden = surface === 'page';
  refreshButton.update({ label: tm.refresh, size: 'xs', variant: 'ghost', onClick: refreshAction });
  pauseButton.update({ label: settings.paused ? tm.resume : tm.pause, size: 'xs', variant: settings.paused ? 'default' : 'secondary', onClick: () => { void saveSettings({ ...settings, paused: !settings.paused }); } });
  if (lastStats) badge.update({ label: healthLabel(lastStats, tm), tone: healthTone(lastStats) });
  updated.textContent = lastStats ? `${tm.lastUpdate} ${new Date(lastStats.sampledAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '';
  if (state.kind === 'ready') {
    if (settings.paused) title.title = tm.paused;
    else title.title = '';
  }
  if (lastLocale !== locale || lastSurface !== surface) {
    tabs.update({ items: tabLabels(tm), activeId: activeTab, trackBackground: true, onChange: changeTab });
    navWrap.setAttribute('aria-label', 'System Monitor');
    lastLocale = locale;
    lastSurface = surface;
  }
};

const loadSettings = async (host: FrameContext['host']): Promise<void> => {
  if (settingsLoaded || loadingSettings) return;
  loadingSettings = true;
  try {
    settings = normalizeMonitorSettings(await host.storage.get(SETTINGS_KEY));
    settingsLoaded = true;
    current?.setPollingInterval(settings.refreshSeconds * 1000);
    await host.serviceRequest({ method: 'POST', path: '/settings', body: JSON.stringify(settings) }).catch(() => undefined);
    syncHeader();
    renderActive();
  } catch {
    settingsLoaded = true;
  } finally { loadingSettings = false; }
};

startFrame((frame) => {
  const contextChanged = lastLocale !== frame.locale || lastSurface !== frame.surface;
  current = frame;
  if (frame.state.kind === 'ready') lastStats = frame.state.stats;
  syncHeader();
  if (activeTab === 'wsl') {
    if (contextChanged || renderedTab !== 'wsl') renderActive();
    resumeWslJobPolling();
    if (!wslRefreshTimer) setWslAutoRefresh(true);
    return;
  }
  if (frame.state.kind !== 'ready' || activeTab !== 'settings' || contextChanged) renderActive();
}, {
  onStats: (_stats, client) => { void loadSettings(client); },
});
