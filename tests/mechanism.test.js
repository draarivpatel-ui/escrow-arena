'use strict';

/*
 * Mechanism lab suite for EscrowArena.
 * Locks the adversarial payoff engine: exact integer-cent value conservation
 * in every protocol and attack cell across the bond grid, the honest-play
 * dominance identities, griefing ROI sign conventions, deterrence thresholds
 * and windows, timeout-bounded liveness, the checksummed audit exports and
 * the strict #escrow= bookmark codec.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const E = require('../engine.js');
const M = require('../mechanism-lab.js');

const BOND_GRID = [0, 1, 50, 2500, 5000, 8427, 9999, 10000, 13333, 15000];

/* ---------- parameters and lookups ---------- */

test('MECH 01: five protocols and six behaviors are defined with unique ids', () => {
  assert.equal(M.PROTOCOLS.length, 5);
  assert.equal(M.ATTACKS.length, 6);
  assert.equal(new Set(M.PROTOCOLS.map((p) => p.id)).size, 5);
  assert.equal(new Set(M.ATTACKS.map((a) => a.id)).size, 6);
  assert.equal(M.ATTACKS.filter((a) => a.attacker === null).length, 1);
  assert.equal(M.ATTACKS[0].id, 'honest');
});

test('MECH 02: params copies defaults, honors known finite overrides and rejects unknown keys', () => {
  const p = M.params({ contractCents: 240000, ghostDeliverBps: 2000, bogus: 7, contractCents2: 'x' });
  assert.equal(p.contractCents, 240000);
  assert.equal(p.ghostDeliverBps, 2000);
  assert.equal(p.bogus, undefined);
  const q = M.params({ contractCents: 'abc', arbiterFeeBps: NaN });
  assert.equal(q.contractCents, M.DEFAULTS.contractCents);
  assert.equal(q.arbiterFeeBps, M.DEFAULTS.arbiterFeeBps);
});

test('MECH 03: params clamps the contract to at least one cent and the sweep ceiling', () => {
  assert.equal(M.params({ contractCents: 0 }).contractCents, 1);
  assert.equal(M.params({ contractCents: -50 }).contractCents, 1);
  assert.equal(M.params({ maxBondBps: -5 }).maxBondBps, 0);
  assert.equal(M.params({ maxBondBps: 99999999 }).maxBondBps, 1000000);
});

test('MECH 04: clampBond bounds the ratio and refuses nonfinite input', () => {
  assert.equal(M.clampBond(5000, M.params()), 5000);
  assert.equal(M.clampBond(-10, M.params()), 0);
  assert.equal(M.clampBond(999999, M.params()), 15000);
  assert.equal(M.clampBond(NaN, M.params()), 0);
  assert.equal(M.clampBond(Infinity, M.params()), 0);
  assert.equal(M.clampBond(5001.4, M.params()), 5001);
});

test('MECH 05: bondCents and jurorStakeCents stay integer and floored', () => {
  assert.equal(M.bondCents(300000, 5000), 150000);
  assert.equal(M.bondCents(300000, 1), 30);
  assert.equal(M.bondCents(999, 3333), 332);
  assert.equal(M.jurorStakeCents(M.params(), 5000), 10000);
  assert.equal(M.jurorStakeCents(M.params(), 0), 0);
});

test('MECH 06: protocol and attack lookups return definitions or null', () => {
  assert.equal(M.protocol('mad-collateral').name, 'Symmetric Collateral (MAD)');
  assert.equal(M.attack('sybil-jury').attacker, 'buyer');
  assert.equal(M.attack('timeout-stall').attacker, 'seller');
  assert.equal(M.protocol('nope'), null);
  assert.equal(M.attack('nope'), null);
});

test('MECH 07: unknown protocol or attack ids throw a RangeError', () => {
  assert.throws(() => M.simulateCell('nope', 'honest', 0), RangeError);
  assert.throws(() => M.simulateCell('single-release', 'nope', 0), RangeError);
  assert.throws(() => M.sweep('nope', 'honest'), RangeError);
  assert.throws(() => M.deterrenceProfile('single-release', 'nope'), RangeError);
});

test('MECH 08: the matrix is thirty cells and cellOf locates every one', () => {
  const rows = M.matrix(5000);
  assert.equal(rows.length, 30);
  M.PROTOCOLS.forEach((p) => M.ATTACKS.forEach((a) => {
    assert.ok(M.cellOf(rows, p.id, a.id), p.id + '/' + a.id);
  }));
  assert.equal(M.cellOf(rows, 'nope', 'honest'), null);
});

/* ---------- generated per-cell invariants ---------- */

M.PROTOCOLS.forEach((p) => {
  M.ATTACKS.forEach((a) => {
    test('MECH CONSERVE ' + p.id + '/' + a.id + ': buyer + seller + arbiter + slashed == totalLocked on the grid', () => {
      BOND_GRID.forEach((r) => {
        const c = M.simulateCell(p.id, a.id, r);
        const sum = c.receipts.buyer + c.receipts.seller + c.receipts.arbiter + c.receipts.slashed;
        assert.equal(sum, c.totalLocked, 'bond ' + r);
        assert.equal(c.totalLocked, c.contributions.buyer + c.contributions.seller + c.contributions.arbiter, 'bond ' + r);
        ['buyer', 'seller', 'arbiter', 'slashed'].forEach((k) => assert.ok(c.receipts[k] >= 0, k + ' negative at ' + r));
      });
    });
  });
});

M.PROTOCOLS.forEach((p) => {
  M.ATTACKS.forEach((a) => {
    test('MECH PAYOFF ' + p.id + '/' + a.id + ': party payoffs equal value minus costs and burns', () => {
      [0, 5000, 15000].forEach((r) => {
        const c = M.simulateCell(p.id, a.id, r);
        const net = c.payoffs.buyer + c.payoffs.seller + c.payoffs.arbiter;
        const want = c.utility.deliveredValueCents - c.utility.workCostCents - c.receipts.slashed - c.utility.outOfPotCosts.buyer - c.utility.outOfPotCosts.seller;
        assert.equal(net, want, 'bond ' + r);
      });
    });
  });
});

M.PROTOCOLS.forEach((p) => {
  M.ATTACKS.forEach((a) => {
    test('MECH LIVE ' + p.id + '/' + a.id + ': resolution inside the liveness bound on the grid', () => {
      BOND_GRID.forEach((r) => {
        const c = M.simulateCell(p.id, a.id, r);
        assert.ok(c.periodsToResolve <= c.livenessBoundPeriods, 'bond ' + r + ' took ' + c.periodsToResolve);
        assert.equal(c.resolvedWithinBound, true);
      });
    });
  });
});

M.PROTOCOLS.forEach((p) => {
  M.ATTACKS.filter((a) => a.attacker !== null).forEach((a) => {
    test('MECH DETER ' + p.id + '/' + a.id + ': deterred iff attacker profit is strictly negative', () => {
      BOND_GRID.forEach((r) => {
        const c = M.simulateCell(p.id, a.id, r);
        assert.equal(c.deterred, c.attackerProfitCents < 0, 'bond ' + r);
      });
    });
  });
});

M.PROTOCOLS.forEach((p) => {
  M.ATTACKS.filter((a) => a.attacker !== null).forEach((a) => {
    test('MECH COST ' + p.id + '/' + a.id + ': every funded attack has a positive cost base', () => {
      BOND_GRID.forEach((r) => {
        const c = M.simulateCell(p.id, a.id, r);
        assert.ok(c.attackerCostCents >= 1, 'bond ' + r);
      });
    });
  });
});

M.PROTOCOLS.forEach((p) => {
  M.ATTACKS.filter((a) => a.attacker !== null).forEach((a) => {
    test('MECH ROI ' + p.id + '/' + a.id + ': negative ROI iff the attack is deterred', () => {
      BOND_GRID.forEach((r) => {
        const c = M.simulateCell(p.id, a.id, r);
        assert.equal(c.roiBps < 0, c.attackerProfitCents < 0, 'bond ' + r);
        assert.equal(c.roiBps, Math.floor(c.attackerProfitCents * 10000 / c.attackerCostCents));
      });
    });
  });
});

/* ---------- honest baseline and known cell values ---------- */

test('MECH 09: honest play yields zero attack profit, zero ROI and deterred everywhere', () => {
  BOND_GRID.forEach((r) => {
    M.PROTOCOLS.forEach((p) => {
      const c = M.simulateCell(p.id, 'honest', r);
      assert.equal(c.attackerProfitCents, 0);
      assert.equal(c.roiBps, 0);
      assert.equal(c.deterred, true);
      assert.equal(c.attacker, null);
    });
  });
});

test('MECH 10: the honest seller earns contract minus work cost under every protocol', () => {
  BOND_GRID.forEach((r) => {
    M.PROTOCOLS.forEach((p) => {
      const c = M.simulateCell(p.id, 'honest', r);
      assert.equal(c.payoffs.seller, M.DEFAULTS.contractCents - M.DEFAULTS.workCostCents, p.id + ' @ ' + r);
      assert.equal(c.payoffs.buyer, 0, p.id + ' @ ' + r);
    });
  });
});

test('MECH 11: naive arbiter buyer griefing is profitable and bond-independent', () => {
  [0, 5000, 15000].forEach((r) => {
    const c = M.simulateCell('single-release', 'buyer-grief', r);
    assert.equal(c.attackerProfitCents, 141250);
    assert.equal(c.roiBps, 282500);
    assert.equal(c.verdict, 'naive-50-50');
  });
});

test('MECH 12: milestone tranching cuts the grief profit to the last tranche', () => {
  const c = M.simulateCell('milestone-partial', 'buyer-grief', 5000);
  assert.equal(c.attackerProfitCents, 43750);
  const single = M.simulateCell('single-release', 'buyer-grief', 5000);
  assert.ok(c.attackerProfitCents < single.attackerProfitCents);
});

test('MECH 13: ghosting earns only the arbiter fee leakage under a naive 50/50 split', () => {
  const c1 = M.simulateCell('single-release', 'seller-ghost', 5000);
  const c2 = M.simulateCell('milestone-partial', 'seller-ghost', 5000);
  assert.equal(c1.attackerProfitCents, 5250);
  assert.equal(c2.attackerProfitCents, 5250);
});

test('MECH 14: a single corruptible arbiter sells the whole refund for the bribe price', () => {
  const c = M.simulateCell('single-release', 'bribed-arbiter', 5000);
  assert.equal(c.attackerProfitCents, 227500);
  assert.equal(c.verdict, 'corrupt');
  const c2 = M.simulateCell('milestone-partial', 'bribed-arbiter', 5000);
  assert.equal(c2.attackerProfitCents, 32500);
});

test('MECH 15: MAD collateral makes griefing strictly worse as the bond grows', () => {
  assert.equal(M.simulateCell('mad-collateral', 'buyer-grief', 0).attackerProfitCents, -5000);
  assert.equal(M.simulateCell('mad-collateral', 'buyer-grief', 5000).attackerProfitCents, -155000);
  assert.equal(M.simulateCell('mad-collateral', 'buyer-grief', 15000).attackerProfitCents, -455000);
});

test('MECH 16: MAD slashes the proven ghost and the seller bond funds the refund', () => {
  const c = M.simulateCell('mad-collateral', 'seller-ghost', 5000);
  assert.equal(c.attackerProfitCents, -261000);
  assert.equal(c.receipts.slashed, 75000);
  assert.equal(c.verdict, 'correct');
});

test('MECH 17: a corrupted MAD ruling converts the seller bond into attacker loot', () => {
  const lo = M.simulateCell('mad-collateral', 'bribed-arbiter', 0);
  const hi = M.simulateCell('mad-collateral', 'bribed-arbiter', 5000);
  assert.equal(lo.attackerProfitCents, 235000);
  assert.equal(hi.attackerProfitCents, 310000);
  assert.ok(hi.attackerProfitCents > lo.attackerProfitCents);
});

test('MECH 18: the Schelling jury deters griefing, ghosting, sybil and stall at half bond', () => {
  ['buyer-grief', 'seller-ghost', 'sybil-jury', 'timeout-stall'].forEach((a) => {
    const c = M.simulateCell('schelling-jury', a, 5000);
    assert.ok(c.attackerProfitCents < 0, a + ' ' + c.attackerProfitCents);
    assert.equal(c.deterred, true);
  });
});

test('MECH 19: jury bribery is deterred exactly at the computed 92.5 percent threshold', () => {
  const below = M.simulateCell('schelling-jury', 'bribed-arbiter', 9200);
  const at = M.simulateCell('schelling-jury', 'bribed-arbiter', 9250);
  assert.ok(below.attackerProfitCents > 0, 'below ' + below.attackerProfitCents);
  assert.equal(at.attackerProfitCents, -1000);
  assert.equal(at.deterred, true);
});

test('MECH 20: sybil seats sharing one funding source still count once', () => {
  const c = M.simulateCell('schelling-jury', 'sybil-jury', 5000);
  assert.equal(c.attackerProfitCents, -30500);
  assert.equal(c.verdict, 'correct');
  assert.ok(c.notes.some((n) => /one vote/.test(n)));
});

test('MECH 21: the timelock ghost re-emerges once the bond exceeds the recoverable share', () => {
  const defended = M.simulateCell('timelock-evidence', 'seller-ghost', 5000);
  assert.equal(defended.verdict, 'correct');
  assert.equal(defended.attackerProfitCents, -111000);
  const skipped = M.simulateCell('timelock-evidence', 'seller-ghost', 10000);
  assert.equal(skipped.verdict, 'auto-release');
  assert.equal(skipped.attackerProfitCents, 159000);
});

test('MECH 22: stall tactics beat the timelock because the deadline pays unreviewed', () => {
  [0, 5000, 15000].forEach((r) => {
    const c = M.simulateCell('timelock-evidence', 'timeout-stall', r);
    assert.equal(c.attackerProfitCents, 153000);
    assert.equal(c.verdict, 'auto-release');
    assert.equal(c.periodsToResolve, M.DEFAULTS.autoReleasePeriods);
  });
});

test('MECH 23: timelock bribery is bond-independent because the corrupt ruling refunds the bond', () => {
  [0, 5000, 15000].forEach((r) => {
    assert.equal(M.simulateCell('timelock-evidence', 'bribed-arbiter', r).attackerProfitCents, 235000);
  });
});

test('MECH 24: attacks with no lever only burn their setup cost', () => {
  assert.equal(M.simulateCell('single-release', 'sybil-jury', 5000).attackerProfitCents, -3000);
  assert.equal(M.simulateCell('single-release', 'timeout-stall', 5000).attackerProfitCents, -750);
  assert.equal(M.simulateCell('mad-collateral', 'sybil-jury', 5000).attackerProfitCents, -3000);
  assert.equal(M.simulateCell('timelock-evidence', 'sybil-jury', 5000).attackerProfitCents, -3000);
});

test('MECH 25: contract size scales every payoff proportionally and stays conserved', () => {
  const c = M.simulateCell('schelling-jury', 'bribed-arbiter', 5000, { contractCents: 240000 });
  const sum = c.receipts.buyer + c.receipts.seller + c.receipts.arbiter + c.receipts.slashed;
  assert.equal(sum, c.totalLocked);
  assert.notEqual(c.attackerProfitCents, M.simulateCell('schelling-jury', 'bribed-arbiter', 5000).attackerProfitCents);
});

/* ---------- sweep, deterrence profile, protocol summary ---------- */

test('MECH 26: the sweep spans zero to maxBondBps at fifty-basis-point resolution', () => {
  const pts = M.sweep('schelling-jury', 'bribed-arbiter');
  assert.equal(pts.length, M.DEFAULTS.maxBondBps / 50 + 1);
  assert.equal(pts[0].bondBps, 0);
  assert.equal(pts[pts.length - 1].bondBps, 15000);
  pts.forEach((pt, i) => {
    assert.equal(pt.bondBps, i * 50);
    const c = M.simulateCell('schelling-jury', 'bribed-arbiter', pt.bondBps);
    assert.equal(pt.profitCents, c.attackerProfitCents);
    assert.equal(pt.deterred, c.deterred);
  });
});

test('MECH 27: jury bribery profit falls monotonically in the bond and deters once', () => {
  const pts = M.sweep('schelling-jury', 'bribed-arbiter');
  for (let i = 1; i < pts.length; i += 1) assert.ok(pts[i].profitCents <= pts[i - 1].profitCents, 'non-monotone at ' + pts[i].bondBps);
  const pf = M.deterrenceProfile('schelling-jury', 'bribed-arbiter');
  assert.equal(pf.deterrenceMinBps, 9250);
  assert.equal(pf.monotoneDeterrence, true);
  assert.equal(pf.neverDeters, false);
  assert.equal(pf.crossings.length, 1);
  assert.equal(pf.crossings[0].dir, 'deterred');
});

test('MECH 28: the timelock ghost reports a deterrence window, not a threshold', () => {
  const pf = M.deterrenceProfile('timelock-evidence', 'seller-ghost');
  assert.equal(pf.monotoneDeterrence, false);
  assert.equal(pf.detersAtZero, true);
  assert.equal(pf.deterrenceMinBps, 0);
  assert.equal(pf.deterrenceMaxBps, 8800);
  assert.equal(pf.crossings.length, 1);
  assert.equal(pf.crossings[0].dir, 're-emerged');
  assert.equal(pf.crossings[0].at, 8850);
});

test('MECH 29: never-deters attacks report null thresholds', () => {
  const cases = [
    ['single-release', 'buyer-grief'],
    ['single-release', 'bribed-arbiter'],
    ['mad-collateral', 'bribed-arbiter'],
    ['timelock-evidence', 'bribed-arbiter'],
    ['timelock-evidence', 'timeout-stall'],
    ['milestone-partial', 'seller-ghost']
  ];
  cases.forEach(([p, a]) => {
    const pf = M.deterrenceProfile(p, a);
    assert.equal(pf.neverDeters, true, p + '/' + a);
    assert.equal(pf.deterrenceMinBps, null);
    assert.equal(pf.deterrenceMaxBps, null);
  });
});

test('MECH 30: always-deterred attacks report a zero threshold with no crossings', () => {
  ['buyer-grief', 'seller-ghost', 'sybil-jury', 'timeout-stall'].forEach((a) => {
    const pf = M.deterrenceProfile('schelling-jury', a);
    assert.equal(pf.deterrenceMinBps, 0, a);
    assert.equal(pf.detersAtZero, true, a);
    assert.equal(pf.monotoneDeterrence, true, a);
  });
});

test('MECH 31: the jury is the only protocol reaching incentive compatibility at half bond', () => {
  const jury = M.protocolSummary('schelling-jury', 5000);
  assert.equal(jury.incentiveCompatible, true);
  assert.equal(jury.minBondBpsForIC, 9250);
  ['single-release', 'milestone-partial', 'mad-collateral', 'timelock-evidence'].forEach((p) => {
    const s = M.protocolSummary(p, 5000);
    assert.equal(s.incentiveCompatible, false, p);
    assert.equal(s.minBondBpsForIC, null, p);
  });
});

test('MECH 32: undeterrable levers are reported per protocol at half bond', () => {
  assert.deepEqual(M.protocolSummary('single-release', 5000).undeterrable, ['buyer-grief', 'seller-ghost', 'bribed-arbiter']);
  assert.deepEqual(M.protocolSummary('milestone-partial', 5000).undeterrable, ['buyer-grief', 'seller-ghost', 'bribed-arbiter']);
  assert.deepEqual(M.protocolSummary('mad-collateral', 5000).undeterrable, ['bribed-arbiter']);
  assert.deepEqual(M.protocolSummary('schelling-jury', 5000).undeterrable, []);
  assert.deepEqual(M.protocolSummary('timelock-evidence', 5000).undeterrable, ['bribed-arbiter', 'timeout-stall']);
});

test('MECH 33: the dominance margin is the negated best attacker profit', () => {
  M.PROTOCOLS.forEach((p) => {
    const s = M.protocolSummary(p.id, 5000);
    assert.equal(s.dominanceMarginCents, -s.maxAttackProfitCents);
    const cells = M.matrix(5000).filter((c) => c.protocol === p.id && c.attack !== 'honest');
    assert.equal(s.maxAttackProfitCents, Math.max.apply(null, cells.map((c) => c.attackerProfitCents)));
  });
});

test('MECH 34: non-monotone deterrence windows surface in the protocol summary', () => {
  const s = M.protocolSummary('timelock-evidence', 5000);
  assert.equal(s.nonMonotoneAttacks.length, 1);
  assert.equal(s.nonMonotoneAttacks[0].attack, 'seller-ghost');
  assert.equal(s.nonMonotoneAttacks[0].minBps, 0);
  assert.equal(s.nonMonotoneAttacks[0].maxBps, 8800);
});

test('MECH 35: leverless attacks are excluded from incentive compatibility', () => {
  const s = M.protocolSummary('single-release', 15000);
  assert.ok(s.undeterrable.indexOf('sybil-jury') === -1);
  assert.ok(s.undeterrable.indexOf('timeout-stall') === -1);
  const t = M.protocolSummary('timelock-evidence', 15000);
  assert.ok(t.undeterrable.indexOf('timeout-stall') !== -1);
});

test('MECH 36: the honest cell payoff block is exposed on every summary', () => {
  M.PROTOCOLS.forEach((p) => {
    const s = M.protocolSummary(p.id, 5000);
    assert.deepEqual(s.honestPayoffs, { buyer: 0, seller: 120000, arbiter: 0 });
  });
});

/* ---------- canonical JSON, checksum, exports ---------- */

test('MECH 37: canonicalJSON sorts keys recursively for a stable checksum', () => {
  const a = M.canonicalJSON({ b: 1, a: { d: 2, c: 3 } });
  assert.equal(a, '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(M.canonicalJSON([{ z: 1, y: 2 }]), '[{"y":2,"z":1}]');
  const hostile = JSON.parse('{"safe":1,"__proto__":{"polluted":true}}');
  const hostileCanon = M.canonicalJSON(hostile);
  assert.equal(hostileCanon.includes('__proto__'), true);
  assert.notEqual(hostileCanon, M.canonicalJSON({ safe: 1 }));
  assert.equal({}.polluted, undefined);
  const canonicalDigest = crypto.createHash('sha256').update(hostileCanon, 'utf8').digest('hex');
  const verified = M.verifyReportChecksum({
    body: hostile,
    canonical: hostileCanon,
    checksum: { digest: canonicalDigest }
  });
  assert.equal(verified.ok, true);
});

test('MECH 38: the audit report carries the schema, the stated bond and thirty cells', () => {
  const r = M.auditReport(7500);
  assert.equal(r.body.schema, 'escrow-arena/mechanism-audit-v1');
  assert.equal(r.body.bondBps, 7500);
  assert.equal(r.body.matrix.length, 30);
  assert.equal(r.body.protocols.length, 5);
  r.body.matrix.forEach((c) => assert.equal(c.bondBps, 7500));
});

test('MECH 39: the audit bond parameter clamps into the sweep range', () => {
  assert.equal(M.auditReport(-5).body.bondBps, 0);
  assert.equal(M.auditReport(999999).body.bondBps, 15000);
  assert.equal(M.auditReport().body.bondBps, 5000);
});

test('MECH 40: the checksum matches Node crypto over the canonical body', () => {
  const r = M.auditReport(5000);
  const node = crypto.createHash('sha256').update(r.canonical, 'utf8').digest('hex');
  assert.equal(r.checksum.digest, node);
  assert.equal(r.checksum.digest, E.sha256Hex(r.canonical));
  assert.match(r.checksum.kind, /unkeyed/);
  assert.match(r.checksum.kind, /not a signature/);
});

test('MECH 41: identical inputs reproduce identical digests', () => {
  const r1 = M.auditReport(5000);
  const r2 = M.auditReport(5000);
  assert.equal(r1.checksum.digest, r2.checksum.digest);
  const r3 = M.auditReport(5001);
  assert.notEqual(r3.checksum.digest, r1.checksum.digest);
});

test('MECH 42: replay verification passes on a fresh report', () => {
  const r = M.auditReport(5000);
  const res = M.verifyReportChecksum(r);
  assert.equal(res.ok, true);
  assert.equal(res.reason, 'match');
  assert.equal(res.claimed, res.recomputed);
});

test('MECH 43: a mutated canonical string fails closed', () => {
  const r = M.auditReport(5000);
  const fake = { body: r.body, canonical: r.canonical.replace('300000', '300001'), checksum: r.checksum };
  const res = M.verifyReportChecksum(fake);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'canonical-mismatch');
});

test('MECH 44: a mutated body fails verification even with a matching canonical string', () => {
  const r = M.auditReport(5000);
  const body = JSON.parse(JSON.stringify(r.body));
  body.matrix[0].attackerProfitCents += 1;
  const res = M.verifyReportChecksum({ body: body, canonical: r.canonical, checksum: r.checksum });
  assert.equal(res.ok, false);
});

test('MECH 45: a mutated digest fails verification', () => {
  const r = M.auditReport(5000);
  const d = r.checksum.digest;
  const res = M.verifyReportChecksum({ body: r.body, canonical: r.canonical, checksum: { digest: 'f'.repeat(64) } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'digest-mismatch');
  assert.equal(d.length, 64);
});

test('MECH 46: malformed reports are rejected without throwing', () => {
  assert.equal(M.verifyReportChecksum(null).ok, false);
  assert.equal(M.verifyReportChecksum({}).ok, false);
  assert.equal(M.verifyReportChecksum('x').ok, false);
});

test('MECH 47: csvCell escapes formula-triggering characters', () => {
  assert.equal(M.csvCell('=1+1'), "'=1+1");
  assert.equal(M.csvCell('+2'), "'+2");
  assert.equal(M.csvCell('-9'), "'-9");
  assert.equal(M.csvCell('@x'), "'@x");
  assert.equal(M.csvCell('\t=x'), "'\t=x");
  assert.equal(M.csvCell('\r=x'), '"\'\r=x"');
  assert.equal(M.csvCell('safe'), 'safe');
  assert.equal(M.csvCell(42), '42');
  assert.equal(M.csvCell(-9), '-9');
  assert.equal(M.csvCell('\u200B=cmd'), "'\u200B=cmd");
  assert.equal(M.csvCell('\u00A0+cmd'), "'\u00A0+cmd");
  assert.equal(M.csvCell(' \uFEFF@cmd'), "' \uFEFF@cmd");
  assert.equal(M.csvCell('\uFF1D2+2'), "'\uFF1D2+2");
});

test('MECH 48: csvCell quotes commas, quotes and newlines', () => {
  assert.equal(M.csvCell('a,b'), '"a,b"');
  assert.equal(M.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(M.csvCell('x\ny'), '"x\ny"');
  assert.equal(M.csvCell(''), '');
  assert.equal(M.csvCell(null), '');
  assert.equal(M.csvCell(undefined), '');
});

test('MECH 49: a hostile label can never reach a CSV cell unescaped', () => {
  const r = M.auditReport(5000);
  const body = JSON.parse(JSON.stringify(r.body));
  body.matrix[0].protocol = '=cmd|"/c calc"!A1';
  body.matrix[1].verdict = '@SUM(1)';
  const csv = M.reportCSV({ body: body });
  const lines = csv.split('\n');
  // The = is prefixed with a quote, then the field is quoted for its own
  // double quotes, so the hostile formula can never reach a spreadsheet.
  assert.ok(lines[1].indexOf("'=cmd") !== -1, lines[1]);
  assert.ok(!/(^|,)=cmd/.test(lines[1]));
  assert.ok(lines[2].indexOf("'@SUM(1)") !== -1);
});

test('MECH 50: the CSV export has a header, thirty rows and every cell accounted', () => {
  const r = M.auditReport(5000);
  const csv = M.reportCSV(r);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 31);
  assert.match(lines[0], /^protocol,attack,bond_bps,attacker/);
  lines.slice(1).forEach((line) => {
    const cols = line.split(',');
    assert.equal(cols.length, 15);
    const inSum = Number(cols[8]);
    const outSum = Number(cols[4]) + Number(cols[5]) + Number(cols[6]) + Number(cols[7]);
    assert.equal(outSum, inSum, line);
  });
});

test('MECH 51: the Markdown audit lists all five protocols and the digest disclaimer', () => {
  const r = M.auditReport(5000);
  const md = M.reportMarkdown(r);
  assert.match(md, /^# EscrowArena mechanism audit/);
  M.PROTOCOLS.forEach((p) => assert.ok(md.indexOf('| ' + p.id + ' |') !== -1, p.id));
  assert.match(md, /unkeyed SHA-256 tamper-detection digest/);
  assert.ok(md.indexOf(r.checksum.digest) !== -1);
  assert.match(md, /integer cents/);
});

test('MECH 52: the audit disclosures state the model boundary plainly', () => {
  const r = M.auditReport(5000);
  assert.ok(r.body.disclosures.length >= 3);
  assert.ok(r.body.disclosures.some((d) => /not measurements of any live system/.test(d)));
  assert.ok(r.body.disclosures.some((d) => /economically deterred under the stated rules only/.test(d)));
});

/* ---------- bookmark codec ---------- */

test('MECH 53: bookmarks round-trip state through the strict prefix', () => {
  const states = [
    { contractCents: 300000, bondBps: 5000, protocol: 'single-release', attack: 'honest' },
    { contractCents: 320000, bondBps: 8427, protocol: 'schelling-jury', attack: 'sybil-jury' },
    { contractCents: 1, bondBps: 0, protocol: 'timelock-evidence', attack: 'timeout-stall' },
    { contractCents: 1000000000, bondBps: 15000, protocol: 'mad-collateral', attack: 'bribed-arbiter' }
  ];
  states.forEach((st) => {
    const h = M.encodeBookmark(st);
    assert.ok(h.indexOf(M.BOOKMARK_PREFIX) === 0, h);
    const rt = M.decodeBookmark(h);
    assert.deepEqual(rt, st);
  });
});

test('MECH 54: malformed hashes are rejected', () => {
  [null, undefined, '', '#escrow=', '#escrow=!!!', '#escrow=AAAA', '#other=abc', 'escrow=abc', '#escrow= eyJ9'].forEach((h) => {
    assert.equal(M.decodeBookmark(h), null, JSON.stringify(h));
  });
});

test('MECH 55: out-of-range state inside a well-formed hash is rejected', () => {
  const raw = (o) => '#escrow=' + M.b64encode(JSON.stringify(o));
  assert.equal(M.decodeBookmark(raw({ c: 0, r: 0, p: 'single-release', a: 'honest' })), null);
  assert.equal(M.decodeBookmark(raw({ c: -5, r: 0, p: 'single-release', a: 'honest' })), null);
  assert.equal(M.decodeBookmark(raw({ c: 1000000001, r: 0, p: 'single-release', a: 'honest' })), null);
  assert.equal(M.decodeBookmark(raw({ c: 300000, r: -1, p: 'single-release', a: 'honest' })), null);
  assert.equal(M.decodeBookmark(raw({ c: 300000, r: 15001, p: 'single-release', a: 'honest' })), null);
  assert.equal(M.decodeBookmark(raw({ c: 300000, r: 100001, p: 'single-release', a: 'honest' })), null);
  assert.equal(M.decodeBookmark(raw({ c: 300000, r: 0, p: 'evil-protocol', a: 'honest' })), null);
  assert.equal(M.decodeBookmark(raw({ c: 300000, r: 0, p: 'single-release', a: 'evil-attack' })), null);
  assert.equal(M.decodeBookmark(raw('not json')), null);
  assert.equal(M.decodeBookmark(raw([1, 2, 3])), null);
  assert.equal(M.decodeBookmark(raw({})), null);
});

test('MECH 56: b64 round-trips ASCII and rejects bad length', () => {
  ['', 'a', 'ab', 'abc', '{"k":1}', 'hello world 123 !@#'].forEach((s) => {
    assert.equal(M.b64decode(M.b64encode(s)), s);
  });
  assert.equal(M.b64decode('A'), null);
});

test('MECH 57: b64 handles non-ASCII text through percent decoding', () => {
  const s = 'accent and pound sign \u00e9\u00a3';
  const rt = M.b64decode(M.b64encode(s));
  assert.equal(typeof rt, 'string');
});

test('MECH 58: the bookmark never contains credentials or secrets', () => {
  const h = M.encodeBookmark({ contractCents: 300000, bondBps: 5000, protocol: 'single-release', attack: 'honest' });
  assert.doesNotMatch(h, /token|secret|key|bearer/i);
  assert.equal(h.indexOf(M.BOOKMARK_PREFIX), 0);
});

/* ---------- self tests ---------- */

test('MECH 59: the module self-test bundle reports every check passing', () => {
  const st = M.selfTests();
  assert.equal(st.total, 12);
  assert.equal(st.passing, 12);
  assert.equal(st.allPass, true);
  assert.equal(new Set(st.checks.map((c) => c.id)).size, st.checks.length);
});

test('MECH 60: self-test ids cover the required proof surface', () => {
  const ids = M.selfTests().checks.map((c) => c.id);
  ['sha256-kat-empty', 'sha256-kat-abc', 'sha256-kat-fox', 'conservation-grid', 'payoff-identity', 'threshold-monotonicity', 'liveness-bound', 'csv-injection', 'tamper-detection', 'bookmark-roundtrip', 'roi-sign', 'matrix-shape'].forEach((id) => {
    assert.ok(ids.indexOf(id) !== -1, id);
  });
});

test('MECH 61: self-tests honor parameter overrides and still pass', () => {
  const st = M.selfTests({ contractCents: 260000 });
  assert.equal(st.allPass, true);
});

test('MECH 62: self-test details carry real measured evidence', () => {
  const st = M.selfTests();
  const grid = st.checks.find((c) => c.id === 'conservation-grid');
  assert.match(grid.detail, /cells checked/);
  const live = st.checks.find((c) => c.id === 'liveness-bound');
  assert.match(live.detail, /worst cell resolves by period \d+/);
  const tamper = st.checks.find((c) => c.id === 'tamper-detection');
  assert.match(tamper.detail, /mutation|mutations/);
});

test('MECH 63: SHA-256 known-answer vectors match FIPS 180-4 exactly', () => {
  assert.equal(E.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(E.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(E.sha256Hex('The quick brown fox jumps over the lazy dog'), 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
  assert.equal(E.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

/* ---------- liveness and narrative structure ---------- */

test('MECH 64: the naive protocols suffer the longest dispute paths', () => {
  const worst = Math.max.apply(null, M.matrix(5000).map((c) => c.periodsToResolve));
  assert.equal(worst, M.DEFAULTS.detectPeriods + M.DEFAULTS.maxStallPeriods + M.DEFAULTS.arbitPeriods);
  assert.ok(worst <= M.DEFAULTS.livenessBoundPeriods);
});

test('MECH 65: every cell exposes verdict, periods and modeling notes', () => {
  M.matrix(5000).forEach((c) => {
    assert.ok(typeof c.verdict === 'string' && c.verdict.length > 0);
    assert.ok(Number.isSafeInteger(c.periodsToResolve) && c.periodsToResolve > 0);
    assert.ok(Array.isArray(c.notes));
  });
  const corrupt = M.simulateCell('single-release', 'bribed-arbiter', 5000);
  assert.ok(corrupt.notes.some((n) => /bribe/.test(n)));
  const stall = M.simulateCell('timelock-evidence', 'timeout-stall', 5000);
  assert.ok(stall.notes.some((n) => /deadline|stall/i.test(n)));
});

test('MECH 66: ghost deliveries expose ghostDeliverBps while honest play delivers in full', () => {
  assert.equal(M.simulateCell('single-release', 'seller-ghost', 0).deliveredBps, M.DEFAULTS.ghostDeliverBps);
  assert.equal(M.simulateCell('single-release', 'timeout-stall', 0).deliveredBps, M.DEFAULTS.ghostDeliverBps);
  assert.equal(M.simulateCell('single-release', 'honest', 0).deliveredBps, 10000);
  assert.equal(M.simulateCell('single-release', 'buyer-grief', 0).deliveredBps, 10000);
});

test('MECH 67: MAD posts symmetric bonds from both sides and returns honest ones', () => {
  const c = M.simulateCell('mad-collateral', 'honest', 5000);
  assert.equal(c.contributions.seller, 150000);
  assert.equal(c.contributions.buyer, 450000);
  assert.equal(c.receipts.slashed, 0);
  assert.equal(c.receipts.seller, 450000);
});

test('MECH 68: the sybil slash flows half to coherent jurors and half to the burn', () => {
  const c = M.simulateCell('schelling-jury', 'sybil-jury', 5000);
  const slashed = 20000;
  assert.equal(c.receipts.slashed, slashed / 2);
  const juryReward = slashed / 2;
  assert.ok(c.receipts.arbiter >= juryReward);
});

test('MECH 69: overriding protocol parameters re-derives thresholds honestly', () => {
  const rich = M.deterrenceProfile('schelling-jury', 'bribed-arbiter', { bribeRiskFactor: 4 });
  const base = M.deterrenceProfile('schelling-jury', 'bribed-arbiter');
  assert.ok(rich.deterrenceMinBps < base.deterrenceMinBps, 'pricier bribes must deter earlier');
  const cheap = M.deterrenceProfile('schelling-jury', 'bribed-arbiter', { bribeRiskFactor: 1 });
  assert.equal(cheap.neverDeters, true, 'cheap bribes outlast every reachable bond');
  const frac = M.simulateCell('schelling-jury', 'bribed-arbiter', 5000, { bribeRiskFactor: 1.37 });
  assert.equal(Number.isInteger(frac.contributions.buyer), true);
  assert.equal(frac.receipts.buyer + frac.receipts.seller + frac.receipts.arbiter + frac.receipts.slashed, frac.totalLocked);
});

test('MECH 70: a bigger jury pool dilutes sybil packing without breaking conservation', () => {
  const c = M.simulateCell('schelling-jury', 'sybil-jury', 5000, { poolSizeSeats: 30 });
  const sum = c.receipts.buyer + c.receipts.seller + c.receipts.arbiter + c.receipts.slashed;
  assert.equal(sum, c.totalLocked);
  const small = M.simulateCell('schelling-jury', 'sybil-jury', 5000);
  assert.ok(Math.abs(c.attackerProfitCents) < Math.abs(small.attackerProfitCents));
});

test('MECH 71: csv cells are neutralized even when whitespace precedes a formula', () => {
  assert.equal(M.csvCell(' =1+1'), "' =1+1");
  assert.equal(M.csvCell('  @sum'), "'  @sum");
  assert.equal(M.csvCell('\n=1+1'), "\"'\n=1+1\"");
});

test('MECH 72: bookmarks reject extra or missing fields even when values decode cleanly', () => {
  const base = { c: 300000, r: 5000, p: 'single-release', a: 'honest' };
  const extra = M.BOOKMARK_PREFIX + M.b64encode(JSON.stringify({ ...base, x: 1 }));
  const missing = M.BOOKMARK_PREFIX + M.b64encode(JSON.stringify({ c: 300000, r: 5000, p: 'single-release' }));
  const wrongVersionShape = M.BOOKMARK_PREFIX + M.b64encode(JSON.stringify(['c', 300000]));
  assert.equal(M.decodeBookmark(extra), null);
  assert.equal(M.decodeBookmark(missing), null);
  assert.equal(M.decodeBookmark(wrongVersionShape), null);
});

test('MECH 73: integer structural parameters cannot be forced below one', () => {
  const p = M.params({ poolSizeSeats: 0, jurorCount: 0, appealJurorCount: -2, trancheCount: 0 });
  for (const key of ['poolSizeSeats', 'jurorCount', 'appealJurorCount', 'trancheCount']) {
    assert.equal(Number.isSafeInteger(p[key]), true, key);
    assert.ok(p[key] >= 1, key + '=' + p[key]);
  }
  const c = M.simulateCell('schelling-jury', 'sybil-jury', 5000, { poolSizeSeats: 0 });
  assert.equal(Number.isFinite(c.totalLocked), true);
  assert.equal(c.receipts.buyer + c.receipts.seller + c.receipts.arbiter + c.receipts.slashed, c.totalLocked);
});
