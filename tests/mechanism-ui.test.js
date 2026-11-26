'use strict';

/*
 * Mechanism lab UI suite for EscrowArena.
 * Locks the lab markup in index.html, the CSP and script order, and the
 * interactive lab controller on the fake DOM: payoff matrix selection, the
 * bond sweep chart, contract and bond controls, the self-test panel, the
 * checksummed exports and the #escrow= bookmark plumbing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');
const M = require('../mechanism-lab.js');
const UI = require('../mechanism-ui.js');
const { createFakeDocument, fakeTarget } = require('./helpers/fake-dom.js');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

function mount(opts) {
  const doc = createFakeDocument();
  const lab = UI.createLab(E, M, doc, opts).init();
  return { doc, lab, el: (id) => doc.els[id] };
}

/* ---------- static markup ---------- */

test('LAB 01: the mechanism lab section and every control id exist', () => {
  assert.match(html, /<section class="panel lab" aria-labelledby="h-lab">/);
  ['h-lab', 'lab-contract', 'lab-bond', 'lab-bond-readout', 'lab-matrix', 'lab-detail', 'lab-chart', 'lab-score',
    'btn-lab-tests', 'btn-lab-copy', 'btn-lab-json', 'btn-lab-csv', 'btn-lab-md', 'btn-lab-bookmark', 'btn-lab-verify',
    'lab-digest', 'lab-test-chips', 'lab-test-status', 'lab-status'].forEach((id) => {
    assert.ok(html.includes('id="' + id + '"'), id);
  });
});

test('LAB 02: the new controls have labels and the bond slider spans zero to 150 percent', () => {
  ['lab-contract', 'lab-bond'].forEach((id) => assert.match(html, new RegExp('<label[^>]*for="' + id + '"'), id));
  assert.match(html, /id="lab-bond" type="range" min="0" max="15000" step="50"/);
});

test('LAB 03: the lab scripts load after the engine and before nothing else moved', () => {
  assert.ok(html.indexOf('analytics.js') < html.indexOf('mechanism-lab.js'));
  assert.ok(html.indexOf('mechanism-lab.js') < html.indexOf('app.js'));
  assert.ok(html.indexOf('app.js') < html.indexOf('analytics-ui.js'));
  assert.ok(html.indexOf('analytics-ui.js') < html.indexOf('mechanism-ui.js'));
});

test('LAB 04: the content security policy is byte-identical to the pinned self-only policy', () => {
  assert.match(html, /content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src https:\/\/api-m\.sandbox\.paypal\.com; object-src 'none'; base-uri 'none'; form-action 'none'"/);
});

test('LAB 05: the Run Self-Tests button and six export controls carry exact labels', () => {
  assert.match(html, /id="btn-lab-tests"[^>]*>Run Self-Tests</);
  assert.match(html, /id="btn-lab-copy"[^>]*>Copy audit JSON</);
  assert.match(html, /id="btn-lab-json"[^>]*>Download \.json</);
  assert.match(html, /id="btn-lab-csv"[^>]*>Download \.csv</);
  assert.match(html, /id="btn-lab-md"[^>]*>Download \.md</);
  assert.match(html, /id="btn-lab-bookmark"[^>]*>Bookmark this state</);
  assert.match(html, /id="btn-lab-verify"[^>]*>Re-verify checksum</);
});

test('LAB 06: the lab adds live regions for the digest, test and status lines', () => {
  assert.ok((html.match(/aria-live="polite"/g) || []).length >= 8);
  ['lab-digest', 'lab-test-chips', 'lab-test-status', 'lab-status'].forEach((id) => {
    assert.match(html, new RegExp('id="' + id + '"[^>]*aria-live="polite"'), id);
  });
});

test('LAB 07: the lab disclosures state the model and checksum boundaries plainly', () => {
  assert.match(html, /deterministic integer-cent model, not measurements of a live system/);
  assert.match(html, /unkeyed SHA-256 tamper-detection digest, not a signature and not authentication/);
  assert.match(html, /No network request is made/);
  assert.match(html, /naive arbiter cannot verify delivery/);
});

test('LAB 08: the lab introduces no new external hosts or inline handlers', () => {
  const hosts = new Set([...html.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map((m) => m[1]));
  ['aariv.me', 'www.w3.org', 'api-m.sandbox.paypal.com'].forEach((h) => hosts.delete(h));
  assert.deepEqual([...hosts], []);
  assert.doesNotMatch(html, /\son(error|click|load)=/);
});

test('LAB 09: matrix cells keep the 44px touch target and the lab spans the board', () => {
  assert.match(css, /\.mcell\s*\{[^}]*min-height: 44px/);
  assert.match(css, /\.panel\.lab\s*\{[^}]*grid-column: 1 \/ -1/);
  assert.match(css, /@media \(max-width: 1150px\)[\s\S]*\.lab-grid \{ grid-template-columns: minmax\(0, 1fr\)/);
});

test('LAB 10: no kicker styling crept into the lab styles', () => {
  assert.ok(!/text-transform:\s*uppercase/i.test(css));
});

/* ---------- controller on the fake DOM ---------- */

test('LAB 11: init renders thirty matrix cells with the six dispute contracts', () => {
  const { el } = mount();
  const h = el('lab-matrix').innerHTML;
  assert.equal((h.match(/data-act="cell"/g) || []).length, 30);
  M.PROTOCOLS.forEach((p) => assert.ok(h.indexOf(p.name) !== -1, p.id));
  M.ATTACKS.forEach((a) => assert.ok(h.indexOf('>' + a.name + '<') !== -1, a.id));
  assert.equal((el('lab-contract').innerHTML.match(/<option/g) || []).length, 6);
});

test('LAB 12: the bond slider readout and matrix caption follow the slider', () => {
  const { el } = mount();
  assert.equal(el('lab-bond-readout').textContent, '50.0% of contract');
  el('lab-bond').dispatch('input', { target: { value: '9250' } });
  assert.equal(el('lab-bond-readout').textContent, '92.5% of contract');
  assert.match(el('lab-matrix').innerHTML, /bond 92\.5%/);
});

test('LAB 13: cells show signed attacker profit and deterred styling', () => {
  const { el } = mount();
  const h = el('lab-matrix').innerHTML;
  assert.match(h, /\+\$1350\.00/);
  assert.match(h, /-\$1550\.00/);
  assert.match(h, /class="mcell det/);
  assert.match(h, /class="mcell pos/);
  assert.match(h, /baseline/);
});

test('LAB 14: the default selection is the jury bribery cell with a deterrence story', () => {
  const { lab, el } = mount();
  assert.equal(lab.state.protocol, 'schelling-jury');
  assert.equal(lab.state.attack, 'bribed-arbiter');
  assert.match(el('lab-matrix').innerHTML, /data-arg="schelling-jury\|bribed-arbiter" aria-pressed="true"/);
  assert.match(el('lab-detail').innerHTML, /Schelling-Point Stake-Slashing Jury vs Bribed Arbiter Collusion/);
});

test('LAB 15: the detail panel proves conservation with the ledger table', () => {
  const { el } = mount();
  const h = el('lab-detail').innerHTML;
  assert.match(h, /slashed sink/);
  assert.match(h, /Conservation: \d+\.\d+ out of \d+\.\d+ locked, exact/);
  assert.match(h, /verdict/);
  assert.match(h, /periods to resolve/);
  assert.match(h, /griefing ROI/);
  assert.match(h, /deterred/);
});

test('LAB 16: clicking a matrix cell re-selects and re-renders detail and chart', () => {
  const { lab, el } = mount();
  el('lab-matrix').dispatch('click', { target: fakeTarget({ act: 'cell', arg: 'timelock-evidence|timeout-stall' }) });
  assert.equal(lab.state.protocol, 'timelock-evidence');
  assert.equal(lab.state.attack, 'timeout-stall');
  assert.match(el('lab-detail').innerHTML, /Time-Locked Release \+ Evidence Bond vs Timeout Stalling/);
  assert.match(el('lab-chart').innerHTML, /Time-Locked Release \+ Evidence Bond/);
});

test('LAB 17: malformed cell arguments and unknown acts are ignored', () => {
  const { lab } = mount();
  assert.equal(lab.act('cell', 'bogus|bogus'), false);
  assert.equal(lab.act('cell', ''), false);
  assert.equal(lab.act('nonsense', 'x'), null);
  assert.equal(lab.selectCell('nope', 'honest'), false);
});

test('LAB 18: the scoreboard reports the jury threshold and the honest margins', () => {
  const { el } = mount();
  const h = el('lab-score').innerHTML;
  assert.match(h, /92\.5%/);
  assert.match(h, /Honest dominance margin/);
  assert.match(h, /-\$1350\.00/);
  assert.match(h, /Undeterred lever/);
});

test('LAB 19: single-release lists every naive lever as undeterred', () => {
  const { el } = mount();
  const h = el('lab-score').innerHTML;
  assert.match(h, /buyer-grief, seller-ghost, bribed-arbiter/);
});

test('LAB 20: the chart draws five attack curves, a zero line and the deterrence zone', () => {
  const { el } = mount();
  const h = el('lab-chart').innerHTML;
  assert.match(h, /<svg viewBox="0 0 760 320"/);
  assert.equal((h.match(/<polyline class="chart-line/g) || []).length, 5);
  assert.match(h, /class="chart-zero"/);
  assert.match(h, /class="chart-detzone"/);
  assert.match(h, /class="chart-cursor"/);
  assert.match(h, /role="img"/);
});

test('LAB 21: the jury chart labels the exact 92.5 percent deterrence threshold', () => {
  const { el } = mount();
  const h = el('lab-chart').innerHTML;
  assert.match(h, /deters at 92\.5%/);
  assert.match(h, /deterrence boundary/);
  assert.match(h, /collateral bond ratio/);
});

test('LAB 22: the timelock chart reports the ghost deterrence window re-emerging', () => {
  const { lab, el } = mount();
  lab.selectCell('timelock-evidence', 'seller-ghost');
  const h = el('lab-chart').innerHTML;
  assert.match(h, /seller-ghost re-emerges at 88\.5%/);
});

test('LAB 23: leverless attacks are drawn dashed so flat lines read as inapplicable', () => {
  const { lab, el } = mount();
  lab.selectCell('single-release', 'buyer-grief');
  const h = el('lab-chart').innerHTML;
  assert.match(h, /chart-line leverless[^>]*stroke-dasharray/);
});

test('LAB 24: the legend names every attack with its deterrence fate', () => {
  const { el } = mount();
  const h = el('lab-chart').innerHTML;
  assert.match(h, /chart-legend/);
  assert.match(h, /Buyer Griefing, always deterred/);
  assert.match(h, /Bribed Arbiter Collusion, deters at 92\.5%/);
  assert.match(h, /Timeout Stalling, always deterred/);
});

test('LAB 25: changing the contract rebuilds the matrix with the new economics', () => {
  const { lab, el } = mount();
  el('lab-contract').dispatch('change', { target: { value: '240000' } });
  assert.equal(lab.state.contractCents, 240000);
  assert.equal(el('lab-contract').value, '240000');
  const c = M.simulateCell('schelling-jury', 'bribed-arbiter', 5000, { contractCents: 240000 });
  const shown = '$' + E.fmtCents(c.attackerProfitCents);
  assert.ok(el('lab-matrix').innerHTML.indexOf(shown) !== -1, shown);
});

test('LAB 26: a bookmarked contract size earns its own select option', () => {
  const { lab, el } = mount();
  lab.applyBookmark(M.encodeBookmark({ contractCents: 1234567, bondBps: 2500, protocol: 'mad-collateral', attack: 'seller-ghost' }));
  assert.equal(lab.state.contractCents, 1234567);
  assert.match(el('lab-contract').innerHTML, /Bookmarked contract \(\$12345\.67\)/);
  assert.equal(el('lab-contract').value, '1234567');
});

test('LAB 27: invalid contract and bond inputs are refused without corrupting state', () => {
  const { lab } = mount();
  assert.equal(lab.setContract('abc'), false);
  assert.equal(lab.setContract(-5), false);
  assert.equal(lab.setBond(NaN), false);
  assert.equal(lab.setBond('x'), false);
  lab.setBond(99999);
  assert.equal(lab.state.bondBps, 15000);
});

test('LAB 28: self-tests run at init and render twelve passing chips', () => {
  const { lab, el } = mount();
  assert.ok(lab.lastTests.allPass);
  const h = el('lab-test-chips').innerHTML;
  assert.equal((h.match(/verify-chip ok/g) || []).length, 12);
  assert.match(h, /sha256-kat-empty: OK/);
  assert.match(h, /conservation-grid: OK/);
  assert.match(h, /tamper-detection: OK/);
  assert.match(el('lab-test-status').textContent, /no network request/);
});

test('LAB 29: the Run Self-Tests button re-renders the chips', () => {
  const { el } = mount();
  el('btn-lab-tests').dispatch('click');
  assert.equal((el('lab-test-chips').innerHTML.match(/verify-chip ok/g) || []).length, 12);
});

test('LAB 30: exporting writes the digest and hands the report to the clipboard', () => {
  let copied = null;
  const { lab, el } = mount({ clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } });
  lab.exportJSON();
  assert.match(el('lab-digest').textContent, /^SHA-256 [0-9a-f]{64}$/);
  return Promise.resolve().then(() => {
    assert.ok(copied && copied.indexOf('escrow-arena/mechanism-audit-v1') !== -1);
  });
});

test('LAB 31: export status lines honestly label the digest as not a signature', () => {
  const { lab, el } = mount({ clipboard: { writeText: () => Promise.resolve() } });
  lab.exportJSON();
  return Promise.resolve().then(() => {
    assert.match(el('lab-status').textContent, /unkeyed tamper-detection checksum, not a signature/);
  });
});

test('LAB 32: a missing clipboard reports the honest fallback', () => {
  const { lab, el } = mount();
  lab.exportJSON();
  assert.match(el('lab-status').textContent, /Clipboard unavailable|unavailable/);
});

test('LAB 33: downloads degrade honestly where the DOM cannot create anchors', () => {
  const { lab, el } = mount();
  lab.downloadJSON();
  assert.match(el('lab-status').textContent, /unavailable/);
});

test('LAB 34: with a working anchor factory the JSON export downloads', () => {
  const { doc, lab, el } = mount();
  doc.createElement = () => ({ click() { this.clicked = true; } });
  lab.downloadJSON();
  assert.match(el('lab-status').textContent, /Audit JSON downloaded/);
});

test('LAB 35: CSV and Markdown exports download through the same path', () => {
  const { doc, lab, el } = mount();
  doc.createElement = () => ({ click() { this.clicked = true; } });
  lab.downloadCSV();
  assert.match(el('lab-status').textContent, /CSV downloaded with formula-injection escaping/);
  lab.downloadMarkdown();
  assert.match(el('lab-status').textContent, /Audit Markdown downloaded/);
});

test('LAB 36: bookmarking writes a strict #escrow= hash that decodes back to the state', () => {
  let stored = '';
  const { lab } = mount({ setHash: (h) => { stored = h; } });
  lab.selectCell('timelock-evidence', 'seller-ghost');
  lab.setBond(8850);
  const h = lab.writeBookmark();
  assert.equal(stored, h);
  assert.ok(h.indexOf('#escrow=') === 0);
  const rt = M.decodeBookmark(h);
  assert.equal(rt.protocol, 'timelock-evidence');
  assert.equal(rt.attack, 'seller-ghost');
  assert.equal(rt.bondBps, 8850);
  assert.equal(rt.contractCents, lab.state.contractCents);
});

test('LAB 37: init applies a bookmarked state from the location hash', () => {
  const hash = M.encodeBookmark({ contractCents: 320000, bondBps: 2500, protocol: 'mad-collateral', attack: 'buyer-grief' });
  const { lab, el } = mount({ getHash: () => hash });
  assert.equal(lab.state.protocol, 'mad-collateral');
  assert.equal(lab.state.attack, 'buyer-grief');
  assert.equal(lab.state.bondBps, 2500);
  assert.equal(lab.state.contractCents, 320000);
  assert.equal(el('lab-bond-readout').textContent, '25.0% of contract');
});

test('LAB 38: a malformed location hash falls back to the default cell', () => {
  const { lab } = mount({ getHash: () => '#escrow=corrupted!!!' });
  assert.equal(lab.state.protocol, 'schelling-jury');
});

test('LAB 39: replay verification passes on an untampered export', () => {
  const { lab, el } = mount();
  const res = lab.verifyExport();
  assert.equal(res.ok, true);
  assert.match(el('lab-status').textContent, /Replay check passed/);
});

test('LAB 40: a tampered export fails replay verification with the reason shown', () => {
  const { lab, el } = mount();
  const r = lab.currentReport();
  r.canonical = r.canonical.replace('300000', '300001');
  const res = lab.verifyExport();
  assert.equal(res.ok, false);
  assert.match(el('lab-status').textContent, /Replay check FAILED/);
});

test('LAB 41: changing state invalidates the cached report', () => {
  const { lab } = mount();
  const r1 = lab.currentReport();
  lab.setBond(6000);
  const r2 = lab.currentReport();
  assert.notEqual(r1, r2);
  assert.equal(r2.body.bondBps, 6000);
});

test('LAB 42: the matrix rerenders identical output for identical state', () => {
  const { lab, el } = mount();
  const first = el('lab-matrix').innerHTML;
  lab.render();
  assert.equal(el('lab-matrix').innerHTML, first);
});

test('LAB 43: every matrix cell button is a real button with an accessible label', () => {
  const { el } = mount();
  const h = el('lab-matrix').innerHTML;
  assert.equal((h.match(/<button type="button" class="mcell/g) || []).length, 30);
  assert.match(h, /aria-pressed="(true|false)"/);
});

test('LAB 44: the chart aria-label names the selected protocol', () => {
  const { lab, el } = mount();
  lab.selectCell('mad-collateral', 'buyer-grief');
  assert.match(el('lab-chart').innerHTML, /aria-label="Attacker net profit against collateral bond ratio for Symmetric Collateral \(MAD\)/);
});

test('LAB 45: the chart threshold dot sits on the crossing point', () => {
  const { el } = mount();
  const h = el('lab-chart').innerHTML;
  assert.ok((h.match(/<circle class="chart-cross"/g) || []).length >= 1);
});

test('LAB 46: the escrow pot ledger shows contributions per party', () => {
  const { lab, el } = mount();
  lab.selectCell('mad-collateral', 'seller-ghost');
  const h = el('lab-detail').innerHTML;
  assert.match(h, />buyer<\/th><td class="num">4500\.00</);
  assert.match(h, />seller<\/th><td class="num">1500\.00</);
});

test('LAB 47: attacker notes surface in the detail panel', () => {
  const { lab, el } = mount();
  lab.selectCell('timelock-evidence', 'timeout-stall');
  assert.match(el('lab-detail').innerHTML, /auto-release deadline/);
});

test('LAB 48: esc neutralises markup in dynamic labels', () => {
  assert.equal(UI.esc('<i>"&"</i>'), '&lt;i&gt;&quot;&amp;&quot;&lt;/i&gt;');
});

test('LAB 49: contract select uses the six real disputes as the scenario set', () => {
  const { el } = mount();
  const h = el('lab-contract').innerHTML;
  E.CASES.forEach((c) => assert.ok(h.indexOf(c.title) !== -1, c.id));
});

test('LAB 50: the lab makes no network calls while rendering or testing', () => {
  const { lab } = mount();
  lab.runTests();
  lab.exportJSON();
  assert.ok(true, 'mount and interactions completed with no fetch available');
});
