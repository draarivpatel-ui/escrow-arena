'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');
const App = require('../app.js');
const { createFakeDocument, fakeTarget } = require('./helpers/fake-dom.js');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

function mount(opts) {
  const doc = createFakeDocument();
  const ctl = App.createController(E, doc, Object.assign({ agGrid: null }, opts)).init();
  return { doc, ctl, el: (id) => doc.els[id] };
}

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    if (d.name === '.git' || d.name === 'node_modules') return;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out); else out.push(p);
  });
  return out;
}

function fakeAgGrid() {
  const calls = { created: [], rowData: [] };
  return {
    calls,
    createGrid(el, options) {
      calls.created.push({ el, options });
      return { setGridOption(k, v) { if (k === 'rowData') calls.rowData.push(v); } };
    }
  };
}

/* ---------- static markup ---------- */

test('DOM 01: doctype, lang, charset and viewport are present', () => {
  assert.match(html.trimStart(), /^<!DOCTYPE html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

test('DOM 02: title, description and social tags are descriptive', () => {
  assert.match(html, /<title>EscrowArena[^<]{20,}<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{80,}">/);
  assert.match(html, /property="og:url" content="https:\/\/aariv\.me\/escrow-arena\/"/);
  assert.match(html, /name="twitter:card"/);
});

test('DOM 03: exactly one h1 and no skipped heading levels', () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  for (let i = 1; i < levels.length; i += 1) assert.ok(levels[i] <= levels[i - 1] + 1);
});

test('DOM 04: the three judge shortcut buttons have their exact labels', () => {
  assert.match(html, /id="btn-convene"[^>]*>Convene AI Tribunal</);
  assert.match(html, /id="btn-apply"[^>]*>Apply Tribunal Ruling</);
  assert.match(html, /id="btn-sandbox"[^>]*>Run Sandbox Payloads</);
});

test('DOM 05: AG Grid Community is loaded from a pinned CDN version with an error hook', () => {
  assert.match(html, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/ag-grid-community@32\.3\.3\/dist\/ag-grid-community\.min\.js" onerror="window\.__agGridFailed = true"><\/script>/);
  assert.match(html, /ag-grid-community@32\.3\.3\/styles\/ag-grid\.css/);
  assert.match(html, /ag-grid-community@32\.3\.3\/styles\/ag-theme-quartz\.css/);
});

test('DOM 06: the grid script loads before the engine and app, and no other CDN is used', () => {
  assert.ok(html.indexOf('ag-grid-community.min.js') < html.indexOf('engine.js'));
  assert.ok(html.indexOf('engine.js') < html.indexOf('app.js'));
  const hosts = new Set([...html.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map((m) => m[1]));
  ['cdn.jsdelivr.net', 'aariv.me', 'www.w3.org'].forEach((h) => hosts.delete(h));
  assert.deepEqual([...hosts], []);
});

test('DOM 07: both ledger views exist so the fallback is always available', () => {
  assert.match(html, /id="ledger-grid"[^>]*class="ag-theme-quartz"/);
  assert.match(html, /id="ledger-table"/);
  assert.match(html, /id="ledger-fallback"/);
});

test('DOM 08: core regions and controls have the ids the controller needs', () => {
  ['case-select', 'btn-file', 'btn-next', 'ruling-slider', 'split-readout', 'flag-buttons', 'agent-cards', 'score-total', 'step-tabs', 'payload-request', 'payload-response', 'paypal-token', 'btn-live', 'latency-canvas', 'result-banner'].forEach((id) => {
    assert.ok(html.includes('id="' + id + '"'), id);
  });
});

test('DOM 09: every form control has a label and the slider has a range', () => {
  ['case-select', 'ruling-slider', 'paypal-token'].forEach((id) => assert.match(html, new RegExp('<label[^>]*for="' + id + '"'), id));
  assert.match(html, /id="ruling-slider" type="range" min="0" max="10000" step="50"/);
});

test('DOM 10: live regions, canvas alternative and table captions support assistive tech', () => {
  assert.ok((html.match(/aria-live="polite"/g) || []).length >= 4);
  assert.match(html, /<canvas id="latency-canvas"[^>]*role="img"[^>]*aria-label="[^"]+"/);
  assert.match(html, /<table class="mini" aria-label="Milestones">/);
});

test('DOM 11: stylesheet honours reduced motion, focus and 44px targets', () => {
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.btn\s*\{[^}]*min-height: 44px/);
  assert.match(css, /\.chip\s*\{[^}]*min-height: 44px/);
});

test('DOM 12: the sandbox token field is a password input with a non-credential placeholder', () => {
  assert.match(html, /id="paypal-token" type="password"/);
  assert.match(html, /placeholder="paste-your-paypal-sandbox-token"/);
});

/* ---------- repository hygiene ---------- */

const textFiles = () => walk(root, []).filter((f) => !/\.(png|jpg|jpeg|gif|ico|woff2?)$/i.test(f));

test('DOM 13: no em dashes or en dashes anywhere in the repository', () => {
  const re = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  textFiles().forEach((f) => assert.ok(!re.test(fs.readFileSync(f, 'utf8')), path.relative(root, f)));
});

test('DOM 14: no emoji or pictographs anywhere in the repository', () => {
  textFiles().forEach((f) => assert.ok(!/\p{Extended_Pictographic}/u.test(fs.readFileSync(f, 'utf8')), path.relative(root, f)));
});

test('DOM 15: no personal contact details, school names or city locators', () => {
  const banned = [['draarivpatel', '@gm', 'ail'], ['pro', 'roblox'], ['Dul', 'les'], ['Fort Set', 'tlement'], ['Sugar', ' Land'], ['Tany', 'ard'], ['@ya', 'hoo\\.']]
    .map((parts) => new RegExp(parts.join(''), 'i'));
  textFiles().forEach((f) => {
    const t = fs.readFileSync(f, 'utf8');
    banned.forEach((re) => assert.ok(!re.test(t), re + ' in ' + path.relative(root, f)));
  });
});

test('DOM 16: no uppercase kicker styling and no vendor-shaped credentials in any file', () => {
  assert.ok(!/text-transform:\s*uppercase/i.test(css));
  textFiles().forEach((f) => {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/A21AA[A-Za-z0-9_-]{20,}/.test(t), path.relative(root, f));
    assert.ok(!/\b(sk-|ghp_|github_pat_|AKIA|xox[bp]-)[A-Za-z0-9]/.test(t), path.relative(root, f));
  });
});

test('DOM 17: required documents exist and package.json uses the bare test script', () => {
  ['LICENSE', 'README.md', 'NOTES.md', '.nojekyll'].forEach((f) => assert.ok(fs.existsSync(path.join(root, f)), f));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test');
  assert.deepEqual(pkg.dependencies || {}, {});
});

test('DOM 18: README states the simulation boundary and AI assistance plainly', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /AI disclosure/i);
  assert.match(readme, /simulated/i);
  assert.match(readme, /no live PayPal (call|request)/i);
});

/* ---------- controller behaviour on the fake DOM ---------- */

test('DOM 19: init renders the first dispute with contract, claim and evidence', () => {
  const { el } = mount();
  assert.match(el('case-title').textContent, /Cold Feet After Approval/);
  assert.match(el('milestone-rows').innerHTML, /DISPUTED/);
  assert.match(el('milestone-rows').innerHTML, /RELEASED/);
  assert.match(el('claim-box').innerHTML, /refund demand 10000 bps/);
  assert.match(el('spec-evidence').innerHTML, /src\/checkout\.js/);
  assert.match(el('dispute-log').innerHTML, /Approved for release/);
});

test('DOM 20: the case selector lists all six disputes', () => {
  const { el } = mount();
  assert.equal((el('case-select').innerHTML.match(/<option/g) || []).length, 6);
});

test('DOM 21: the fake grid-less environment falls back to the accessible table', () => {
  const { ctl, el } = mount();
  assert.equal(ctl.ledgerMode, 'table');
  assert.equal(el('ledger-fallback').hidden, false);
  assert.equal(el('ledger-grid').hidden, true);
  assert.match(el('ledger-table').innerHTML, /<th scope="col">Amount \(USD\)<\/th>/);
  assert.match(el('ledger-mode').textContent, /fallback/);
});

test('DOM 22: with AG Grid present the grid is created with the ledger columns and fed rows', () => {
  const ag = fakeAgGrid();
  const { ctl, el } = mount({ agGrid: ag });
  assert.equal(ctl.ledgerMode, 'ag-grid');
  assert.equal(ag.calls.created.length, 1);
  assert.equal(ag.calls.created[0].options.columnDefs, E.LEDGER_COLUMNS);
  assert.ok(ag.calls.rowData.length >= 1);
  assert.equal(el('ledger-grid').hidden, false);
  assert.equal(el('ledger-fallback').hidden, true);
  assert.match(el('ledger-mode').textContent, /AG Grid Community/);
});

test('DOM 23: the grid receives fresh rows when the tribunal convenes', () => {
  const ag = fakeAgGrid();
  const { el } = mount({ agGrid: ag });
  const before = ag.calls.rowData[ag.calls.rowData.length - 1].length;
  el('btn-convene').dispatch('click');
  const after = ag.calls.rowData[ag.calls.rowData.length - 1].length;
  assert.equal(after - before, 5);
});

test('DOM 24: a broken AG Grid object without createGrid also falls back to the table', () => {
  const { ctl } = mount({ agGrid: {} });
  assert.equal(ctl.ledgerMode, 'table');
});

test('DOM 25: Convene AI Tribunal fills the three agent cards', () => {
  const { el } = mount();
  assert.match(el('agent-cards').innerHTML, /Idle\. Press Convene/);
  el('btn-convene').dispatch('click');
  const h = el('agent-cards').innerHTML;
  assert.match(h, /Spec coverage/);
  assert.match(h, /Measured p95/);
  assert.match(h, /Capture/);
  assert.ok(!/Idle\./.test(h));
});

test('DOM 26: Apply Tribunal Ruling sets the slider, flags and split readout', () => {
  const { ctl, el } = mount();
  el('btn-apply').dispatch('click');
  assert.equal(ctl.ruling.captureBps, 10000);
  assert.deepEqual(ctl.ruling.flags, ['refund_fraud']);
  assert.equal(el('ruling-slider').value, '10000');
  assert.match(el('split-readout').innerHTML, /\$3000\.00/);
  assert.match(el('flag-buttons').innerHTML, /data-arg="refund_fraud" aria-pressed="true"/);
});

test('DOM 27: dragging the slider updates the dollar split live and snaps to 50 bps', () => {
  const { ctl, el } = mount();
  el('ruling-slider').dispatch('input', { target: { value: '6333' } });
  assert.equal(ctl.ruling.captureBps, 6350);
  assert.match(el('split-readout').innerHTML, /6350 bps/);
  assert.match(el('split-readout').innerHTML, /3650 bps/);
});

test('DOM 28: flag chips toggle through event delegation', () => {
  const { ctl, el } = mount();
  el('flag-buttons').dispatch('click', { target: fakeTarget({ act: 'flag', arg: 'sla_breach' }) });
  assert.deepEqual(ctl.ruling.flags, ['sla_breach']);
  el('flag-buttons').dispatch('click', { target: fakeTarget({ act: 'flag', arg: 'sla_breach' }) });
  assert.deepEqual(ctl.ruling.flags, []);
  assert.equal(ctl.toggleFlag('not_a_flag'), false);
});

test('DOM 29: filing a ruling scores it, settles the escrow and shows the result banner', () => {
  const { ctl, el } = mount();
  el('btn-apply').dispatch('click');
  el('btn-file').dispatch('click');
  assert.equal(el('result-banner').hidden, false);
  assert.match(el('result-banner').innerHTML, /Ruling filed/);
  assert.match(el('milestone-rows').innerHTML, /RELEASED/);
  assert.equal(ctl.escrow.milestones[1].state, 'RELEASED');
  assert.equal(el('btn-file').disabled, true);
  assert.equal(ctl.results['cold-feet'].errorBps, 0);
});

test('DOM 30: a poor ruling gets the warning style and a low score', () => {
  const { ctl, el } = mount();
  el('ruling-slider').dispatch('input', { target: { value: '0' } });
  el('btn-file').dispatch('click');
  assert.match(el('result-banner').className, /warn/);
  assert.ok(ctl.filed.score < 100);
});

test('DOM 31: the score tracker accumulates across disputes and ranks the total', () => {
  const { ctl, el } = mount();
  el('btn-apply').dispatch('click');
  el('btn-file').dispatch('click');
  el('btn-next').dispatch('click');
  assert.equal(ctl.caseObj.id, 'extra-dashboard');
  el('btn-apply').dispatch('click');
  el('btn-file').dispatch('click');
  assert.match(el('score-total').textContent, /2 of 6 disputes ruled/);
  assert.match(el('score-list').innerHTML, /not ruled/);
});

test('DOM 32: Next dispute cycles around after the last case', () => {
  const { ctl } = mount();
  for (let i = 0; i < 6; i += 1) ctl.nextCase();
  assert.equal(ctl.caseObj.id, E.CASES[0].id);
});

test('DOM 33: Run Sandbox Payloads lists every request in the lifecycle', () => {
  const { el } = mount();
  el('btn-sandbox').dispatch('click');
  const tabs = el('step-tabs').innerHTML;
  assert.match(tabs, /Create order/);
  assert.match(tabs, /Authorize order/);
  assert.match(tabs, /Capture ruling amount/);
  assert.match(tabs, /Pay seller/);
});

test('DOM 34: the inspector shows the selected request and a SIM response', () => {
  const { el } = mount();
  el('btn-sandbox').dispatch('click');
  assert.equal(el('payload-title').textContent, 'POST /v2/checkout/orders');
  assert.match(el('payload-request').textContent, /"intent": "AUTHORIZE"/);
  assert.match(el('payload-request').textContent, /Bearer <token>/);
  assert.match(el('payload-response').textContent, /HTTP 201/);
  assert.match(el('payload-response').textContent, /SIM-ORD-/);
});

test('DOM 35: clicking a step tab switches the inspector', () => {
  const { el } = mount();
  el('step-tabs').dispatch('click', { target: fakeTarget({ act: 'step', arg: '2' }) });
  assert.match(el('payload-title').textContent, /\/v2\/payments\/authorizations\/SIM-AUTH-[0-9A-F]+\/capture/);
});

test('DOM 36: moving the slider rewrites the capture request amount', () => {
  const { el } = mount();
  el('ruling-slider').dispatch('input', { target: { value: '5000' } });
  el('step-tabs').dispatch('click', { target: fakeTarget({ act: 'step', arg: '3' }) });
  assert.match(el('payload-title').textContent, /\/capture$/);
  assert.match(el('payload-request').textContent, /"value": "1500\.00"/);
  el('ruling-slider').dispatch('input', { target: { value: '2000' } });
  assert.match(el('payload-request').textContent, /"value": "600\.00"/);
});

test('DOM 37: capture-intent cases show a refund request instead of a capture', () => {
  const { ctl, el } = mount();
  ctl.loadCase('extra-dashboard');
  el('ruling-slider').dispatch('input', { target: { value: '7000' } });
  assert.match(el('step-tabs').innerHTML, /Refund ruling amount/);
  assert.ok(!/Authorize order/.test(el('step-tabs').innerHTML));
});

test('DOM 38: the ledger gains paypal rows after filing a ruling', () => {
  const { ctl, el } = mount();
  const before = ctl.ledgerRows.filter((r) => r.type === 'PAYPAL').length;
  el('btn-apply').dispatch('click');
  el('btn-file').dispatch('click');
  assert.equal(before, 0);
  assert.ok(ctl.ledgerRows.filter((r) => r.type === 'PAYPAL').length >= 3);
  assert.match(el('ledger-table').innerHTML, /RULING/);
});

test('DOM 39: live mode is armed by a token and the status line says so', () => {
  const { ctl, el } = mount();
  assert.match(el('live-status').textContent, /simulated sandbox/);
  el('paypal-token').dispatch('input', { target: { value: ' paste-your-paypal-sandbox-token ' } });
  assert.equal(ctl.token, 'paste-your-paypal-sandbox-token');
  assert.match(el('live-status').textContent, /live sandbox armed/);
});

test('DOM 40: sending without a token makes no network call', async () => {
  let calls = 0;
  const { ctl } = mount({ fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => '{}' }; } });
  const res = await ctl.sendLive();
  assert.equal(res.reason, 'no-token');
  assert.equal(calls, 0);
});

test('DOM 41: sending with a token posts the selected request to the sandbox host only', async () => {
  let seen;
  const { ctl, el } = mount({ fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 201, text: async () => '{"id":"LIVE-1"}' }; } });
  ctl.setToken('paste-your-paypal-sandbox-token');
  const res = await ctl.sendLive();
  assert.equal(res.ok, true);
  assert.equal(seen.url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
  assert.equal(seen.init.headers.Authorization, 'Bearer paste-your-paypal-sandbox-token');
  assert.match(el('live-status').textContent, /live sandbox responded 201/);
});

test('DOM 42: the latency canvas is drawn with an SLA line and a descriptive label', () => {
  const { el } = mount();
  const calls = el('latency-canvas').ctx.calls;
  assert.ok(calls.some((c) => c[0] === 'setLineDash'));
  assert.ok(calls.some((c) => c[0] === 'fillText' && /SLA 500 ms/.test(c[1])));
  assert.match(el('latency-canvas').attrs['aria-label'], /measured p95 410 ms/);
});

test('DOM 43: esc neutralises markup and drawLatency stays inside the canvas', () => {
  assert.equal(App.esc('<i>"&"</i>'), '&lt;i&gt;&quot;&amp;&quot;&lt;/i&gt;');
  const rec = [];
  const ctx = new Proxy({}, { get: (_, k) => (...a) => rec.push([k, ...a]), set: () => true });
  App.drawLatency(ctx, [100, 200, 300], 250, 520, 150);
  rec.filter((r) => r[0] === 'moveTo' || r[0] === 'lineTo').forEach((r) => {
    assert.ok(r[1] >= 0 && r[1] <= 520);
    assert.ok(r[2] >= 0 && r[2] <= 150);
  });
});

test('DOM 44: switching dispute resets the tribunal, ruling and result banner', () => {
  const { ctl, el } = mount();
  el('btn-apply').dispatch('click');
  el('btn-file').dispatch('click');
  el('case-select').dispatch('change', { target: { value: 'slow-endpoint' } });
  assert.equal(ctl.convened, null);
  assert.equal(ctl.filed, null);
  assert.equal(el('result-banner').hidden, true);
  assert.equal(el('btn-file').disabled, false);
  assert.equal(el('ruling-slider').value, '5000');
});
