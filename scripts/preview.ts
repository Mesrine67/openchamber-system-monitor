// Preview both frames in a normal browser, without OpenChamber.
//
//   bun run preview            # http://127.0.0.1:4790
//   bun run preview -- 4800    # another port
//
// A minimal stand-in for the host: it loads the built frames in sandboxed
// iframes, answers the SDK handshake with a theme and locale, and passes
// `/stats` to a real service started from dist/. Run `bun run build` first.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const port = Number(process.argv[2] ?? 4790);
const servicePort = port + 1;
const token = randomBytes(16).toString('hex');

const service = spawn(process.execPath, [resolve(root, 'dist/service/main.js')], {
  env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(servicePort), OPENCHAMBER_SERVICE_TOKEN: token },
  stdio: ['ignore', 'inherit', 'inherit'],
});
process.on('exit', () => service.kill());
process.on('SIGINT', () => process.exit(0));

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>System Monitor preview</title>
<style>
  body{margin:0;padding:20px;font:13px -apple-system,system-ui,sans-serif;display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
  body.dark{background:#151313;color:#c9c5ba} body.light{background:#f4f2ee;color:#222}
  .box{border:1px solid #8884;border-radius:12px;overflow:hidden}
  .box h3{margin:0;padding:8px 12px;font-size:12px;border-bottom:1px solid #8884}
  iframe{display:block;border:0;background:transparent}
  #panel{width:360px;height:720px} #status{width:280px;height:96px;margin:8px 12px}
  .controls{width:100%;display:flex;gap:8px} button,select{font:inherit}
</style></head>
<body class="dark">
  <div class="controls">
    <button id="theme">Toggle theme</button>
    <select id="locale">${['en', 'de', 'es', 'fr', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'tr', 'uk', 'zh-CN', 'zh-TW'].map((l) => `<option>${l}</option>`).join('')}</select>
    <span id="badge"></span>
  </div>
  <div class="box"><h3>System Monitor</h3><iframe id="panel" sandbox="allow-scripts" src="/dist/panel/index.html"></iframe></div>
  <div class="box"><h3>System</h3><iframe id="status" sandbox="allow-scripts" src="/dist/status/index.html"></iframe></div>
<script>
const themes = {
  dark: { background:'#151313', elevated:'#1d1b1b', foreground:'#c9c5ba', muted:'#8a857c', subtle:'#2a2727', border:'#2f2c2c',
    hover:'#262323', selection:'#3a3330', focus:'#d98a5a', primary:'#d98a5a', mutedSurface:'#1a1818', elevatedForeground:'#c9c5ba',
    active:'#302c2c', selectionForeground:'#f0ece4', primaryForeground:'#1a1310', primaryText:'#e09a6e', successText:'#7fc28a',
    warningText:'#e3b85c', errorText:'#e57a6e', infoText:'#7fb0e0', success:'#5fa86c', warning:'#d4a03c', error:'#d4604f', info:'#5a90c8',
    font:'-apple-system, system-ui, sans-serif', mono:'ui-monospace, monospace', radius:'8px' },
  light: { background:'#ffffff', elevated:'#ffffff', foreground:'#2a2622', muted:'#77716a', subtle:'#eeeae4', border:'#e2ddd6',
    hover:'#f2eee8', selection:'#f5dccb', focus:'#c26a35', primary:'#c26a35', mutedSurface:'#f6f3ef', elevatedForeground:'#2a2622',
    active:'#e9e4dc', selectionForeground:'#2a2622', primaryForeground:'#ffffff', primaryText:'#a8561f', successText:'#2f7a3d',
    warningText:'#8a6510', errorText:'#b23a2c', infoText:'#2c62a0', success:'#3f9a50', warning:'#c9921c', error:'#c94a3a', info:'#3a78c0',
    font:'-apple-system, system-ui, sans-serif', mono:'ui-monospace, monospace', radius:'8px' },
};
let mode = 'dark';
let locale = 'en';
const frames = [['panel', document.getElementById('panel')], ['status', document.getElementById('status')]];
const envelope = { channel: 'openchamber.sdk', v: 1 };
const ready = (surface) => ({ ...envelope, type: 'ready', payload: {
  theme: { mode, tokens: themes[mode] }, locale, directory: null, session: null, surface,
  connection: { connected: false, account: null }, settings: {}, item: null } });
const pushReady = () => { for (const [surface, frame] of frames) frame.contentWindow.postMessage(ready(surface), '*'); };
document.getElementById('theme').onclick = () => { mode = mode === 'dark' ? 'light' : 'dark'; document.body.className = mode; pushReady(); };
document.getElementById('locale').onchange = (event) => { locale = event.target.value; pushReady(); };
addEventListener('message', async (event) => {
  const entry = frames.find(([, frame]) => frame.contentWindow === event.source);
  const message = event.data;
  if (!entry || !message || message.channel !== 'openchamber.sdk') return;
  const [surface, frame] = entry;
  const reply = (body) => frame.contentWindow.postMessage({ ...envelope, type: 'result', id: message.id, ...body }, '*');
  if (message.type === 'hello') { frame.contentWindow.postMessage(ready(surface), '*'); return; }
  if (!message.id) return;
  if (message.type === 'service-request') {
    const response = await fetch('/service' + message.payload.path);
    reply({ ok: true, payload: { status: response.status, body: await response.text() } });
    return;
  }
  if (message.type === 'resize' && surface === 'status') frame.style.height = Math.min(320, Math.max(24, message.payload.height)) + 'px';
  if (message.type === 'badge') document.getElementById('badge').textContent = message.payload.count ? 'Badge: ' + message.payload.count : '';
  reply({ ok: true });
});
</script></body></html>`;

Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
    if (pathname.startsWith('/service/')) {
      return fetch(`http://127.0.0.1:${servicePort}${pathname.slice('/service'.length)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    }
    if (pathname.startsWith('/dist/')) {
      const file = Bun.file(resolve(root, `.${pathname}`));
      if (await file.exists()) return new Response(file);
    }
    return new Response('Not found', { status: 404 });
  },
});

console.log(`System Monitor preview on http://127.0.0.1:${port}`);
