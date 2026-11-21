'use strict';

/*
 * Analytics test suite for EscrowArena.
 * Verifies money reconciliation over every case and ruling split, the SHA-256
 * manifest audit against Node crypto, tribunal fairness identities, the
 * exhaustive state transition matrix, integer basis point boundaries and the
 * reproducible verification bundle. All values are computed here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const E = require('../engine.js');
const A = require('../analytics.js');

// ---------------------------------------------------------------
// Section 1: money reconciliation
// ---------------------------------------------------------------
test('AN 01: the money sweep covers every case and every default ruling', () => {
  const m = A.moneyReconciliationSweep();
  assert.equal(m.cases, 6);
  assert.equal(m.rulings, 8);
  assert.equal(m.checked, 48);
  assert.equal(m.passing, 48);
  assert.equal(m.allPass, true);
  assert.equal(m.problems.length, 0);
});

test('AN 02: every row keeps capture plus refund equal to the milestone amount', () => {
  for (const r of A.moneyReconciliationSweep().rows) {
    assert.equal(r.captureCents + r.refundCents, E.getCase(r.caseId).disputed.amountCents, r.caseId + ' @ ' + r.bps);
  }
});

test('AN 03: the payout plus fee equals the capture for every row', () => {
  for (const r of A.moneyReconciliationSweep().rows) {
    assert.equal(r.payoutCents + r.feeCents, r.captureCents);
  }
});

test('AN 04: no simulator step returns an error status in the sweep', () => {
  const c = E.CASES[0];
  for (const bps of [0, 5000, 10000]) {
    const run = E.runRuling(c, { captureBps: bps });
    assert.ok(run.steps.every(s => s.response.status < 400));
  }
});

test('AN 05: a custom ruling list is respected and still reconciles', () => {
  const m = A.moneyReconciliationSweep([0, 1234, 10000]);
  assert.equal(m.rulings, 3);
  assert.equal(m.checked, 18);
  assert.equal(m.allPass, true);
});

// ---------------------------------------------------------------
// Section 2: SHA-256 manifest audit
// ---------------------------------------------------------------
test('AN 06: the manifest audit checks every artifact in every case', () => {
  const m = A.manifestAudit();
  const expected = E.CASES.reduce((s, c) => s + c.manifest.length, 0);
  assert.equal(m.checked, expected);
  assert.equal(m.allStoredHashesMatch, true);
});

test('AN 07: the pure JS SHA-256 matches Node crypto for every approved artifact', () => {
  for (const c of E.CASES) {
    for (const a of c.manifest) {
      const nodeDigest = crypto.createHash('sha256').update(a.approvedContent, 'utf8').digest('hex');
      assert.equal(E.sha256Hex(a.approvedContent), nodeDigest, c.id + ' ' + a.path);
      assert.equal(a.approvedSha, nodeDigest, c.id + ' stored ' + a.path);
    }
  }
});

test('AN 08: exactly one tampered artifact exists across all cases', () => {
  const m = A.manifestAudit();
  assert.equal(m.tampered, 1);
  const bad = m.rows.filter(r => !r.recomputedMatch);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].caseId, 'swapped-build');
});

test('AN 09: recomputed hashes agree with the stored case hashes', () => {
  for (const r of A.manifestAudit().rows) {
    assert.equal(r.storedHashesMatch, true, r.caseId + ' ' + r.path);
    assert.match(r.approvedSha, /^[0-9a-f]{64}$/);
    assert.match(r.deliveredSha, /^[0-9a-f]{64}$/);
  }
});

// ---------------------------------------------------------------
// Section 3: tribunal fairness
// ---------------------------------------------------------------
test('AN 10: the tribunal fairness table covers all six cases', () => {
  const f = A.tribunalFairness();
  assert.equal(f.cases, 6);
  assert.equal(f.allQualityIdentitiesHold, true);
  assert.equal(f.allOwnRulingsMax, true);
});

test('AN 11: the quality factor identity holds for each case', () => {
  for (const r of A.tribunalFairness().rows) {
    const q = 0.6 + 0.2 * (r.slaScoreBps / 10000) + 0.2 * (r.hashScoreBps / 10000);
    assert.ok(Math.abs(Math.round(q * 10000) - r.qualityBps) <= 1, r.caseId);
    assert.equal(r.qualityIdentityOk, true);
  }
});

test('AN 12: the tribunal own ruling scores the maximum for each case', () => {
  for (const r of A.tribunalFairness().rows) {
    assert.equal(r.ownRulingIsMax, true, r.caseId);
    assert.equal(r.ownScore, 1000 + r.flags.length * 150 + 200, r.caseId);
  }
});

test('AN 13: the capture split is bounded and the money adds up per case', () => {
  for (const r of A.tribunalFairness().rows) {
    assert.ok(r.captureBps >= 0 && r.captureBps <= 10000);
    assert.equal(r.captureCents + r.refundCents, E.getCase(r.caseId).disputed.amountCents);
  }
});

test('AN 14: the flagged SLA case measures p95 above its claim', () => {
  const slow = A.tribunalFairness().rows.find(r => r.caseId === 'slow-endpoint');
  assert.ok(slow.measuredP95Ms > slow.slaP95Ms);
  assert.equal(slow.flags.includes('sla_breach'), true);
});

test('AN 15: the tampered case is detected by the fairness table', () => {
  const swapped = A.tribunalFairness().rows.find(r => r.caseId === 'swapped-build');
  assert.equal(swapped.tampered, true);
  assert.equal(swapped.flags.includes('tampered_artifact'), true);
});

// ---------------------------------------------------------------
// Section 4: state transition matrix
// ---------------------------------------------------------------
test('AN 16: the state matrix is exhaustive and fully consistent', () => {
  const t = A.stateTransitionMatrix();
  assert.equal(t.states, 7);
  assert.equal(t.events, 5);
  assert.equal(t.checked, 35);
  assert.equal(t.passing, 35);
  assert.equal(t.allPass, true);
});

test('AN 17: terminal states reject every event', () => {
  const t = A.stateTransitionMatrix();
  for (const state of ['RELEASED', 'SETTLED_PARTIAL', 'REFUNDED']) {
    const rows = t.rows.filter(r => r.state === state);
    assert.ok(rows.every(r => !r.allowed && !r.accepted), state);
  }
});

test('AN 18: DISPUTED accepts a rule and resolves to a settlement state', () => {
  const t = A.stateTransitionMatrix();
  const rule = t.rows.find(r => r.state === 'DISPUTED' && r.event === 'rule');
  assert.equal(rule.allowed, true);
  assert.equal(rule.accepted, true);
  assert.equal(rule.ok, true);
});

test('AN 19: invalid transitions carry a documented reason', () => {
  const c = E.CASES[0];
  const esc = E.createEscrow(c);
  const res = E.applyEvent(esc, c.milestones[0].id, 'approve');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-transition');
});

// ---------------------------------------------------------------
// Section 5: basis point boundaries
// ---------------------------------------------------------------
test('AN 20: every basis point from 0 to 10000 reconciles exactly', () => {
  const b = A.basisPointBoundarySweep();
  assert.equal(b.checked, 10001);
  assert.equal(b.allPass, true);
  assert.equal(b.failures.length, 0);
});

test('AN 21: out of range bps values are clamped, not rejected', () => {
  const b = A.basisPointBoundarySweep();
  assert.equal(b.clampedHighBps, 10000);
  assert.equal(b.clampedLowBps, 0);
});

test('AN 22: zero and full capture are exact', () => {
  const b = A.basisPointBoundarySweep();
  assert.equal(b.extremes.zeroCapture.captureCents, 0);
  assert.equal(b.extremes.zeroCapture.refundCents, b.amountCents);
  assert.equal(b.extremes.fullCapture.captureCents, b.amountCents);
  assert.equal(b.extremes.fullCapture.refundCents, 0);
});

// ---------------------------------------------------------------
// Section 6: verification bundle
// ---------------------------------------------------------------
test('AN 23: every self check in the bundle is true', () => {
  const v = A.verificationBundle();
  for (const [k, val] of Object.entries(v.selfChecks)) assert.equal(val, true, k);
  assert.equal(v.allChecksPass, true);
});

test('AN 24: the bundle is deterministic byte for byte in JSON', () => {
  assert.equal(JSON.stringify(A.verificationBundle()), JSON.stringify(A.verificationBundle()));
});

test('AN 25: the bundle declares its schema and source module', () => {
  const v = A.verificationBundle();
  assert.equal(v.schema, 'escrow-arena/verification-v2');
  assert.equal(v.generatedBy, 'analytics.js');
});

test('AN 26: the bundle carries all five analysis summaries', () => {
  const v = A.verificationBundle();
  assert.equal(v.money.checked, 48);
  assert.equal(v.manifest.checked, 13);
  assert.equal(v.fairness.cases, 6);
  assert.equal(v.transitions.checked, 35);
  assert.equal(v.boundary.checked, 10001);
});

test('AN 27: the bundle summary reports the real configuration', () => {
  const v = A.verificationBundle();
  assert.equal(v.summary.totalDisputes, E.CASES.length);
  assert.equal(v.summary.totalFlags, E.FLAG_IDS.length);
  assert.equal(v.summary.platformFeeBps, E.PLATFORM_FEE_BPS);
  assert.equal(v.summary.currency, 'USD');
});

test('AN 28: no live call is claimed and the sandbox host is the only configured host', () => {
  const v = A.verificationBundle();
  assert.equal(v.selfChecks.noLiveCallMade, true);
  assert.equal(v.summary.sandboxBase, E.SANDBOX_BASE);
  assert.match(v.summary.sandboxBase, /^https:\/\/api-m\.sandbox\.paypal\.com$/);
});
