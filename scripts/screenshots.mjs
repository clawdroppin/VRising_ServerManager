// Regenerates docs/screenshots/*.png from the browser preview (mock backend).
// Usage: npm run dev   (in another terminal)   then   node scripts/screenshots.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'docs', 'screenshots');
mkdirSync(out, { recursive: true });
const URL = process.env.SHOTS_URL ?? 'http://localhost:1460/';
const PORT = 9555;
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!edge) throw new Error('Microsoft Edge not found');

const profile = mkdtempSync(join(tmpdir(), 'vrsm-shots-'));
const browser = spawn(edge, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,900', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets = [];
for (let i = 0; i < 40 && !targets.length; i++) {
  await sleep(250);
  try {
    targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page');
  } catch {}
}
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  pending.get(d.id)?.(d);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true });

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
await sleep(2500);

const SERVER = 'a1b2c3d4-0001';
const shots = [
  { name: 'dashboard', active: 'home' },
  { name: 'overview', view: 'overview' },
  { name: 'performance', view: 'performance', wait: 9000 },
  { name: 'console', view: 'console', wait: 5000 },
  { name: 'settings', view: 'settings' },
  { name: 'port-forwarding', view: 'ports' },
  { name: 'game-rules', view: 'gameplay' },
  { name: 'admins', view: 'access' },
  { name: 'players', view: 'players' },
  { name: 'worlds', view: 'worlds' },
  { name: 'backups', view: 'backups' },
  { name: 'automation', view: 'automation' },
  { name: 'health', view: 'health' },
];
for (const s of shots) {
  const ui = s.active === 'home' ? { tabs: [SERVER], active: 'home', views: {} } : { tabs: [SERVER, 'a1b2c3d4-0002'], active: SERVER, views: { [SERVER]: s.view } };
  await evaluate(`localStorage.setItem('vrsm.ui', ${JSON.stringify(JSON.stringify(ui))}); location.reload();`);
  await sleep(s.wait ?? 3500);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, `${s.name}.png`), Buffer.from(r.result.data, 'base64'));
  console.log('✓', s.name);
}
ws.close();
browser.kill();
