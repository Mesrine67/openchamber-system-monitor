// Started by OpenChamber with the app's own runtime (Node, Electron as Node, or Bun).
// Listens on 127.0.0.1 only; the host proxies the panel's requests and adds the token.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { createCpuMemCollector } from './collectors/cpu-mem.ts';
import { readBattery } from './collectors/battery.ts';
import { readComputerInfo } from './collectors/computer.ts';
import { readDisks } from './collectors/disks.ts';
import { createDiskActivityCollector } from './collectors/disk-activity.ts';
import { createGpuCollector } from './collectors/gpu.ts';
import { readNetwork } from './collectors/network.ts';
import { createProcessCollector } from './collectors/processes.ts';
import { readSensors } from './collectors/sensors.ts';
import { runPowerShell } from './collectors/windows.ts';
import { currentPlatform, detectContainer } from './env.ts';
import { createSampler } from './sampler.ts';
import { DEFAULT_MONITOR_SETTINGS, normalizeMonitorSettings, type MonitorSettings } from '../shared/stats.ts';
import { parseWslAction, parseWslConfigUpdate, type WslJob } from '../shared/wsl.ts';
import { readWslCatalog, readWslConfig, readWslDiagnostics, readWslSnapshot, runWslAction, saveWslConfig } from './wsl.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const platform = currentPlatform();
const container = await detectContainer(platform);
const now = () => Date.now();
let settings: MonitorSettings = structuredClone(DEFAULT_MONITOR_SETTINGS);
const processCollector = createProcessCollector(platform, now);
const diskActivity = createDiskActivityCollector(platform, now);
const wslJobs = new Map<string, WslJob>();

const pruneWslJobs = (): void => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of wslJobs) {
    if (job.state !== 'running' && (job.finishedAt ?? job.startedAt) < cutoff) wslJobs.delete(id);
  }
};

const sampler = createSampler({
  now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  platform,
  container,
  cpuMem: createCpuMemCollector(platform, container, now),
  gpu: createGpuCollector(platform),
  disks: () => readDisks(platform, container),
  diskActivity,
  computerInfo: () => readComputerInfo(platform),
  network: () => readNetwork(platform, now()),
  processes: (limit) => processCollector.read(limit),
  battery: () => readBattery(platform),
  sensors: () => readSensors(platform),
  settings: () => settings,
});

const send = (res: http.ServerResponse, status: number, body: object): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readJsonBody = (req: http.IncomingMessage): Promise<unknown | null> => new Promise((resolve) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let failed = false;
  req.on('data', (chunk: Buffer) => {
    if (failed) return;
    size += chunk.length;
    if (size > 32_768) {
      failed = true;
      resolve(null);
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (failed) return;
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
    catch { resolve(null); }
  });
  req.on('error', () => resolve(null));
});

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    send(res, 401, { error: 'unauthorized' });
    return;
  }
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (pathname === '/health') {
    send(res, 200, { ok: true });
    return;
  }
  if (pathname === '/stats' && req.method === 'GET') {
    sampler.stats().then(
      (stats) => send(res, 200, stats),
      () => send(res, 503, { error: 'not-ready' }),
    );
    return;
  }
  if (pathname === '/settings' && req.method === 'POST') {
    readJsonBody(req).then((value) => {
      if (value === null) { send(res, 400, { error: 'invalid-settings' }); return; }
      const next = normalizeMonitorSettings(value);
      const wasPaused = settings.paused;
      settings = next;
      if (next.paused && !wasPaused) sampler.pause();
      else if (!next.paused && wasPaused) sampler.resume();
      send(res, 200, { ok: true });
    });
    return;
  }
  if (pathname === '/wsl' && req.method === 'GET') {
    readWslSnapshot().then(
      (snapshot) => send(res, 200, snapshot),
      () => send(res, 503, { error: 'wsl-unavailable' }),
    );
    return;
  }
  if (pathname === '/wsl/diagnostics' && req.method === 'GET') {
    const distro = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('distro') ?? '';
    readWslDiagnostics(distro).then(
      (diagnostics) => send(res, 200, diagnostics),
      (error: unknown) => send(res, 400, { error: error instanceof Error ? error.message : 'WSL diagnostics unavailable.' }),
    );
    return;
  }
  if (pathname === '/wsl/catalog' && req.method === 'GET') {
    readWslCatalog(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('refresh') === '1').then(
      (catalog) => send(res, 200, catalog),
      () => send(res, 503, { supported: false, items: [], error: 'La liste des distributions WSL est indisponible.' }),
    );
    return;
  }
  if (pathname === '/wsl/config' && req.method === 'GET') {
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
    const kind = query.get('kind') === 'distribution' ? 'distribution' : 'global';
    const distro = query.get('distro') ?? undefined;
    readWslConfig(kind, distro).then(
      (document) => send(res, 200, document),
      (error: unknown) => send(res, 400, { error: error instanceof Error ? error.message : 'WSL configuration unavailable.' }),
    );
    return;
  }
  if (pathname === '/wsl/config' && req.method === 'POST') {
    readJsonBody(req).then(async (value) => {
      const update = parseWslConfigUpdate(value);
      if (!update) { send(res, 400, { ok: false, message: 'WSL configuration is invalid or its typed confirmation is missing.' }); return; }
      try {
        await saveWslConfig(update);
        send(res, 200, { ok: true });
      } catch (error) {
        send(res, 500, { ok: false, message: error instanceof Error ? error.message : 'Could not save WSL configuration.' });
      }
    });
    return;
  }
  if (pathname === '/wsl/action' && req.method === 'POST') {
    readJsonBody(req).then((value) => {
      const action = parseWslAction(value);
      if (!action) { send(res, 400, { ok: false, message: 'Action WSL invalide ou confirmation manquante.' }); return; }
      pruneWslJobs();
      if ([...wslJobs.values()].filter((job) => job.state === 'running').length >= 3) {
        send(res, 429, { ok: false, message: 'Trop d’opérations WSL sont déjà en cours.' });
        return;
      }
      const id = randomUUID();
      const job: WslJob = { id, action: action.action, state: 'running', message: 'Opération en cours.', startedAt: Date.now(), finishedAt: null };
      wslJobs.set(id, job);
      send(res, 202, job);
      void runWslAction(action).then((result) => {
        job.state = result.ok ? 'succeeded' : 'failed';
        job.message = result.message;
        job.finishedAt = Date.now();
      }, () => {
        job.state = 'failed';
        job.message = 'L’opération WSL a échoué.';
        job.finishedAt = Date.now();
      });
    });
    return;
  }
  const wslJobMatch = pathname.match(/^\/wsl\/jobs\/([0-9a-f-]{36})$/i);
  if (wslJobMatch && req.method === 'GET') {
    const job = wslJobs.get(wslJobMatch[1] ?? '');
    send(res, job ? 200 : 404, job ?? { error: 'not-found' });
    return;
  }
  if (pathname === '/open-storage-settings' && req.method === 'POST' && platform === 'win32') {
    runPowerShell("Start-Process 'ms-settings:storage'", 5_000).then((result) =>
      send(res, result.ok ? 200 : 500, { opened: result.ok }),
    );
    return;
  }
  send(res, 404, { error: 'not-found' });
});

const shutdown = () => {
  sampler.stop();
  server.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(port, '127.0.0.1');
