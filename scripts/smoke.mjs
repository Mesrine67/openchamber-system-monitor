// Starts the built service the way OpenChamber does (port + token in the
// environment, nothing else inherited) and checks a real `/stats` answer.
//
//   node scripts/smoke.mjs                 # runtime: this node
//   SMOKE_RUNTIME=bun node scripts/smoke.mjs
//   EXPECT_CONTAINER=1 EXPECT_LIMIT_CORES=1 EXPECT_MEMORY_TOTAL=536870912 node scripts/smoke.mjs
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../dist/service/main.js', import.meta.url));
const runtime = process.env.SMOKE_RUNTIME || process.execPath;

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const port = await freePort();
const token = randomBytes(16).toString('hex');
// OpenChamber passes only these through (INHERITED_SERVICE_ENV_NAMES in its
// server/lib/guests/service.js); everything else must work without them.
const inherited = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'TZ',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'WINDIR',
]);
const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value && inherited.has(name.toUpperCase())));
const child = spawn(runtime, [entry], {
  env: { ...env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const fail = (message) => {
  console.error(`SMOKE FAIL: ${message}`);
  child.kill();
  process.exit(1);
};

const request = async (path, { method = 'GET', body, auth = true } = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json() };
};
const get = (path, auth = true) => request(path, { auth });

const deadline = Date.now() + 15_000;
for (;;) {
  try {
    if ((await get('/health')).status === 200) break;
  } catch {
    // not listening yet
  }
  if (Date.now() > deadline) fail('service did not become ready');
  await new Promise((resolve) => setTimeout(resolve, 200));
}

if ((await get('/stats', false)).status !== 401) fail('/stats answered without the token');
if ((await request('/settings', { method: 'POST', body: '{}', auth: false })).status !== 401) fail('/settings answered without the token');

const first = await get('/stats');
if (first.status !== 200) fail(`/stats answered ${first.status}`);
// Wait for another completed tick; Windows' one-time collectors can make a
// sampling turn longer than the nominal 2-second timer interval.
let stats = first.body;
for (let attempt = 0; attempt < 20 && stats.history?.cpu?.length < 2; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const next = await get('/stats');
  if (next.status !== 200) fail(`/stats answered ${next.status}`);
  stats = next.body;
}
if (stats.history.cpu.length < 2) fail('history did not grow after completed sampling ticks');

const updated = await request('/settings', {
  method: 'POST',
  body: JSON.stringify({ paused: false, refreshSeconds: 5, historyMinutes: 30, processLimit: 5, modules: { network: true, processes: true, battery: true, sensors: true } }),
});
if (updated.status !== 200 || updated.body.ok !== true) fail('/settings rejected valid bounded settings');
let configured;
for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  configured = await get('/stats');
  if (configured.status === 200 && configured.body.history.sampleIntervalMs === 30_000) break;
}
if (configured?.status !== 200 || configured.body.history.sampleIntervalMs !== 30_000) {
  fail(`history window did not apply to sampler (interval ${configured?.body?.history?.sampleIntervalMs ?? 'unavailable'})`);
}

// Let staggered collectors reach their first result. Optional sources may
// legitimately be unsupported, but must not remain in the initial pending state.
const optionalKeys = ['network', 'processes', 'battery', 'sensors', 'diskActivity'];
for (let attempt = 0; attempt < 16; attempt += 1) {
  const pending = optionalKeys.some((key) => stats[key].status === 'unavailable' && stats[key].reason === 'pending');
  if (!pending) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const next = await get('/stats');
  if (next.status !== 200) fail(`/stats answered ${next.status}`);
  stats = next.body;
}
if (optionalKeys.some((key) => stats[key].status === 'unavailable' && stats[key].reason === 'pending')) {
  fail('one or more optional collectors remained pending after their startup window');
}

const summary = {
  runtime,
  environment: {
    platform: stats.environment.platform,
    container: stats.environment.container,
    operatingSystem: stats.environment.computer?.operatingSystem ?? null,
    architecture: stats.environment.computer?.architecture ?? null,
  },
  cpu: stats.cpu.status === 'ok'
    ? { total: Math.round(stats.cpu.total), cores: stats.cpu.cores, perCore: stats.cpu.perCore.length, load: stats.cpu.load, limitCores: stats.cpu.limitCores }
    : stats.cpu,
  memory: stats.memory.status === 'ok' ? { totalBytes: stats.memory.total, usedBytes: stats.memory.used, swapAvailable: stats.memory.swapTotal !== null } : stats.memory,
  gpus: stats.gpus.status === 'ok' ? { count: stats.gpus.devices.length } : stats.gpus,
  disks: stats.disks.status === 'ok' ? { count: stats.disks.items.length } : stats.disks,
  optionalSources: Object.fromEntries(optionalKeys.map((key) => [key, stats[key].status === 'ok' ? 'ok' : `${stats[key].reason}${stats[key].tool ? ` (${stats[key].tool})` : ''}`])),
  history: { cpu: stats.history.cpu.length, gpu: stats.history.gpu.length },
  configuredHistory: { points: configured.body.history.cpu.length, intervalMs: configured.body.history.sampleIntervalMs },
  warnings: stats.warnings,
};
console.log(JSON.stringify(summary, null, 2));

for (const key of ['cpu', 'memory', 'disks']) {
  if (stats[key].status !== 'ok') fail(`${key} is ${stats[key].reason}`);
}
if (!['ok', 'unavailable'].includes(stats.gpus.status)) fail('gpus has no status');
if (stats.disks.items.length === 0) fail('no disks reported');
if (stats.memory.used <= 0 || stats.memory.used > stats.memory.total) fail('memory values are implausible');
if (process.env.EXPECT_CONTAINER && stats.environment.container !== (process.env.EXPECT_CONTAINER === '1')) {
  fail(`container is ${stats.environment.container}`);
}
if (process.env.EXPECT_LIMIT_CORES && stats.cpu.limitCores !== Number(process.env.EXPECT_LIMIT_CORES)) {
  fail(`limitCores is ${stats.cpu.limitCores}`);
}
if (process.env.EXPECT_MEMORY_TOTAL && stats.memory.total !== Number(process.env.EXPECT_MEMORY_TOTAL)) {
  fail(`memory total is ${stats.memory.total}`);
}

child.kill();
console.log('SMOKE OK');
