/*
 * EscrowArena headless Chromium audit.
 * Drives chrome-headless-shell over the DevTools protocol with zero
 * dependencies (Node built-in WebSocket). Checks at 1440x900 and 390x844:
 * console errors, page exceptions, failed or unexpected external requests,
 * horizontal overflow, and the lab self-test bundle running live in the
 * browser. Writes a screenshot per viewport to /tmp.
 *
 * Usage: node headless-audit.mjs
 *   CHROME_BIN overrides the browser binary path.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pageUrl = 'file://' + join(root, 'index.html');

const CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(process.env.HOME || '', 'Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
  join(process.env.HOME || '', 'Library/Caches/ms-playwright/chromium-1223/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
].filter(Boolean);

const chromeBin = CANDIDATES.find((p) => existsSync(p));
if (!chromeBin) {
  console.error('no Chrome or chrome-headless-shell binary found; set CHROME_BIN');
  process.exit(2);
}

const checks = [];
function check(id, ok, detail) {
  checks.push({ id, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + id + (detail ? ' | ' + detail : ''));
}

const ALLOWED_HOSTS = new Set(['cdn.jsdelivr.net']);
const profile = mkdtempSync(join(tmpdir(), 'ea-audit-'));
let chrome = null;
let ws = null;
const pending = new Map();
const events = [];
let seq = 0;

function send(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });
}
function onEvent(sessionId, method, params) {
  events.push({ sessionId, method, params });
}

async function waitFor(method, sessionId, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const hit = events.find((e) => e.method === method && (!sessionId || e.sessionId === sessionId));
    if (hit) return hit;
    if (Date.now() - start > (timeoutMs || 15000)) throw new Error('timeout waiting for ' + method);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function evaluate(sessionId, expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (res.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
  return res.result.value;
}

async function main() {
  chrome = spawn(chromeBin, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--hide-scrollbars', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('no DevTools endpoint in 15s')), 15000);
    chrome.stderr.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    chrome.on('exit', () => reject(new Error('chrome exited early')));
  });

  await new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws connect failed'));
  });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    } else if (msg.method) {
      onEvent(msg.sessionId, msg.method, msg.params);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const dom of ['Runtime', 'Page', 'Network', 'Log']) await send(dom + '.enable', {}, sessionId);

  const viewports = [
    { name: '1440x900', width: 1440, height: 900, mobile: false, shot: '/tmp/escrow-arena-1440.png' },
    { name: '390x844', width: 390, height: 844, mobile: true, shot: '/tmp/escrow-arena-390.png' }
  ];

  for (const vp of viewports) {
    events.length = 0;
    await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile }, sessionId);
    const start = events.length;
    await send('Page.navigate', { url: pageUrl }, sessionId);
    await waitFor('Page.loadEventFired', sessionId, 20000);
    await new Promise((r) => setTimeout(r, 1200));

    const mine = events.slice(start);
    const consoleErr = mine.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
    const pageErr = mine.filter((e) => e.method === 'Runtime.exceptionThrown');
    const logErr = mine.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
    const reqFail = mine.filter((e) => e.method === 'Network.loadingFailed');
    const reqUrls = mine.filter((e) => e.method === 'Network.requestWillBeSent').map((e) => e.params.request.url);
    const external = reqUrls.filter((u) => /^https?:/.test(u));
    const badHosts = [...new Set(external.map((u) => { try { return new URL(u).host; } catch { return u; } }).filter((h) => !ALLOWED_HOSTS.has(h)))];

    check(vp.name + ' console errors', consoleErr.length === 0, consoleErr.map((e) => JSON.stringify(e.params.args).slice(0, 120)).join('; '));
    check(vp.name + ' page errors', pageErr.length === 0, pageErr.map((e) => String(e.params.exceptionDetails.text)).join('; '));
    check(vp.name + ' log errors', logErr.length === 0, logErr.map((e) => e.params.entry.text.slice(0, 120)).join('; '));
    check(vp.name + ' failed requests', reqFail.length === 0, reqFail.map((e) => (e.params.errorText + ' ' + (e.params.blockedReason || ''))).join('; '));
    check(vp.name + ' external hosts limited to pinned CDN', badHosts.length === 0, 'external: ' + (external.length ? [...new Set(external.map((u) => new URL(u).host))].join(',') : 'none'));

    const probe = await evaluate(sessionId, `JSON.stringify({
      overflowX: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) - window.innerWidth,
      cells: document.querySelectorAll('#lab-matrix .mcell').length,
      lines: document.querySelectorAll('#lab-chart polyline').length,
      chips: document.querySelectorAll('#lab-test-chips .verify-chip.ok').length,
      chipsBad: document.querySelectorAll('#lab-test-chips .verify-chip.bad').length,
      threshold: /deters at 92.5%/.test(document.getElementById('lab-chart').innerHTML),
      conserve: /exact\\./.test(document.getElementById('lab-detail').textContent),
      score925: /92\\.5%/.test(document.getElementById('lab-score').innerHTML),
      matrixWrapScrolls: (function(){ const w = document.querySelector('.lab-matrix-wrap'); return w ? w.scrollWidth - w.clientWidth : -1; })(),
      selfTests: window.EscrowArenaMech.selfTests().allPass,
      mods: !!(window.EscrowArena && window.EscrowArenaMech && window.EscrowArenaApp && window.EscrowArenaMechUI),
      caseSel: document.getElementById('case-select').options.length
    })`);
    const p = JSON.parse(probe);

    check(vp.name + ' no horizontal page overflow', p.overflowX <= 0, 'overflowX ' + p.overflowX + 'px');
    check(vp.name + ' payoff matrix renders 30 cells', p.cells === 30, String(p.cells));
    check(vp.name + ' threshold chart draws 5 curves', p.lines === 5, String(p.lines));
    check(vp.name + ' self-test chips all OK in browser', p.chips === 12 && p.chipsBad === 0, p.chips + ' ok ' + p.chipsBad + ' bad');
    check(vp.name + ' deterrence threshold label rendered', p.threshold, '');
    check(vp.name + ' detail ledger proves exact conservation', p.conserve, '');
    check(vp.name + ' scoreboard shows 92.5 percent jury threshold', p.score925, '');
    check(vp.name + ' module self-tests pass live in browser', p.selfTests === true, '');
    check(vp.name + ' all four modules present', p.mods, '');
    check(vp.name + ' six disputes selectable', p.caseSel === 6, String(p.caseSel));
    if (vp.mobile) {
      check(vp.name + ' matrix scrolls inside its wrap, not the page', p.matrixWrapScrolls > 0 && p.overflowX <= 0, 'wrap scroll ' + p.matrixWrapScrolls + 'px');
    }

    await evaluate(sessionId, "document.getElementById('h-lab').scrollIntoView({block:'start'}); 'scrolled'");
    await new Promise((r) => setTimeout(r, 300));
    const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(vp.shot, Buffer.from(shot.data, 'base64'));
    console.log('  screenshot: ' + vp.shot);
  }
}

main().then(() => {
  const failed = checks.filter((c) => !c.ok);
  console.log('---');
  console.log('checks: ' + checks.length + ', pass: ' + (checks.length - failed.length) + ', fail: ' + failed.length);
  process.exitCode = failed.length ? 1 : 0;
}).catch((err) => {
  console.error('audit crashed: ' + (err && err.message));
  process.exitCode = 2;
}).finally(async () => {
  try { if (ws) ws.close(); } catch {}
  try { if (chrome) chrome.kill('SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
});
