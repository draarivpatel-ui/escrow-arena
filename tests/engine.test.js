'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const E = require('../engine.js');

const clone = (o) => JSON.parse(JSON.stringify(o));
const caseById = (id) => E.getCase(id);

test('Engine 01: sha256Hex matches the published vectors', () => {
  assert.equal(E.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(E.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('Engine 02: sha256Hex agrees with Node crypto on unicode and long input', () => {
  ['hello world', 'café €', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(5000)].forEach((s) => {
    assert.equal(E.sha256Hex(s), crypto.createHash('sha256').update(s).digest('hex'));
  });
});

test('Engine 03: toCents and fmtCents round trip and reject bad input', () => {
  assert.equal(E.toCents('250.00'), 25000);
  assert.equal(E.toCents('0.5'), 50);
  assert.equal(E.toCents('7'), 700);
  assert.equal(E.fmtCents(5), '0.05');
  assert.equal(E.fmtCents(123456), '1234.56');
  assert.throws(() => E.toCents('12.345'));
  assert.throws(() => E.toCents('abc'));
});

test('Engine 04: capture plus refund always equals the amount, to the cent', () => {
  const rng = E.mulberry32(4);
  for (let i = 0; i < 3000; i += 1) {
    const amount = 1 + Math.floor(rng() * 1000000);
    const bps = Math.floor(rng() * 10001);
    const s = E.splitByBps(amount, bps);
    assert.equal(s.captureCents + s.refundCents, amount);
    assert.equal(s.captureBps + s.refundBps, 10000);
    assert.ok(s.captureCents >= 0 && s.refundCents >= 0);
  }
});

test('Engine 05: the capture rounds down and the residual cent goes to the buyer', () => {
  const s = E.splitByBps(1001, 5000);
  assert.equal(s.captureCents, 500);
  assert.equal(s.refundCents, 501);
});

test('Engine 06: splitByBps clamps out-of-range basis points', () => {
  assert.equal(E.splitByBps(10000, -50).captureCents, 0);
  assert.equal(E.splitByBps(10000, 20000).captureCents, 10000);
});

test('Engine 07: platform fee is 2.5 percent rounded down', () => {
  assert.equal(E.platformFee(10000), 250);
  assert.equal(E.platformFee(199), 4);
  assert.equal(E.PLATFORM_FEE_BPS, 250);
});

test('Engine 08: six cases with unique ids and three milestones each', () => {
  assert.equal(E.CASES.length, 6);
  assert.equal(new Set(E.CASES.map((c) => c.id)).size, 6);
  E.CASES.forEach((c) => {
    assert.equal(c.milestones.length, 3);
    assert.equal(c.total, c.amounts.reduce((a, b) => a + b, 0));
    assert.equal(c.disputed.id, 'M2');
  });
});

test('Engine 09: both intents are exercised by the case set', () => {
  const intents = new Set(E.CASES.map((c) => c.intent));
  assert.deepEqual([...intents].sort(), ['AUTHORIZE', 'CAPTURE']);
});

test('Engine 10: manifest hashes are real SHA-256 digests of the stated content', () => {
  E.CASES.forEach((c) => c.manifest.forEach((m) => {
    assert.equal(m.approvedSha, crypto.createHash('sha256').update(m.approvedContent).digest('hex'));
    assert.equal(m.deliveredSha, crypto.createHash('sha256').update(m.deliveredContent).digest('hex'));
  }));
});

test('Engine 11: p95 uses the nearest-rank rule', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(E.p95(s), 95);
  assert.equal(E.p95([5]), 5);
  assert.equal(E.p95([]), 0);
});

test('Engine 12: the generated sample sets reproduce their stated p95', () => {
  const expected = { 'cold-feet': 410, 'extra-dashboard': 640, 'slow-endpoint': 840, 'swapped-build': 520, 'gold-plating': 560, 'late-add-on': 380 };
  E.CASES.forEach((c) => {
    assert.equal(c.telemetry.samples.length, 100);
    assert.equal(E.p95(c.telemetry.samples), expected[c.id], c.id);
  });
});

test('Engine 13: slaScore is piecewise linear with the documented knots', () => {
  assert.equal(E.slaScore(0.5), 1);
  assert.equal(E.slaScore(1), 1);
  assert.equal(E.slaScore(1.25), 0.5);
  assert.equal(E.slaScore(2), 0);
  assert.equal(E.slaScore(3), 0);
  assert.ok(Math.abs(E.slaScore(1.68) - 0.21333) < 0.001);
});

test('Engine 14: spec coverage per case', () => {
  const expected = { 'cold-feet': 10000, 'extra-dashboard': 10000, 'slow-endpoint': 10000, 'swapped-build': 10000, 'gold-plating': 8000, 'late-add-on': 5500 };
  E.CASES.forEach((c) => assert.equal(E.auditSpec(c).coverageBps, expected[c.id], c.id));
});

test('Engine 15: requirements added by the buyer never count against the seller', () => {
  const c = caseById('extra-dashboard');
  const spec = E.auditSpec(c);
  assert.deepEqual(spec.buyerAddedRequirements, ['R4']);
  assert.equal(spec.perRequirement.length, 2);
  assert.equal(spec.coverageBps, 10000);
});

test('Engine 16: partial path coverage earns partial credit', () => {
  const spec = E.auditSpec(caseById('late-add-on'));
  const r3 = spec.perRequirement.find((r) => r.id === 'R3');
  assert.equal(r3.coverage, 0.5);
});

test('Engine 17: unrequested code is measured as a share of all added lines', () => {
  const gp = E.auditSpec(caseById('gold-plating'));
  assert.equal(gp.unmappedAdded, 1900);
  assert.ok(gp.unmappedRatioBps >= 2500);
  assert.equal(E.auditSpec(caseById('cold-feet')).unmappedRatioBps, 0);
});

test('Engine 18: telemetry flags the slow endpoint and passes the fast ones', () => {
  const slow = E.verifyTelemetry(caseById('slow-endpoint'));
  assert.equal(slow.slaMet, false);
  assert.equal(slow.measuredP95Ms, 840);
  assert.equal(slow.slaScoreBps, 2133);
  assert.equal(E.verifyTelemetry(caseById('cold-feet')).slaMet, true);
});

test('Engine 19: hash verification names the tampered artifact and zeroes the hash score', () => {
  const t = E.verifyTelemetry(caseById('swapped-build'));
  assert.equal(t.tampered, true);
  assert.equal(t.mismatches, 1);
  assert.equal(t.manifest.filter((r) => !r.match)[0].path, 'dist/notify.tar');
  assert.equal(t.hashScoreBps, 0);
  assert.equal(E.verifyTelemetry(caseById('cold-feet')).hashScoreBps, 10000);
});

test('Engine 20: fair capture basis points per case', () => {
  const expected = { 'cold-feet': 10000, 'extra-dashboard': 10000, 'slow-endpoint': 8427, 'swapped-build': 8000, 'gold-plating': 8000, 'late-add-on': 5500 };
  E.CASES.forEach((c) => assert.equal(E.convene(c).settlement.captureBps, expected[c.id], c.id));
});

test('Engine 21: tribunal money always sums to the disputed milestone', () => {
  E.CASES.forEach((c) => {
    const s = E.convene(c).settlement;
    assert.equal(s.captureCents + s.refundCents, c.disputed.amountCents, c.id);
    assert.equal(s.captureBps + s.refundBps, 10000, c.id);
  });
  assert.equal(E.convene(caseById('slow-endpoint')).settlement.captureCents, 269664);
});

test('Engine 22: risk flags per case are exactly the authored ones', () => {
  const expected = {
    'cold-feet': ['refund_fraud'], 'extra-dashboard': ['scope_creep_buyer'], 'slow-endpoint': ['sla_breach'],
    'swapped-build': ['tampered_artifact'], 'gold-plating': ['scope_creep_seller', 'underdelivery'], 'late-add-on': ['scope_creep_buyer', 'underdelivery']
  };
  E.CASES.forEach((c) => assert.deepEqual(E.convene(c).settlement.flags.slice().sort(), expected[c.id].slice().sort(), c.id));
});

test('Engine 23: refund fraud needs the buyer to have approved or deployed before claiming', () => {
  const c = clone(caseById('cold-feet'));
  c.log = c.log.filter((e) => e.kind !== 'approve' && e.kind !== 'deploy');
  assert.ok(!E.convene(c).settlement.flags.includes('refund_fraud'));
});

test('Engine 24: refund fraud needs a refund demand of at least 50 percent', () => {
  const c = clone(caseById('cold-feet'));
  c.claim.demandRefundBps = 3000;
  assert.ok(!E.convene(c).settlement.flags.includes('refund_fraud'));
});

test('Engine 25: an approval that comes after the claim does not count as acceptance', () => {
  const c = clone(caseById('cold-feet'));
  c.log = [c.log[3], c.log[1], c.log[2]];
  assert.ok(!E.convene(c).settlement.flags.includes('refund_fraud'));
});

test('Engine 26: convene logs five tool calls across the three agents in order', () => {
  const r = E.convene(caseById('cold-feet'));
  assert.deepEqual(r.trace.map((t) => t.agent), [
    'Spec Compliance Auditor', 'Telemetry & Hash Verifier', 'Telemetry & Hash Verifier', 'Settlement Split Calculator', 'Settlement Split Calculator'
  ]);
  assert.deepEqual(r.trace.map((t) => t.seq), [1, 2, 3, 4, 5]);
});

test('Engine 27: convene is deterministic', () => {
  assert.deepEqual(E.convene(caseById('gold-plating')), E.convene(caseById('gold-plating')));
});

test('Engine 28: a new escrow starts with every milestone pending', () => {
  const e = E.createEscrow(E.CASES[0]);
  assert.ok(e.milestones.every((m) => m.state === 'PENDING'));
  assert.equal(E.escrowStatus(e), 'OPEN');
});

test('Engine 29: the happy path walks fund, submit, approve', () => {
  const e = E.createEscrow(E.CASES[0]);
  assert.equal(E.applyEvent(e, 'M1', 'fund').to, 'FUNDED');
  assert.equal(E.applyEvent(e, 'M1', 'submit').to, 'SUBMITTED');
  const a = E.applyEvent(e, 'M1', 'approve');
  assert.equal(a.to, 'RELEASED');
  assert.equal(e.milestones[0].captureCents, e.milestones[0].amountCents);
  assert.equal(e.history.length, 3);
});

test('Engine 30: out-of-order events are rejected and change nothing', () => {
  const e = E.createEscrow(E.CASES[0]);
  const r = E.applyEvent(e, 'M1', 'approve');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-transition');
  assert.equal(e.milestones[0].state, 'PENDING');
  assert.equal(E.applyEvent(e, 'M9', 'fund').reason, 'unknown-milestone');
});

test('Engine 31: a ruling settles a disputed milestone into the right end state', () => {
  const run = (bps) => {
    const e = E.createEscrow(E.CASES[0]);
    ['fund', 'submit', 'dispute'].forEach((ev) => E.applyEvent(e, 'M2', ev));
    return { e, r: E.applyEvent(e, 'M2', 'rule', { captureBps: bps }) };
  };
  assert.equal(run(5000).r.to, 'SETTLED_PARTIAL');
  assert.equal(run(10000).r.to, 'RELEASED');
  assert.equal(run(0).r.to, 'REFUNDED');
  const p = run(2500);
  assert.equal(p.e.milestones[1].captureCents + p.e.milestones[1].refundCents, 300000);
});

test('Engine 32: invalid rulings are rejected', () => {
  const e = E.createEscrow(E.CASES[0]);
  ['fund', 'submit', 'dispute'].forEach((ev) => E.applyEvent(e, 'M2', ev));
  assert.equal(E.applyEvent(e, 'M2', 'rule', { captureBps: 10001 }).reason, 'bad-ruling');
  assert.equal(E.applyEvent(e, 'M2', 'rule', {}).reason, 'bad-ruling');
  assert.equal(E.applyEvent(e, 'M2', 'rule', { captureBps: -1 }).reason, 'bad-ruling');
});

test('Engine 33: settled milestones are terminal', () => {
  const e = E.createEscrow(E.CASES[0]);
  ['fund', 'submit', 'dispute'].forEach((ev) => E.applyEvent(e, 'M2', ev));
  E.applyEvent(e, 'M2', 'rule', { captureBps: 5000 });
  assert.equal(E.applyEvent(e, 'M2', 'dispute').ok, false);
});

test('Engine 34: escrowStatus moves from open to in dispute to complete', () => {
  const e = E.createEscrow(E.CASES[0]);
  assert.equal(E.escrowStatus(e), 'OPEN');
  ['fund', 'submit', 'dispute'].forEach((ev) => E.applyEvent(e, 'M2', ev));
  assert.equal(E.escrowStatus(e), 'IN_DISPUTE');
  E.applyEvent(e, 'M2', 'rule', { captureBps: 5000 });
  ['M1', 'M3'].forEach((id) => ['fund', 'submit', 'approve'].forEach((ev) => E.applyEvent(e, id, ev)));
  assert.equal(E.escrowStatus(e), 'COMPLETE');
});

test('Engine 35: the order request is an Orders v2 body with one purchase unit per milestone', () => {
  const c = caseById('cold-feet');
  const r = E.buildOrderRequest(c);
  assert.equal(r.method, 'POST');
  assert.equal(r.path, '/v2/checkout/orders');
  assert.equal(r.body.intent, 'AUTHORIZE');
  assert.equal(r.body.purchase_units.length, 3);
  assert.equal(r.body.purchase_units[1].reference_id, 'cold-feet-M2');
  assert.deepEqual(r.body.purchase_units[1].amount, { currency_code: 'USD', value: '3000.00' });
});

test('Engine 36: the order intent follows the case and can be overridden', () => {
  assert.equal(E.buildOrderRequest(caseById('extra-dashboard')).body.intent, 'CAPTURE');
  assert.equal(E.buildOrderRequest(caseById('extra-dashboard'), { intent: 'AUTHORIZE' }).body.intent, 'AUTHORIZE');
});

test('Engine 37: purchase unit amounts sum to the contract total for every case', () => {
  E.CASES.forEach((c) => {
    const sum = E.buildOrderRequest(c).body.purchase_units.reduce((a, u) => a + E.toCents(u.amount.value), 0);
    assert.equal(sum, c.total, c.id);
  });
});

test('Engine 38: capture, void, refund and payout requests target the documented paths', () => {
  const cap = E.buildCaptureRequest('SIM-AUTH-1', 12345, true, 'x');
  assert.equal(cap.path, '/v2/payments/authorizations/SIM-AUTH-1/capture');
  assert.equal(cap.body.amount.value, '123.45');
  assert.equal(cap.body.final_capture, true);
  assert.equal(E.buildVoidRequest('SIM-AUTH-1').path, '/v2/payments/authorizations/SIM-AUTH-1/void');
  const ref = E.buildRefundRequest('SIM-CAP-9', 5000);
  assert.equal(ref.path, '/v2/payments/captures/SIM-CAP-9/refund');
  assert.equal(ref.body.amount.value, '50.00');
  const pay = E.buildPayoutRequest(caseById('cold-feet'), 100000);
  assert.equal(pay.path, '/v1/payments/payouts');
});

test('Engine 39: the payout nets the platform fee and goes to a reserved example address', () => {
  const pay = E.buildPayoutRequest(caseById('cold-feet'), 100000);
  assert.equal(pay.body.items[0].amount.value, '975.00');
  assert.match(pay.body.items[0].receiver, /@example\.com$/);
});

test('Engine 40: idempotency headers are deterministic per request', () => {
  const a = E.buildCaptureRequest('SIM-AUTH-1', 100, true);
  const b = E.buildCaptureRequest('SIM-AUTH-1', 100, true);
  const c = E.buildCaptureRequest('SIM-AUTH-1', 101, true);
  assert.equal(a.headers['PayPal-Request-Id'], b.headers['PayPal-Request-Id']);
  assert.notEqual(a.headers['PayPal-Request-Id'], c.headers['PayPal-Request-Id']);
});

test('Engine 41: the sandbox rejects malformed orders', () => {
  const sb = E.createSandbox(1);
  assert.equal(sb.createOrder(null).status, 422);
  assert.equal(sb.createOrder({ intent: 'SALE', purchase_units: [] }).status, 422);
  assert.equal(sb.createOrder({ intent: 'CAPTURE', purchase_units: [] }).status, 422);
  assert.equal(sb.createOrder({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '0.00' } }] }).status, 422);
});

test('Engine 42: authorize then partial capture then final capture closes the authorization', () => {
  const sb = E.createSandbox(2);
  const o = sb.createOrder(E.buildOrderRequest(caseById('cold-feet')).body).body;
  const a = sb.authorizeOrder(o.id).body.purchase_units[0].payments.authorizations[0];
  assert.equal(a.status, 'CREATED');
  assert.equal(sb.captureAuthorization(a.id, { amount: { currency_code: 'USD', value: '500.00' } }).status, 201);
  assert.equal(sb.db.auths[a.id].status, 'PARTIALLY_CAPTURED');
  const fin = sb.captureAuthorization(a.id, { amount: { currency_code: 'USD', value: '100.00' }, final_capture: true });
  assert.equal(fin.status, 201);
  assert.equal(sb.db.auths[a.id].status, 'CAPTURED');
  assert.equal(sb.db.auths[a.id].releasedCents, 150000 - 60000);
});

test('Engine 43: over-capturing and capturing a closed authorization fail with 422', () => {
  const sb = E.createSandbox(3);
  const o = sb.createOrder(E.buildOrderRequest(caseById('cold-feet')).body).body;
  const a = sb.authorizeOrder(o.id).body.purchase_units[0].payments.authorizations[0];
  const over = sb.captureAuthorization(a.id, { amount: { currency_code: 'USD', value: '1500.01' } });
  assert.equal(over.status, 422);
  assert.equal(over.body.name, 'AMOUNT_EXCEEDS_AUTHORIZED');
  sb.captureAuthorization(a.id, { amount: { currency_code: 'USD', value: '1500.00' } });
  assert.equal(sb.captureAuthorization(a.id, { amount: { currency_code: 'USD', value: '1.00' } }).body.name, 'AUTHORIZATION_ALREADY_CAPTURED');
});

test('Engine 44: a voided authorization cannot be captured or voided again', () => {
  const sb = E.createSandbox(4);
  const o = sb.createOrder(E.buildOrderRequest(caseById('cold-feet')).body).body;
  const a = sb.authorizeOrder(o.id).body.purchase_units[0].payments.authorizations[0];
  assert.equal(sb.voidAuthorization(a.id).status, 204);
  assert.equal(sb.captureAuthorization(a.id, { amount: { currency_code: 'USD', value: '1.00' } }).body.name, 'AUTHORIZATION_VOIDED');
  assert.equal(sb.voidAuthorization(a.id).status, 422);
});

test('Engine 45: refunds are capped at the captured amount and update the capture status', () => {
  const sb = E.createSandbox(5);
  const o = sb.createOrder(E.buildOrderRequest(caseById('extra-dashboard')).body).body;
  const cap = sb.captureOrder(o.id).body.purchase_units[1].payments.captures[0];
  assert.equal(sb.refundCapture(cap.id, { amount: { currency_code: 'USD', value: '1000.00' } }).status, 201);
  assert.equal(sb.db.captures[cap.id].status, 'PARTIALLY_REFUNDED');
  assert.equal(sb.refundCapture(cap.id, { amount: { currency_code: 'USD', value: '1400.01' } }).body.name, 'REFUND_AMOUNT_EXCEEDS_CAPTURE');
  sb.refundCapture(cap.id, { amount: { currency_code: 'USD', value: '1400.00' } });
  assert.equal(sb.db.captures[cap.id].status, 'REFUNDED');
});

test('Engine 46: intent mismatches are rejected by the simulator', () => {
  const sb = E.createSandbox(6);
  const auth = sb.createOrder(E.buildOrderRequest(caseById('cold-feet')).body).body;
  assert.equal(sb.captureOrder(auth.id).body.name, 'ORDER_NOT_CAPTURE_INTENT');
  const cap = sb.createOrder(E.buildOrderRequest(caseById('extra-dashboard')).body).body;
  assert.equal(sb.authorizeOrder(cap.id).body.name, 'ORDER_NOT_AUTHORIZE_INTENT');
  assert.equal(sb.authorizeOrder('SIM-ORD-NOPE').status, 404);
});

test('Engine 47: payout validation and success', () => {
  const sb = E.createSandbox(7);
  assert.equal(sb.createPayout({}).status, 400);
  assert.equal(sb.createPayout({ sender_batch_header: {}, items: [{ amount: { currency_code: 'USD', value: '0.00' } }] }).status, 422);
  const ok = sb.createPayout(E.buildPayoutRequest(caseById('cold-feet'), 10000).body);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.totalCents, 9750);
});

test('Engine 48: simulator ids are deterministic per seed and carry a SIM prefix', () => {
  const mk = (seed) => E.createSandbox(seed).createOrder(E.buildOrderRequest(caseById('cold-feet')).body).body.id;
  assert.equal(mk(9), mk(9));
  assert.notEqual(mk(9), mk(10));
  assert.match(mk(9), /^SIM-ORD-[0-9A-F]{10}$/);
});

test('Engine 49: every ruling on every case runs through the simulator without an error response', () => {
  E.CASES.forEach((c) => [0, 1, 2500, 5000, 8427, 9999, 10000].forEach((bps) => {
    const run = E.runRuling(c, { captureBps: bps });
    const bad = run.steps.filter((s) => s.response.status >= 400);
    assert.deepEqual(bad, [], c.id + ' at ' + bps);
  }));
});

test('Engine 50: the disputed milestone is fully accounted for after a ruling', () => {
  E.CASES.forEach((c) => [0, 3333, 6000, 10000].forEach((bps) => {
    const run = E.runRuling(c, { captureBps: bps });
    const s = E.splitByBps(c.disputed.amountCents, bps);
    assert.equal(s.captureCents + s.refundCents, c.disputed.amountCents);
    const accounted = c.intent === 'AUTHORIZE' ? s.captureCents + run.totals.releasedCents : s.captureCents + run.totals.refundedCents;
    assert.equal(accounted, c.disputed.amountCents, c.id + ' at ' + bps);
  }));
});

test('Engine 51: a zero capture on an authorize case voids and pays nobody', () => {
  const run = E.runRuling(caseById('cold-feet'), { captureBps: 0 });
  const labels = run.steps.map((s) => s.label);
  assert.ok(labels.includes('Void authorization'));
  assert.ok(!labels.includes('Pay seller'));
  assert.equal(run.totals.payoutCents, 0);
});

test('Engine 52: a full capture on a capture-intent case issues no refund', () => {
  const run = E.runRuling(caseById('extra-dashboard'), { captureBps: 10000 });
  assert.ok(!run.steps.map((s) => s.label).includes('Refund ruling amount'));
  assert.equal(run.totals.refundedCents, 0);
});

test('Engine 53: the seller payout equals the capture less the platform fee', () => {
  const run = E.runRuling(caseById('slow-endpoint'), { captureBps: 8427 });
  assert.equal(run.totals.payoutCents + run.totals.feeCents, run.split.captureCents);
  assert.equal(run.totals.feeCents, E.platformFee(run.split.captureCents));
});

test('Engine 54: live execution refuses anything but the sandbox host and a missing token', async () => {
  const req = E.buildVoidRequest('A1');
  assert.equal((await E.executeRequest(req, { token: 't', base: 'https://api-m.paypal.com' })).reason, 'sandbox-only');
  assert.equal((await E.executeRequest(req, {})).reason, 'no-token');
});

test('Engine 55: live execution sends a bearer token to the sandbox host and parses JSON', async () => {
  let seen;
  const res = await E.executeRequest(E.buildOrderRequest(E.CASES[0]), {
    token: 'paste-your-paypal-sandbox-token',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 201, text: async () => '{"id":"X"}' }; }
  });
  assert.equal(res.ok, true);
  assert.equal(res.body.id, 'X');
  assert.equal(seen.url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
  assert.equal(seen.init.headers.Authorization, 'Bearer paste-your-paypal-sandbox-token');
  assert.equal(JSON.parse(seen.init.body).intent, 'AUTHORIZE');
});

test('Engine 56: live execution survives network failures and non-JSON bodies', async () => {
  const req = E.buildVoidRequest('A1');
  const net = await E.executeRequest(req, { token: 't', fetchImpl: async () => { throw new Error('offline'); } });
  assert.match(net.reason, /offline/);
  const raw = await E.executeRequest(req, { token: 't', fetchImpl: async () => ({ ok: false, status: 502, text: async () => '<html>' }) });
  assert.equal(raw.status, 502);
  assert.deepEqual(raw.body, { raw: '<html>' });
});

test('Engine 57: redactHeaders hides the authorization value only', () => {
  const r = E.redactHeaders({ Authorization: 'Bearer secret', 'Content-Type': 'application/json' });
  assert.equal(r.Authorization, 'Bearer <token>');
  assert.equal(r['Content-Type'], 'application/json');
});

test('Engine 58: following the tribunal exactly scores the maximum for the case', () => {
  E.CASES.forEach((c) => {
    const t = E.convene(c).settlement;
    const s = E.scoreRuling(c, { captureBps: t.captureBps, flags: t.flags }, { consulted: false });
    assert.equal(s.errorBps, 0);
    assert.equal(s.score, 1000 + t.flags.length * 150 + 200, c.id);
  });
});

test('Engine 59: consulting the tribunal removes the unaided bonus', () => {
  const c = caseById('cold-feet');
  const a = E.scoreRuling(c, { captureBps: 10000, flags: ['refund_fraud'] }, { consulted: false });
  const b = E.scoreRuling(c, { captureBps: 10000, flags: ['refund_fraud'] }, { consulted: true });
  assert.equal(a.score - b.score, 200);
});

test('Engine 60: accuracy falls by one point per two basis points of error, floored at zero', () => {
  const c = caseById('cold-feet');
  assert.equal(E.scoreRuling(c, { captureBps: 9000, flags: [] }, { consulted: true }).accuracy, 500);
  assert.equal(E.scoreRuling(c, { captureBps: 0, flags: [] }, { consulted: true }).accuracy, 0);
});

test('Engine 61: wrong findings cost points and are reported', () => {
  const c = caseById('cold-feet');
  const s = E.scoreRuling(c, { captureBps: 10000, flags: ['refund_fraud', 'tampered_artifact', 'sla_breach'] }, { consulted: true });
  assert.deepEqual(s.falsePositives.sort(), ['sla_breach', 'tampered_artifact']);
  assert.equal(s.flagPoints, 150 - 200);
  assert.deepEqual(s.missed, []);
});

test('Engine 62: rankFor maps point totals to titles', () => {
  assert.equal(E.rankFor(0), 'Unseated');
  assert.equal(E.rankFor(100), 'Clerk');
  assert.equal(E.rankFor(2400), 'Arbiter');
  assert.equal(E.rankFor(3900), 'Senior Arbiter');
  assert.equal(E.rankFor(5100), 'Chief Arbiter');
});

test('Engine 63: the ledger lists milestones, log, agents, ruling and PayPal calls with every column filled', () => {
  const c = caseById('cold-feet');
  const conv = E.convene(c);
  const run = E.runRuling(c, { captureBps: 10000 });
  const rows = E.buildLedger(c, run, conv, { captureBps: 10000 });
  const types = new Set(rows.map((r) => r.type));
  ['MILESTONE', 'EVIDENCE', 'DISPUTE', 'AGENT', 'RULING', 'PAYPAL'].forEach((t) => assert.ok(types.has(t), t));
  rows.forEach((r, i) => {
    assert.equal(r.seq, i + 1);
    E.LEDGER_COLUMNS.forEach((col) => assert.ok(col.field in r, col.field));
  });
});

test('Engine 64: the ledger is smaller before the tribunal convenes', () => {
  const c = caseById('cold-feet');
  assert.ok(E.buildLedger(c, null, null, null).length < E.buildLedger(c, E.runRuling(c, { captureBps: 5000 }), E.convene(c), { captureBps: 5000 }).length);
});
