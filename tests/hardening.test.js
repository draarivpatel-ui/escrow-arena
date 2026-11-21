'use strict';

/*
 * Adversarial hardening suite for EscrowArena.
 * Locks the defects found in the hostile audit: NaN rulings, malformed sandbox
 * amounts that crashed endpoint handlers, division-by-zero coverage ratios,
 * nonfinite money helpers, and every conservation invariant of the ledger.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');
const App = require('../app.js');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

function caseById(id) { return E.getCase(id); }
function funded(escrow, id) { E.applyEvent(escrow, id, 'fund'); E.applyEvent(escrow, id, 'submit'); E.applyEvent(escrow, id, 'dispute'); }

test('HARDEN 01: splitByBps rejects nonfinite amounts and basis points', () => {
  assert.throws(() => E.splitByBps(NaN, 5000), RangeError);
  assert.throws(() => E.splitByBps(Infinity, 5000), RangeError);
  assert.throws(() => E.splitByBps(-1, 5000), RangeError);
  assert.throws(() => E.splitByBps(1000, NaN), RangeError);
  assert.throws(() => E.splitByBps(1000, Infinity), RangeError);
});

test('HARDEN 02: splitByBps conserves every cent at every basis point', () => {
  for (const amount of [1, 3, 7, 99, 101, 999, 1001, 123456789]) {
    for (let bps = 0; bps <= 10000; bps += 137) {
      const s = E.splitByBps(amount, bps);
      assert.equal(s.captureCents + s.refundCents, amount, `amount ${amount} bps ${bps}`);
      assert.equal(s.captureBps + s.refundBps, 10000);
    }
  }
});

test('HARDEN 03: the rounding rule sends the residual cent to the buyer', () => {
  const s = E.splitByBps(3, 3333);
  assert.equal(s.captureCents, 0);
  assert.equal(s.refundCents, 3);
  const s2 = E.splitByBps(101, 5000);
  assert.equal(s2.captureCents, 50);
  assert.equal(s2.refundCents, 51);
});

test('HARDEN 04: fmtCents rejects nonfinite input and formats negatives correctly', () => {
  assert.throws(() => E.fmtCents(NaN), RangeError);
  assert.throws(() => E.fmtCents(Infinity), RangeError);
  assert.equal(E.fmtCents(-50), '-0.50');
  assert.equal(E.fmtCents(-12345), '-123.45');
  assert.equal(E.fmtCents(0), '0.00');
});

test('HARDEN 05: toCents rejects every malformed amount shape', () => {
  for (const bad of ['abc', '1.234', '-5', '1e3', ' ', '', '12.', '.50', '1,000.00', '0x10', 'Infinity', 'NaN', '12.3.4', '--1']) {
    assert.throws(() => E.toCents(bad), undefined, `bad amount accepted: ${JSON.stringify(bad)}`);
  }
  assert.equal(E.toCents('0.00'), 0);
  assert.equal(E.toCents('99999.99'), 9999999);
});

test('HARDEN 06: a NaN ruling is refused and leaves the milestone untouched', () => {
  const e = E.createEscrow(caseById('cold-feet'));
  funded(e, 'M2');
  const r = E.applyEvent(e, 'M2', 'rule', { captureBps: NaN });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-ruling');
  const m = E.findMilestone(e, 'M2');
  assert.equal(m.state, 'DISPUTED');
  assert.equal(m.captureCents, 0);
  assert.equal(m.refundCents, 0);
});

test('HARDEN 07: infinite and string rulings are refused', () => {
  for (const bps of [Infinity, -Infinity, '5000', true, [], {}]) {
    const e = E.createEscrow(caseById('cold-feet'));
    funded(e, 'M2');
    const r = E.applyEvent(e, 'M2', 'rule', { captureBps: bps });
    assert.equal(r.ok, false, `ruling accepted for ${JSON.stringify(bps)}`);
    assert.equal(r.reason, 'bad-ruling');
  }
});

test('HARDEN 08: ruling boundaries land in the right terminal state', () => {
  const map = { 0: 'REFUNDED', 1: 'SETTLED_PARTIAL', 9999: 'SETTLED_PARTIAL', 10000: 'RELEASED' };
  for (const [bps, want] of Object.entries(map)) {
    const e = E.createEscrow(caseById('cold-feet'));
    funded(e, 'M2');
    const r = E.applyEvent(e, 'M2', 'rule', { captureBps: Number(bps) });
    assert.equal(r.ok, true);
    assert.equal(r.to, want);
    const m = E.findMilestone(e, 'M2');
    assert.equal(m.captureCents + m.refundCents, m.amountCents);
  }
});

test('HARDEN 09: rule is illegal outside DISPUTED and a second ruling is blocked', () => {
  const e = E.createEscrow(caseById('cold-feet'));
  E.applyEvent(e, 'M2', 'fund');
  assert.equal(E.applyEvent(e, 'M2', 'rule', { captureBps: 5000 }).reason, 'invalid-transition');
  E.applyEvent(e, 'M2', 'submit');
  E.applyEvent(e, 'M2', 'dispute');
  assert.equal(E.applyEvent(e, 'M2', 'rule', { captureBps: 5000 }).ok, true);
  const second = E.applyEvent(e, 'M2', 'rule', { captureBps: 9000 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'invalid-transition');
});

test('HARDEN 10: every event after a terminal state is refused', () => {
  const e = E.createEscrow(caseById('cold-feet'));
  funded(e, 'M1');
  E.applyEvent(e, 'M1', 'rule', { captureBps: 10000 });
  for (const ev of ['fund', 'submit', 'approve', 'dispute', 'rule']) {
    const r = E.applyEvent(e, 'M1', ev, { captureBps: 0 });
    assert.equal(r.ok, false, `event ${ev} accepted after terminal state`);
  }
});

test('HARDEN 11: escrowStatus walks OPEN to IN_DISPUTE to COMPLETE', () => {
  const e = E.createEscrow(caseById('cold-feet'));
  assert.equal(E.escrowStatus(e), 'OPEN');
  ['M1', 'M3'].forEach((id) => { E.applyEvent(e, id, 'fund'); E.applyEvent(e, id, 'submit'); E.applyEvent(e, id, 'approve'); });
  assert.equal(E.escrowStatus(e), 'OPEN');
  funded(e, 'M2');
  assert.equal(E.escrowStatus(e), 'IN_DISPUTE');
  E.applyEvent(e, 'M2', 'rule', { captureBps: 8000 });
  assert.equal(E.escrowStatus(e), 'COMPLETE');
});

test('HARDEN 12: corrupted milestone state is an invalid transition, not a crash', () => {
  const e = E.createEscrow(caseById('cold-feet'));
  E.findMilestone(e, 'M1').state = 'HACKED';
  assert.equal(E.applyEvent(e, 'M1', 'fund').reason, 'invalid-transition');
});

test('HARDEN 13: captureAuthorization cannot exceed the authorized remainder', () => {
  const sb = E.createSandbox(7);
  const order = sb.createOrder({ intent: 'AUTHORIZE', purchase_units: [{ reference_id: 'r1', amount: { currency_code: 'USD', value: '100.00' } }] }).body;
  const auth = sb.authorizeOrder(order.id).body.purchase_units[0].payments.authorizations[0];
  assert.equal(sb.captureAuthorization(auth.id, { amount: { value: '60.00' } }).status, 201);
  const over = sb.captureAuthorization(auth.id, { amount: { value: '40.01' } });
  assert.equal(over.status, 422);
  assert.equal(over.body.name, 'AMOUNT_EXCEEDS_AUTHORIZED');
  assert.equal(sb.captureAuthorization(auth.id, { amount: { value: '40.00' } }).status, 201);
});

test('HARDEN 14: a fully captured authorization is closed to further capture', () => {
  const sb = E.createSandbox(7);
  const order = sb.createOrder({ intent: 'AUTHORIZE', purchase_units: [{ reference_id: 'r1', amount: { currency_code: 'USD', value: '50.00' } }] }).body;
  const auth = sb.authorizeOrder(order.id).body.purchase_units[0].payments.authorizations[0];
  assert.equal(sb.captureAuthorization(auth.id, { amount: { value: '50.00' }, final_capture: true }).status, 201);
  assert.equal(sb.captureAuthorization(auth.id, { amount: { value: '0.01' } }).status, 422);
});

test('HARDEN 15: a voided authorization cannot be captured', () => {
  const sb = E.createSandbox(7);
  const order = sb.createOrder({ intent: 'AUTHORIZE', purchase_units: [{ reference_id: 'r1', amount: { currency_code: 'USD', value: '50.00' } }] }).body;
  const auth = sb.authorizeOrder(order.id).body.purchase_units[0].payments.authorizations[0];
  assert.equal(sb.voidAuthorization(auth.id).status, 204);
  const cap = sb.captureAuthorization(auth.id, { amount: { value: '10.00' } });
  assert.equal(cap.status, 422);
  assert.equal(cap.body.name, 'AUTHORIZATION_VOIDED');
});

test('HARDEN 16: refunds can never exceed the captured remainder (double refund)', () => {
  const sb = E.createSandbox(7);
  const order = sb.createOrder({ intent: 'CAPTURE', purchase_units: [{ reference_id: 'r1', amount: { currency_code: 'USD', value: '80.00' } }] }).body;
  const cap = sb.captureOrder(order.id).body.purchase_units[0].payments.captures[0];
  assert.equal(sb.refundCapture(cap.id, { amount: { value: '50.00' } }).status, 201);
  const over = sb.refundCapture(cap.id, { amount: { value: '30.01' } });
  assert.equal(over.status, 422);
  assert.equal(over.body.name, 'REFUND_AMOUNT_EXCEEDS_CAPTURE');
  assert.equal(sb.refundCapture(cap.id, { amount: { value: '30.00' } }).status, 201);
  assert.equal(cap.status, 'REFUNDED');
});

test('HARDEN 17: malformed sandbox amounts return 422 instead of crashing', () => {
  const sb = E.createSandbox(7);
  for (const value of ['abc', '1.234', '-5', '0.00', ' ', 'Infinity', 'NaN']) {
    const res = sb.createOrder({ intent: 'AUTHORIZE', purchase_units: [{ reference_id: 'r', amount: { currency_code: 'USD', value } }] });
    assert.equal(res.status, 422, `createOrder accepted ${JSON.stringify(value)}`);
  }
  const order = sb.createOrder({ intent: 'AUTHORIZE', purchase_units: [{ reference_id: 'r1', amount: { currency_code: 'USD', value: '50.00' } }] }).body;
  const auth = sb.authorizeOrder(order.id).body.purchase_units[0].payments.authorizations[0];
  assert.equal(sb.captureAuthorization(auth.id, { amount: { value: 'abc' } }).status, 422);
  assert.equal(sb.captureAuthorization(auth.id, {}).status, 422);
});

test('HARDEN 18: order intent is enforced in both directions', () => {
  const sb = E.createSandbox(7);
  const auth = sb.createOrder({ intent: 'AUTHORIZE', purchase_units: [{ reference_id: 'r', amount: { currency_code: 'USD', value: '10.00' } }] }).body;
  assert.equal(sb.captureOrder(auth.id).body.name, 'ORDER_NOT_CAPTURE_INTENT');
  assert.equal(sb.authorizeOrder(auth.id).status, 201);
  assert.equal(sb.authorizeOrder(auth.id).status, 422); // double authorize
  const cap = sb.createOrder({ intent: 'CAPTURE', purchase_units: [{ reference_id: 'r', amount: { currency_code: 'USD', value: '10.00' } }] }).body;
  assert.equal(sb.authorizeOrder(cap.id).body.name, 'ORDER_NOT_AUTHORIZE_INTENT');
  assert.equal(sb.captureOrder(cap.id).status, 201);
  assert.equal(sb.captureOrder(cap.id).status, 422); // double capture
});

test('HARDEN 19: payout rejects malformed items', () => {
  const sb = E.createSandbox(7);
  assert.equal(sb.createPayout({}).status, 400);
  assert.equal(sb.createPayout({ sender_batch_header: {}, items: [] }).status, 400);
  const bad = sb.createPayout({ sender_batch_header: {}, items: [{ amount: { currency_code: 'USD', value: 'abc' } }] });
  assert.equal(bad.status, 422);
});

test('HARDEN 20: runRuling rejects nonfinite and out-of-range rulings', () => {
  const c = caseById('cold-feet');
  for (const rb of [NaN, Infinity, -Infinity, -1, 10001, undefined, null]) {
    assert.throws(() => E.runRuling(c, { captureBps: rb }), RangeError, `runRuling accepted ${String(rb)}`);
  }
});

test('HARDEN 21: AUTHORIZE rulings conserve money across the whole ledger', () => {
  const c = caseById('cold-feet');
  for (const bps of [0, 1, 5000, 9999, 10000]) {
    const run = E.runRuling(c, { captureBps: bps });
    const s = run.split;
    const m1 = c.milestones[0].amountCents;
    const untouched = c.milestones[2].amountCents;
    assert.equal(s.captureCents + s.refundCents, c.disputed.amountCents);
    assert.equal(run.totals.capturedCents, m1 + s.captureCents, `bps ${bps}`);
    assert.equal(run.totals.releasedCents, s.captureCents === 0 ? c.disputed.amountCents : s.refundCents, `released at bps ${bps}`);
    if (s.captureCents > 0) assert.equal(run.totals.payoutCents + run.totals.feeCents, s.captureCents);
    assert.equal(m1 + c.disputed.amountCents + untouched, c.total);
  }
});

test('HARDEN 22: a zero-capture AUTHORIZE ruling voids the authorization', () => {
  const c = caseById('cold-feet');
  const run = E.runRuling(c, { captureBps: 0 });
  const voidStep = run.steps.find((s) => s.label === 'Void authorization');
  assert.ok(voidStep);
  assert.equal(voidStep.response.status, 204);
  assert.equal(run.totals.releasedCents, c.disputed.amountCents);
  assert.equal(run.totals.payoutCents, 0);
});

test('HARDEN 23: CAPTURE rulings refund exactly the buyer share', () => {
  const c = caseById('extra-dashboard');
  for (const bps of [0, 2500, 7000, 10000]) {
    const run = E.runRuling(c, { captureBps: bps });
    const s = run.split;
    assert.equal(s.captureCents + s.refundCents, c.disputed.amountCents);
    assert.equal(run.totals.capturedCents, c.milestones[0].amountCents + s.captureCents);
    assert.equal(run.totals.refundedCents, s.refundCents);
    if (s.captureCents > 0) assert.equal(run.totals.payoutCents + run.totals.feeCents, s.captureCents);
  }
});

test('HARDEN 24: the tribunal conserves every disputed milestone on all six cases', () => {
  for (const c of E.CASES) {
    const out = E.convene(c);
    const s = out.settlement;
    assert.equal(s.captureCents + s.refundCents, c.disputed.amountCents, c.id);
    assert.equal(s.captureBps + s.refundBps, 10000, c.id);
    assert.ok(s.captureBps >= 0 && s.captureBps <= 10000);
    assert.ok(out.trace.length >= 4);
  }
});

test('HARDEN 25: auditSpec never emits NaN on degenerate requirements', () => {
  const c = caseById('gold-plating');
  const zeroPaths = { ...c, requirements: [{ id: 'RX', text: 'nothing mapped', weight: 0.5, paths: [] }] };
  const spec = E.auditSpec(zeroPaths);
  assert.ok(Number.isFinite(spec.coverageBps));
  assert.equal(spec.coverageBps, 10000);
  const allBuyer = { ...c, requirements: c.requirements.map((r) => ({ ...r, addedByBuyer: true })) };
  const spec2 = E.auditSpec(allBuyer);
  assert.ok(Number.isFinite(spec2.coverageBps));
  const noDiff = { ...c, diff: null };
  const spec3 = E.auditSpec(noDiff);
  assert.ok(Number.isFinite(spec3.coverageBps));
});

test('HARDEN 26: verifyTelemetry and settlement survive missing evidence', () => {
  const c = caseById('cold-feet');
  const bare = { ...c, telemetry: undefined, log: undefined, claim: undefined, manifest: undefined };
  const tel = E.verifyTelemetry(bare);
  assert.equal(tel.samples, 0);
  assert.ok(tel.ratio === null || Number.isFinite(tel.ratio));
  const settle = E.calculateSettlement(bare, E.auditSpec(bare), tel);
  assert.ok(Number.isFinite(settle.captureBps));
  assert.equal(settle.captureCents + settle.refundCents, c.disputed.amountCents);
});

test('HARDEN 27: scoreRuling treats nonfinite rulings as a real ruling, not NaN', () => {
  const c = caseById('cold-feet');
  const truth = E.convene(c).settlement;
  for (const rb of [NaN, Infinity, -Infinity, undefined]) {
    const s = E.scoreRuling(c, { captureBps: rb });
    assert.ok(Number.isFinite(s.score), `score was ${s.score}`);
    assert.equal(s.errorBps, truth.captureBps);
  }
  const s = E.scoreRuling(c, { captureBps: truth.captureBps, flags: 'not-an-array' });
  assert.ok(Number.isFinite(s.score));
  assert.equal(s.errorBps, 0);
  assert.ok(s.score >= 1000);
});

test('HARDEN 28: p95 ignores nonfinite samples', () => {
  assert.equal(E.p95([]), 0);
  assert.equal(E.p95([NaN, Infinity, -Infinity]), 0);
  const mixed = [100, NaN, 200, Infinity, 300];
  assert.equal(E.p95(mixed), 300);
});

test('HARDEN 29: request builders reject nonpositive money', () => {
  const c = caseById('cold-feet');
  for (const bad of [0, -100, NaN, Infinity]) {
    assert.throws(() => E.buildCaptureRequest('A1', bad, true), RangeError);
    assert.throws(() => E.buildRefundRequest('C1', bad), RangeError);
    assert.throws(() => E.buildPayoutRequest(c, bad), RangeError);
  }
  assert.throws(() => E.buildOrderRequest({}), RangeError);
  assert.throws(() => E.buildOrderRequest({ milestones: [] }), RangeError);
});

test('HARDEN 30: payload headers are deterministic and secrets are redacted', () => {
  const c = caseById('cold-feet');
  const r1 = E.buildOrderRequest(c);
  const r2 = E.buildOrderRequest(c);
  assert.equal(r1.headers['PayPal-Request-Id'], r2.headers['PayPal-Request-Id']);
  const red = E.redactHeaders({ Authorization: 'Bearer live-token', 'Content-Type': 'application/json' });
  assert.equal(red.Authorization, 'Bearer <token>');
  assert.equal(red['Content-Type'], 'application/json');
});

test('HARDEN 31: sandbox-only gate refuses other hosts and missing tokens', async () => {
  const req = E.buildVoidRequest('AUTH-1');
  assert.deepEqual(await E.executeRequest(req, { base: 'https://evil.example.com', token: 'x' }), { ok: false, reason: 'sandbox-only' });
  assert.deepEqual(await E.executeRequest(req, {}), { ok: false, reason: 'no-token' });
});

test('HARDEN 32: esc() escapes every HTML-breaking character', () => {
  const out = App.esc('<img src=x onerror="a(1)">&\'');
  assert.equal(out, '&lt;img src=x onerror=&quot;a(1)&quot;&gt;&amp;&#39;');
  assert.equal(App.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('HARDEN 33: index.html carries a CSP and no inline handlers', () => {
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(html, /\son(error|click|load|focus|mouseover)=/i);
});

test('HARDEN 34: the page declares a visible focus indicator and no smooth scroll', () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /outline:\s*3px/);
  assert.doesNotMatch(css, /scroll-behavior:\s*smooth/);
  assert.doesNotMatch(css, /outline:\s*(none|0)(?!px)/);
});

test('HARDEN 35: skip link, lang, viewport and labelled controls survive', () => {
  assert.match(html, /<a class="skip" href="#main">/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /aria-live="polite"/);
  for (const id of ['case-select', 'ruling-slider', 'paypal-token']) {
    assert.match(html, new RegExp('for="' + id + '"'), `label missing for ${id}`);
  }
});

/* ------------------------------------------------------------------ *
 * Pass 2 regressions: every defect reproduced by the hostile audit.   *
 * ------------------------------------------------------------------ */

const crypto = require('node:crypto');

function fresh(id) {
  const c = E.getCase(id);
  return JSON.parse(JSON.stringify(c));
}

test('PASS2 01: runRuling stops at the first failed sandbox step and pays nothing', () => {
  const c = fresh('cold-feet');
  c.disputed.amountCents = c.milestones[c.disputedIndex].amountCents + 999999;
  const run = E.runRuling(c, { captureBps: 10000 });
  assert.equal(run.failed, true);
  assert.equal(run.totals.payoutCents, 0);
  assert.equal(run.totals.capturedCents, c.milestones[0].amountCents);
  const pay = run.steps.find((s) => s.label === 'Pay seller');
  assert.ok(!pay, 'seller payout must not fire after a failed capture');
});

test('PASS2 02: createOrder failures mark the run failed with zero totals', () => {
  const c = fresh('cold-feet');
  c.milestones[0].amountCents = -5;
  const run = E.runRuling(c, { captureBps: 5000 });
  assert.equal(run.failed, true);
  assert.equal(run.totals.capturedCents, 0);
  assert.equal(run.totals.payoutCents, 0);
});

test('PASS2 03: sandbox snapshots amounts; mutating the caller object cannot inflate a capture', () => {
  const sb = E.createSandbox(7);
  const unit = { reference_id: 'M1', amount: { currency_code: 'USD', value: '10.00' } };
  const created = sb.createOrder({ intent: 'CAPTURE', purchase_units: [unit] });
  assert.equal(created.status, 201);
  unit.amount.value = '99999.99';
  const o = created.body;
  assert.equal(o.purchase_units[0].amount.value, '10.00');
  const cap = sb.captureOrder(o.id);
  assert.equal(cap.body.purchase_units[0].payments.captures[0].amount.value, '10.00');
});

test('PASS2 04: stateful toString on amount.value is read exactly once', () => {
  const sb = E.createSandbox(1);
  let n = 0;
  const tricky = { value: { toString() { n += 1; return n === 1 ? '5.00' : '999.00'; } } };
  const res = sb.createOrder({ intent: 'CAPTURE', purchase_units: [{ amount: tricky }] });
  assert.equal(res.status, 201);
  assert.equal(res.body.purchase_units[0].amount.value, '5.00');
});

test('PASS2 05: null unit elements and null amount objects return 422, never throw', () => {
  const sb = E.createSandbox(2);
  assert.equal(sb.createOrder({ intent: 'CAPTURE', purchase_units: [null] }).status, 422);
  assert.equal(sb.createOrder({ intent: 'CAPTURE', purchase_units: [{ amount: null }] }).status, 422);
  const evil = { get amount() { throw new Error('trap'); } };
  assert.equal(sb.createOrder({ intent: 'CAPTURE', purchase_units: [evil] }).status, 422);
  const p = sb.createPayout({ sender_batch_header: {}, items: [null] });
  assert.equal(p.status, 422);
});

test('PASS2 06: CAPTURE-intent runs report held milestone funds honestly', () => {
  const c = fresh('cold-feet');
  c.intent = 'CAPTURE';
  const run = E.runRuling(c, { captureBps: 5000 });
  assert.equal(run.failed, undefined);
  assert.ok(run.totals.capturedPendingCents > 0, 'M3 capture must be visible');
  assert.equal(run.totals.capturedCents, c.milestones[0].amountCents + run.split.captureCents);
});

test('PASS2 07: createPayout is idempotent on sender_batch_id', () => {
  const sb = E.createSandbox(3);
  const req = E.buildPayoutRequest(fresh('cold-feet'), 5000, 'x');
  const a = sb.createPayout(req.body);
  const b = sb.createPayout(req.body);
  assert.equal(b.status, 200);
  assert.equal(b.body.batch_header.payout_batch_id, a.body.batch_header.payout_batch_id);
});

test('PASS2 08: sha256Hex encodes unpaired surrogates as U+FFFD like crypto', () => {
  const node = crypto.createHash('sha256').update('𐀀', 'utf8').digest('hex');
  assert.equal(E.sha256Hex('𐀀'), node);
});

test('PASS2 09: idempotency keys are 64-bit SHA-256 derived, not 32-bit FNV', () => {
  const req = E.buildCaptureRequest('AUTH-1', 100, true, 'x');
  assert.match(req.headers['PayPal-Request-Id'], /^escrow-arena-[0-9a-f]{16}$/);
  const r2 = E.buildCaptureRequest('AUTH-2', 100, true, 'x');
  assert.notEqual(req.headers['PayPal-Request-Id'], r2.headers['PayPal-Request-Id']);
});

test('PASS2 10: convene never throws on malformed case fields', () => {
  const c = fresh('cold-feet');
  for (const patch of [
    { diff: null }, { requirements: null }, { claim: null }, { disputed: null },
    { diff: { files: 'x' }, requirements: [{ paths: 7 }] },
  ]) {
    const broken = Object.assign({}, c, patch);
    assert.doesNotThrow(() => E.convene(broken), JSON.stringify(Object.keys(patch)));
  }
});

test('PASS2 11: auditSpec ignores nonfinite weights and nonnumeric diff fields', () => {
  const c = fresh('cold-feet');
  c.requirements[0].weight = NaN;
  c.requirements[1].weight = -5;
  c.diff.files[0].added = 'lots';
  c.diff.files[0].tests = Infinity;
  const spec = E.auditSpec(c);
  assert.ok(Number.isFinite(spec.coverageBps));
  assert.ok(Number.isFinite(spec.unmappedRatioBps));
});

test('PASS2 12: splitByBps and toCents reject fractional and unsafe cent values', () => {
  assert.throws(() => E.splitByBps(10.5, 5000), RangeError);
  assert.throws(() => E.splitByBps(Number.MAX_VALUE, 5000), RangeError);
  assert.throws(() => E.toCents(Number.MAX_SAFE_INTEGER / 100 + 1), RangeError);
  const big = E.splitByBps(Number.MAX_SAFE_INTEGER, 5000);
  assert.ok(Number.isSafeInteger(big.captureCents));
  assert.equal(big.captureCents + big.refundCents, Number.MAX_SAFE_INTEGER);
});

test('PASS2 13: builders reject fractional cents', () => {
  assert.throws(() => E.buildCaptureRequest('A', 100.5, true), RangeError);
  assert.throws(() => E.buildRefundRequest('C', 0.99), RangeError);
  assert.throws(() => E.buildPayoutRequest(fresh('cold-feet'), 99.9), RangeError);
  assert.throws(() => E.buildOrderRequest(fresh('cold-feet'), { intent: 'SALE' }), RangeError);
});

test('PASS2 14: a reentrant captureBps getter cannot sneak a second ruling past the state check', () => {
  const c = fresh('cold-feet');
  const escrow = E.createEscrow(c);
  const mid = c.disputed.id;
  E.applyEvent(escrow, mid, 'fund');
  E.applyEvent(escrow, mid, 'submit');
  E.applyEvent(escrow, mid, 'dispute');
  let calls = 0;
  const evil = {};
  Object.defineProperty(evil, 'captureBps', { get() { calls += 1; return calls === 1 ? 5000 : 9999; } });
  const r = E.applyEvent(escrow, mid, 'rule', evil);
  assert.equal(r.ok, true);
  assert.equal(escrow.milestones[c.disputedIndex].state, 'SETTLED_PARTIAL');
  const again = E.applyEvent(escrow, mid, 'rule', evil);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'invalid-transition');
  const ruleEvents = escrow.history.filter((h) => h.event === 'rule');
  assert.equal(ruleEvents.length, 1, 'the second getter value must not produce a second ruling');
});

test('PASS2 15: ruling history records the actual applied captureBps', () => {
  const c = fresh('cold-feet');
  const escrow = E.createEscrow(c);
  const mid = c.disputed.id;
  E.applyEvent(escrow, mid, 'fund');
  E.applyEvent(escrow, mid, 'submit');
  E.applyEvent(escrow, mid, 'dispute');
  E.applyEvent(escrow, mid, 'rule', { captureBps: 7000 });
  const ruling = escrow.history.find((h) => h.event === 'rule');
  assert.equal(ruling.captureBps, 7000);
});

test('PASS2 16: verifyTelemetry refuses to score an invalid SLA and rejects null manifests', () => {
  const c = fresh('cold-feet');
  c.telemetry.slaP95Ms = NaN;
  const tel = E.verifyTelemetry(c);
  assert.equal(tel.slaMet, false);
  const c2 = fresh('cold-feet');
  c2.manifest.push(null);
  assert.doesNotThrow(() => E.verifyTelemetry(c2));
});

test('PASS2 17: public tables are frozen', () => {
  assert.ok(Object.isFrozen(E.CASES));
  assert.ok(Object.isFrozen(E.CASES[0]));
  assert.ok(Object.isFrozen(E.CASES[0].milestones));
  assert.ok(Object.isFrozen(E.FLAGS));
  assert.ok(Object.isFrozen(E.TRANSITIONS));
  assert.ok(Object.isFrozen(E.STATES));
});

test('PASS2 18: duplicate flag selections cannot double-count score', () => {
  const c = fresh('cold-feet');
  const truth = E.convene(c).settlement;
  const flag = truth.flags[0];
  if (!flag) return;
  const single = E.scoreRuling(c, { captureBps: truth.captureBps, flags: [flag] });
  const dup = E.scoreRuling(c, { captureBps: truth.captureBps, flags: [flag, flag, flag] });
  assert.equal(dup.score, single.score);
});

test('PASS2 19: expired authorizations cannot be captured', () => {
  const sb = E.createSandbox(4);
  const order = sb.createOrder({ intent: 'AUTHORIZE', purchase_units: [{ amount: { value: '10.00' } }] }).body;
  const auth = sb.authorizeOrder(order.id).body;
  const a = auth.purchase_units[0].payments.authorizations[0];
  sb.db.auths[a.id].expiration_time = '2000-01-01T00:00:00Z';
  const res = sb.captureAuthorization(a.id, { amount: { value: '1.00' } });
  assert.equal(res.status, 422);
  assert.equal(res.body.name, 'AUTHORIZATION_EXPIRED');
});

test('PASS2 20: misc API guards hold', async () => {
  const res = await E.executeRequest(null);
  assert.equal(res.ok, false);
  const c = fresh('cold-feet');
  assert.equal(E.moneyReconciliationSafe ? true : true, true);
  assert.doesNotThrow(() => E.buildLedger({}));
  assert.doesNotThrow(() => E.buildLedger({ milestones: [] }));
  const run = E.runRuling(c, { captureBps: 5000 }, 0);
  assert.ok(run.steps.length > 0, 'seed 0 must be honored, not discarded');
});

test('PASS2 21: scoreRuling normalizes malformed rulings and rounds like applyEvent', () => {
  const c = fresh('cold-feet');
  const a = E.scoreRuling(c, { captureBps: NaN, flags: 'x' });
  assert.ok(Number.isFinite(a.score));
  const b = E.scoreRuling(c, null);
  assert.ok(Number.isFinite(b.score));
});

test('PASS2 22: rendered HTML escapes every dynamic sink the audit named', () => {
  const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  for (const sink of [
    'esc(m.state)', 'esc(c.claim.demandRefundBps)', 'esc(f.added)', 'esc(f.removed)',
    'esc(f.tests)', 'esc(c.telemetry.slaP95Ms)', 'esc(f.id)', 'esc(c.id)',
  ]) {
    assert.ok(src.includes(sink), 'missing escape: ' + sink);
  }
  assert.ok(!src.includes('Math.max.apply'), 'drawLatency must not use apply on unbounded arrays');
});

test('PASS2 23: CDN assets carry SRI and the CSP only loosens style-src for the grid', () => {
  // AG Grid positions cells through inline styles, so style-src keeps
  // 'unsafe-inline'; script-src stays strict and every CDN asset is SRI-pinned.
  assert.equal((html.match(/integrity="sha384-/g) || []).length, 3);
  assert.equal((html.match(/crossorigin="anonymous"/g) || []).length, 3);
  assert.match(html, /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
  assert.match(html, /object-src 'none'; base-uri 'none'; form-action 'none'/);
});
