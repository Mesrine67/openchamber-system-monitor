// Started by OpenChamber with the app's own runtime (Node, Electron as Node, or Bun).
// Listens on 127.0.0.1 only; the host proxies the panel's requests and adds the token.
import http from 'node:http';

import { createCpuMemCollector } from './collectors/cpu-mem.ts';
import { readDisks } from './collectors/disks.ts';
import { createGpuCollector } from './collectors/gpu.ts';
import { currentPlatform, detectContainer } from './env.ts';
import { createSampler } from './sampler.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const platform = currentPlatform();
const container = await detectContainer(platform);
const now = () => Date.now();

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
});

const send = (res: http.ServerResponse, status: number, body: object): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

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
