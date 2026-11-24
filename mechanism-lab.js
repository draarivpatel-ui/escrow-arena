/*
 * EscrowArena adversarial mechanism lab.
 *
 * A deterministic game-theoretic workbench: five escrow and dispute protocols
 * are stressed against six adversarial behaviors. Every cell of the matrix
 * computes contributions into an escrow pot and receipts out of it in exact
 * integer cents, so value conservation (buyer + seller + arbiter + slashed
 * equals totalLocked) is provable per cell. From those ledgers the module
 * derives the attacker net profit, griefing ROI, deterrence thresholds over a
 * bond ratio sweep, the honest-strategy dominance margin and the minimum bond
 * ratio at which a protocol becomes incentive compatible.
 *
 * Zero dependencies beyond engine.js (reused for SHA-256 and cent formatting).
 * UMD: require() in Node, window.EscrowArenaMech in a browser.
 *
 * Honest modeling notes, stated plainly:
 * - The naive arbiter cannot verify delivery and splits any disputed pot 50/50
 *   after its fee. That is an intentional weakness, not a claim about courts.
 * - The evidence arbiter (collateral and evidence-bond protocols) rules
 *   correctly on verifiable evidence but is a single corruptible principal.
 * - The Schelling jury rules correctly when honest seats hold the majority of
 *   the final panel. Pool seats that share a funding source vote as one weight,
 *   which is the mechanism's anti-sybil rule, stated as an assumption.
 * - The time-locked release trades correctness for guaranteed liveness: funds
 *   auto-release at the deadline if no bonded dispute completes in the window.
 * - "Deterred" means the attacker's best funded attempt nets strictly less than
 *   honest play. Nothing here is legal, financial or protocol-design advice.
 */
(function (root, factory) {
  var E = (typeof module === 'object' && module.exports)
    ? require('./engine.js')
    : root.EscrowArena;
  var api = factory(E);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EscrowArenaMech = api;
}(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  /* ---------- parameters ---------- */

  var DEFAULTS = {
    contractCents: 300000,        // escrowed amount for the disputed milestone
    workCostCents: 180000,        // seller cost of an honest full delivery
    deliveredValueCents: 300000,  // buyer utility of a full delivery
    ghostDeliverBps: 1000,        // ghost ships this share of value and cost
    arbiterFeeBps: 250,           // naive arbiter fee on the disputed pot
    disputeCostCents: 5000,       // attacker effort cost of running a dispute
    setupCostCents: 3000,         // fixed attack tooling cost (bribe/sybil/stall)
    bribeCents: 60000,            // price of corrupting one arbiter principal
    trancheCount: 3,              // milestone partial-release tranche count
    jurorCount: 5,                // Schelling panel size
    appealJurorCount: 9,          // appeal panel size
    poolSizeSeats: 15,            // total staked seats in the jury pool
    juryFeeCents: 7500,           // fee the dispute initiator posts to convene
    slashRewardBps: 5000,         // share of a slashed stake paid to coherent seats
    bribeRiskFactor: 2,           // jurors price a bribe at this multiple of stake
    sybilPackedSeats: 8,          // seats a sybil packs hoping for pool majority
    detectPeriods: 4,             // when a rational defender files after anomaly
    arbitPeriods: 8,              // evidence/naive arbiter ruling duration
    jurorVotePeriods: 6,          // jury instance ruling duration
    appealPeriods: 9,             // appeal ruling duration
    autoReleasePeriods: 14,       // timelock release window
    maxStallPeriods: 12,          // attacker stamina for delay tactics
    stallCostPerPeriodCents: 500, // attacker cost per stalled period
    livenessBoundPeriods: 40,     // every cell must resolve inside this bound
    maxBondBps: 15000             // bond ratio sweep ceiling (150% of contract)
  };

  var PROTOCOLS = [
    { id: 'single-release', name: 'Single-Release Trust',
      lever: 'none',
      blurb: 'Buyer funds the whole milestone up front. A naive arbiter cannot verify delivery and splits any disputed pot 50/50 after its fee.' },
    { id: 'milestone-partial', name: 'Milestone Partial-Release',
      lever: 'none',
      blurb: 'The contract is tranched; accepted tranches are final. Only the unaccepted remainder is exposed to a naive 50/50 dispute split.' },
    { id: 'mad-collateral', name: 'Symmetric Collateral (MAD)',
      lever: 'bond',
      blurb: 'Both parties post a bond. An evidence arbiter rules correctly and slashes a false claimant: half burned, half to the wronged party.' },
    { id: 'schelling-jury', name: 'Schelling-Point Stake-Slashing Jury',
      lever: 'juror-stake',
      blurb: 'Staked jurors vote on verifiable evidence; the losing side of the final verdict is slashed. Seats sharing a funding source count once.' },
    { id: 'timelock-evidence', name: 'Time-Locked Release + Evidence Bond',
      lever: 'evidence-bond',
      blurb: 'Funds auto-release at the deadline unless a bonded dispute was filed. A false claim forfeits the bond; the deadline guarantees liveness.' }
  ];

  var ATTACKS = [
    { id: 'honest', name: 'Honest Delivery', attacker: null, deliverBps: 10000,
      blurb: 'Seller delivers to spec, buyer accepts, everyone goes home.' },
    { id: 'buyer-grief', name: 'Buyer Griefing', attacker: 'buyer', deliverBps: 10000,
      blurb: 'Buyer keeps the delivered work and files a false chargeback to claw funds back.' },
    { id: 'seller-ghost', name: 'Seller Ghosting', attacker: 'seller', deliverBps: null,
      blurb: 'Seller ships a sliver of the work (ghost share), claims full payment and goes quiet.' },
    { id: 'bribed-arbiter', name: 'Bribed Arbiter Collusion', attacker: 'buyer', deliverBps: 10000,
      blurb: 'The attacker pays the decision makers to rule against the evidence for a wrongful refund.' },
    { id: 'sybil-jury', name: 'Sybil Jury Packing', attacker: 'buyer', deliverBps: 10000,
      blurb: 'The attacker mints fake juror identities to pack the vote and force a wrongful verdict.' },
    { id: 'timeout-stall', name: 'Timeout Stalling', attacker: 'seller', deliverBps: null,
      blurb: 'A ghosting seller stalls past the auto-release deadline so funds pay out unreviewed.' }
  ];

  function params(over) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    if (over && typeof over === 'object') {
      Object.keys(over).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) && Number.isFinite(over[k])) p[k] = over[k];
      });
    }
    p.contractCents = Math.max(1, Math.round(p.contractCents));
    p.maxBondBps = Math.max(0, Math.min(1000000, Math.round(p.maxBondBps)));
    ['trancheCount', 'jurorCount', 'appealJurorCount', 'poolSizeSeats'].forEach(function (k) {
      p[k] = Math.max(1, Math.round(p[k]));
    });
    return p;
  }

  function clampBond(bps, p) {
    if (!Number.isFinite(bps)) return 0;
    return Math.max(0, Math.min(p.maxBondBps, Math.round(bps)));
  }

  // Collateral each side posts under MAD, and the evidence bond under the
  // timelock protocol, are the same fraction of contract value.
  function bondCents(contractCents, bondBps) {
    return Math.floor(contractCents * Math.max(0, bondBps) / 10000);
  }

  // Jury pool stake per seat: the whole pool bonds bondBps of the contract,
  // split evenly across pool seats.
  function jurorStakeCents(p, bondBps) {
    return Math.floor(p.contractCents * Math.max(0, bondBps) / 10000 / p.poolSizeSeats);
  }

  function protocol(id) {
    for (var i = 0; i < PROTOCOLS.length; i += 1) if (PROTOCOLS[i].id === id) return PROTOCOLS[i];
    return null;
  }
  function attack(id) {
    for (var i = 0; i < ATTACKS.length; i += 1) if (ATTACKS[i].id === id) return ATTACKS[i];
    return null;
  }

  /* ---------- ledger ---------- */

  // A cell result is built on an explicit pot ledger: every cent that enters
  // the protocol (contract, bonds, stakes, bribes, fees) is a contribution,
  // every cent leaving is a receipt for buyer, seller, the arbitration bucket
  // or the burn sink. Conservation is checked, not assumed.
  function ledger() {
    return {
      contrib: { buyer: 0, seller: 0, arbiter: 0 },
      out: { buyer: 0, seller: 0, arbiter: 0, slashed: 0 }
    };
  }

  function stallTotal(p, periods) {
    return periods * p.stallCostPerPeriodCents;
  }

  /* ---------- cell simulator ---------- */

  // Simulates one (protocol, attack, bondBps) cell. Returns the pot ledger,
  // each party's payoff (receipts minus contributions plus delivered utility
  // minus out-of-pot costs), the attacker's marginal profit over honest play,
  // the cost base for ROI, and liveness data. closeLedger throws if a rule
  // fails to conserve value, so a broken cell can never pass silently.
  function simulateCell(protocolId, attackId, bondBps, opts) {
    var P = params(opts);
    var bps = clampBond(bondBps, P);
    var proto = protocol(protocolId);
    var atk = attack(attackId);
    if (!proto) throw new RangeError('unknown protocol: ' + protocolId);
    if (!atk) throw new RangeError('unknown attack: ' + attackId);

    var contract = P.contractCents;
    var B = bondCents(contract, bps);               // collateral or evidence bond
    var S = jurorStakeCents(P, bps);                // stake per jury pool seat
    var deliverBps = atk.deliverBps === null ? P.ghostDeliverBps : atk.deliverBps;
    var deliveredValue = Math.floor(P.deliveredValueCents * deliverBps / 10000);
    var workCost = Math.floor(P.workCostCents * deliverBps / 10000);

    var L = ledger();
    var costs = { buyer: 0, seller: 0 };            // out-of-pot effort costs
    var outlay = 0;                                 // irreversible attacker spend
    var periods = 2;                                // fund + deliver minimum
    var verdict = 'none';
    var notes = [];

    // The naive arbiter takes its fee from the disputed pot, then splits what
    // is left 50/50. The buyer takes the residual cent so nothing is dropped.
    function naiveSplit(potCents) {
      var fee = Math.floor(potCents * P.arbiterFeeBps / 10000);
      var net = potCents - fee;
      var seller = Math.floor(net / 2);
      L.out.arbiter += fee;
      L.out.seller += seller;
      L.out.buyer += net - seller;
      verdict = 'naive-50-50';
      periods = Math.max(periods, P.detectPeriods + P.arbitPeriods);
    }
    // The evidence arbiter rules correctly: the seller keeps only the
    // delivered share of the contract and the rest is refunded.
    function evidenceSplit() {
      var seller = Math.floor(contract * deliverBps / 10000);
      L.out.seller += seller;
      L.out.buyer += contract - seller;
      verdict = 'correct';
      periods = Math.max(periods, P.detectPeriods + P.arbitPeriods);
    }
    // Slashes a party's bond: half burned, half paid to the wronged party. An
    // odd bond's residual cent goes to the burned share via floor/ceil.
    function slashBond(who, bond, toWhom) {
      var burned = Math.floor(bond / 2);
      var comp = bond - burned;
      L.out.slashed += burned;
      L.out[toWhom] += comp;
      if (bond > 0) notes.push(who + ' bond slashed ' + bond + ' cents (' + burned + ' burned, ' + comp + ' to ' + toWhom + ')');
    }

    if (attackId === 'honest') {
      L.contrib.buyer += contract;
      if (protocolId === 'mad-collateral') {
        L.contrib.buyer += B; L.contrib.seller += B;
        L.out.buyer += B; L.out.seller += B;
      }
      L.out.seller += contract;
      if (protocolId === 'timelock-evidence') periods = P.autoReleasePeriods;
      notes.push('no dispute; seller paid in full');
    } else if (protocolId === 'single-release') {
      L.contrib.buyer += contract;
      if (attackId === 'sybil-jury') {
        outlay = P.setupCostCents;
        costs.buyer += P.setupCostCents;
        L.out.seller += contract;
        notes.push('no jury exists to pack; the attack has no lever');
      } else if (attackId === 'bribed-arbiter') {
        L.contrib.buyer += P.bribeCents;
        L.out.arbiter += P.bribeCents;
        var feeB = Math.floor(contract * P.arbiterFeeBps / 10000);
        L.out.arbiter += feeB;
        L.out.buyer += contract - feeB;
        costs.buyer += P.disputeCostCents;
        outlay = P.bribeCents + P.disputeCostCents;
        verdict = 'corrupt';
        periods = P.detectPeriods + P.arbitPeriods;
        notes.push('the sole arbiter took the bribe and ruled a full refund');
      } else if (attackId === 'timeout-stall') {
        naiveSplit(contract);
        periods = P.detectPeriods + P.maxStallPeriods + P.arbitPeriods;
        costs.seller += P.setupCostCents + stallTotal(P, P.maxStallPeriods);
        outlay = P.setupCostCents + stallTotal(P, P.maxStallPeriods) + workCost;
        notes.push('no deadline exists to exploit; stalling only delays the same 50/50 split');
      } else {
        naiveSplit(contract);
        if (attackId === 'buyer-grief') { costs.buyer += P.disputeCostCents; outlay = P.disputeCostCents; }
        if (attackId === 'seller-ghost') { costs.seller += P.setupCostCents; outlay = P.setupCostCents + workCost; }
      }
    } else if (protocolId === 'milestone-partial') {
      L.contrib.buyer += contract;
      var tranche = Math.floor(contract / P.trancheCount);
      // Every dispute contests the last tranche: at most trancheCount-1
      // tranches are final, so a fully delivered contract still leaves the
      // last tranche's release as the attack surface.
      var accepted = Math.max(0, Math.min(P.trancheCount - 1, Math.floor(P.trancheCount * deliverBps / 10000)));
      var released = accepted * tranche;
      var remainder = contract - released;
      L.out.seller += released;
      if (attackId === 'sybil-jury') {
        costs.buyer += P.setupCostCents;
        outlay = P.setupCostCents;
        L.out.seller += remainder;
        notes.push('no jury exists to pack; the attack has no lever');
      } else if (attackId === 'bribed-arbiter') {
        L.contrib.buyer += P.bribeCents;
        L.out.arbiter += P.bribeCents;
        var fee2 = Math.floor(remainder * P.arbiterFeeBps / 10000);
        L.out.arbiter += fee2;
        L.out.buyer += remainder - fee2;
        costs.buyer += P.disputeCostCents;
        outlay = P.bribeCents + P.disputeCostCents;
        verdict = 'corrupt';
        periods = P.detectPeriods + P.arbitPeriods;
        notes.push('the corrupted arbiter claws back only the unreleased remainder; accepted tranches are final');
      } else {
        var fee3 = Math.floor(remainder * P.arbiterFeeBps / 10000);
        var net3 = remainder - fee3;
        var seller3 = Math.floor(net3 / 2);
        L.out.arbiter += fee3;
        L.out.seller += seller3;
        L.out.buyer += net3 - seller3;
        verdict = 'naive-50-50';
        periods = P.detectPeriods + P.arbitPeriods;
        if (attackId === 'buyer-grief') { costs.buyer += P.disputeCostCents; outlay = P.disputeCostCents; }
        if (attackId === 'seller-ghost') { costs.seller += P.setupCostCents; outlay = P.setupCostCents + workCost; }
        if (attackId === 'timeout-stall') {
          costs.seller += P.setupCostCents + stallTotal(P, P.maxStallPeriods);
          outlay = P.setupCostCents + stallTotal(P, P.maxStallPeriods) + workCost;
          periods = P.detectPeriods + P.maxStallPeriods + P.arbitPeriods;
          notes.push('no deadline exists to exploit; stalling only delays the same 50/50 split');
        }
      }
    } else if (protocolId === 'mad-collateral') {
      L.contrib.buyer += contract + B;
      L.contrib.seller += B;
      if (attackId === 'sybil-jury') {
        costs.buyer += P.setupCostCents;
        outlay = P.setupCostCents;
        L.out.buyer += B; L.out.seller += contract + B;
        notes.push('no jury exists to pack; the attack has no lever');
      } else if (attackId === 'bribed-arbiter') {
        L.contrib.buyer += P.bribeCents;
        L.out.arbiter += P.bribeCents;
        L.out.buyer += contract + B;         // refund + attacker bond back
        slashBond('seller', B, 'buyer');     // wrong ruling slashes the seller bond
        costs.buyer += P.disputeCostCents;
        outlay = P.bribeCents + P.disputeCostCents;
        verdict = 'corrupt';
        periods = P.detectPeriods + P.arbitPeriods;
        notes.push('a corrupted ruling also slashes the honest seller bond to the attacker: bigger bonds, bigger loot');
      } else if (attackId === 'buyer-grief') {
        evidenceSplit();                     // keeps = full contract to seller
        L.out.seller += B;                   // honest seller's bond returns
        slashBond('buyer', B, 'seller');     // false claim forfeits the buyer bond
        costs.buyer += P.disputeCostCents;
        outlay = P.disputeCostCents + B;
      } else {
        L.out.buyer += B;                    // honest buyer's bond returns
        evidenceSplit();
        slashBond('seller', B, 'buyer');     // proven ghost forfeits the seller bond
        if (attackId === 'seller-ghost') {
          costs.seller += P.setupCostCents;
          outlay = P.setupCostCents + workCost + B;
        }
        if (attackId === 'timeout-stall') {
          costs.seller += P.setupCostCents + stallTotal(P, P.maxStallPeriods);
          outlay = P.setupCostCents + stallTotal(P, P.maxStallPeriods) + workCost + B;
          periods = P.detectPeriods + P.maxStallPeriods + P.arbitPeriods;
          notes.push('no deadline exists to exploit; the bond still gets slashed after the delay');
        }
      }
    } else if (protocolId === 'schelling-jury') {
      if (attackId === 'sybil-jury') {
        // Packed seats share one funding source, so the anti-sybil rule counts
        // them as a single vote. The drawn packed seats are then slashed as
        // incoherent with the correct verdict.
        var packed = Math.min(P.sybilPackedSeats, P.poolSizeSeats);
        var drawnPacked = Math.floor(P.jurorCount * packed / P.poolSizeSeats);
        var instStakesS = P.jurorCount * S;
        L.contrib.buyer += contract + P.juryFeeCents + drawnPacked * S;
        L.contrib.arbiter += instStakesS - drawnPacked * S; // honest jurors' stakes only
        var slashedPacked = drawnPacked * S;
        var toCoherentS = Math.floor(slashedPacked * P.slashRewardBps / 10000);
        L.out.arbiter += (instStakesS - slashedPacked) + toCoherentS + P.juryFeeCents;
        L.out.slashed += slashedPacked - toCoherentS;
        L.out.seller += contract;
        costs.buyer += P.setupCostCents;
        outlay = P.setupCostCents + P.juryFeeCents + slashedPacked;
        verdict = 'correct';
        periods = P.detectPeriods + P.jurorVotePeriods;
        notes.push('pool seats sharing one funding source count once: ' + packed + ' packed seats still yield one vote and ' + drawnPacked + ' drawn seats were slashed');
      } else {
        var instStakes = P.jurorCount * S;
        var needInst = Math.floor(P.jurorCount / 2) + 1;
        var needAppeal = Math.floor(P.appealJurorCount / 2) + 1;
        var seatsNeeded = needInst + needAppeal;
        var isBribe = attackId === 'bribed-arbiter';
        // Rounded so a fractional risk factor still prices the bribe in
        // integer cents and the pot ledger never sees a fraction.
        var bribeTotal = isBribe ? Math.round(seatsNeeded * S * P.bribeRiskFactor) : 0;
        if (isBribe) {
          // A funded bribe controls both panels: the wrong verdict stands,
          // and the honest minority seats are slashed for incoherence.
          var appealStakes = P.appealJurorCount * S;
          var honestSeats = P.jurorCount + P.appealJurorCount - seatsNeeded;
          var slashedHonest = honestSeats * S;
          var reward = Math.floor(slashedHonest * P.slashRewardBps / 10000);
          L.contrib.buyer += contract + P.juryFeeCents + bribeTotal;
          L.contrib.arbiter += instStakes + appealStakes;
          L.out.buyer += contract + P.juryFeeCents;
          L.out.arbiter += seatsNeeded * S + reward + bribeTotal;
          L.out.slashed += slashedHonest - reward;
          costs.buyer += P.disputeCostCents;
          outlay = bribeTotal + P.disputeCostCents;
          verdict = 'corrupt';
          periods = P.detectPeriods + P.jurorVotePeriods + P.appealPeriods;
          notes.push('the bribe must buy ' + needInst + ' instance and ' + needAppeal + ' appeal seats at ' + P.bribeRiskFactor + 'x stake each, or the appeal reverses and the seats are slashed');
        } else {
          // Correct unanimous verdict: stakes return, and the jury fee goes to
          // the winner (the panel keeps it when the claim is false).
          var buyerWins = attackId === 'seller-ghost' || attackId === 'timeout-stall';
          var keep = Math.floor(contract * deliverBps / 10000);
          L.contrib.buyer += contract + P.juryFeeCents;
          L.contrib.arbiter += instStakes;
          L.out.seller += keep;
          L.out.buyer += contract - keep;
          if (buyerWins) L.out.buyer += P.juryFeeCents;
          else L.out.arbiter += P.juryFeeCents;
          L.out.arbiter += instStakes;
          verdict = 'correct';
          periods = P.detectPeriods + P.jurorVotePeriods;
          if (attackId === 'buyer-grief') { costs.buyer += P.disputeCostCents; outlay = P.disputeCostCents + P.juryFeeCents; }
          if (attackId === 'seller-ghost') { costs.seller += P.setupCostCents; outlay = P.setupCostCents + workCost; }
          if (attackId === 'timeout-stall') {
            costs.seller += P.setupCostCents + stallTotal(P, P.maxStallPeriods);
            outlay = P.setupCostCents + stallTotal(P, P.maxStallPeriods) + workCost;
            periods = P.detectPeriods + P.maxStallPeriods + P.jurorVotePeriods;
            notes.push('the jury votes on the evidence deadline regardless of stall tactics');
          }
        }
      }
    } else if (protocolId === 'timelock-evidence') {
      L.contrib.buyer += contract;
      var recovery = contract - Math.floor(contract * deliverBps / 10000);
      var stallPeriods = attackId === 'timeout-stall'
        ? Math.min(P.maxStallPeriods, Math.max(0, P.autoReleasePeriods - P.detectPeriods) + 2)
        : 0;
      var filePeriod = P.detectPeriods + stallPeriods;
      // The honest buyer files a bonded dispute only while the bond costs less
      // than the recoverable share minus dispute effort.
      var defends = B <= recovery - P.disputeCostCents && filePeriod < P.autoReleasePeriods;
      if (attackId === 'sybil-jury') {
        costs.buyer += P.setupCostCents;
        outlay = P.setupCostCents;
        L.out.seller += contract;
        periods = P.autoReleasePeriods;
        notes.push('no jury exists to pack; the attack has no lever');
      } else if (attackId === 'bribed-arbiter') {
        L.contrib.buyer += B + P.bribeCents;
        L.out.arbiter += P.bribeCents;
        L.out.buyer += contract + B;
        costs.buyer += P.disputeCostCents;
        outlay = P.bribeCents + P.disputeCostCents;
        verdict = 'corrupt';
        periods = P.detectPeriods + P.arbitPeriods;
        notes.push('the corrupted arbiter returns the evidence bond to the attacker and rules a full refund');
      } else if (attackId === 'buyer-grief') {
        L.contrib.buyer += B;
        L.out.seller += contract;
        slashBond('buyer', B, 'seller');
        costs.buyer += P.disputeCostCents;
        outlay = P.disputeCostCents + B;
        verdict = 'correct';
        periods = P.detectPeriods + P.arbitPeriods;
        notes.push('the evidence review exposes the false claim and slashes the buyer bond');
      } else if (!defends) {
        L.out.seller += contract;
        verdict = 'auto-release';
        periods = P.autoReleasePeriods;
        if (attackId === 'timeout-stall') {
          costs.seller += P.setupCostCents + stallTotal(P, stallPeriods);
          outlay = P.setupCostCents + stallTotal(P, stallPeriods) + workCost;
          notes.push('stalling pushed the bonded filing (period ' + filePeriod + ') past the auto-release deadline (' + P.autoReleasePeriods + '): liveness pays the ghost');
        } else {
          costs.seller += P.setupCostCents;
          outlay = P.setupCostCents + workCost;
          notes.push('the evidence bond (' + B + ' cents) exceeds the recoverable share minus dispute cost, so the buyer never files and the ghost collects at the deadline');
        }
      } else {
        L.contrib.buyer += B;
        var keeps = Math.floor(contract * deliverBps / 10000);
        L.out.seller += keeps;
        L.out.buyer += contract - keeps + B;
        costs.seller += P.setupCostCents + (attackId === 'timeout-stall' ? stallTotal(P, stallPeriods) : 0);
        outlay = P.setupCostCents + (attackId === 'timeout-stall' ? stallTotal(P, stallPeriods) : 0) + workCost;
        verdict = 'correct';
        periods = filePeriod + P.arbitPeriods;
        notes.push('the bonded dispute landed inside the window: the refund matches the undelivered share');
      }
    }

    var contributions = L.contrib;
    var receipts = L.out;
    var totalLocked = contributions.buyer + contributions.seller + contributions.arbiter;
    var receiptSum = receipts.buyer + receipts.seller + receipts.arbiter + receipts.slashed;
    if (receiptSum !== totalLocked) {
      throw new Error('ledger does not conserve value at ' + protocolId + '/' + attackId + ': in ' + totalLocked + ' out ' + receiptSum);
    }

    var payoffs = {
      buyer: receipts.buyer - contributions.buyer + deliveredValue - costs.buyer,
      seller: receipts.seller - contributions.seller - workCost - costs.seller,
      arbiter: receipts.arbiter - contributions.arbiter
    };

    // Honest baselines are recomputed on the fly so a parameter override can
    // never skew the profit identity.
    var honestPayoffs = attackId === 'honest' ? payoffs : simulateCell(protocolId, 'honest', bps, P).payoffs;
    var role = atk.attacker;
    var profit = role === null ? 0 : payoffs[role] - honestPayoffs[role];

    return {
      protocol: protocolId, attack: attackId, bondBps: bps,
      contributions: contributions, receipts: receipts, totalLocked: totalLocked,
      utility: { deliveredValueCents: deliveredValue, workCostCents: workCost, outOfPotCosts: costs },
      payoffs: payoffs, honestPayoffs: honestPayoffs,
      attacker: role, attackerProfitCents: profit,
      attackerCostCents: role === null ? 0 : outlay,
      roiBps: role === null ? 0 : Math.floor(profit * 10000 / Math.max(1, outlay)),
      deterred: role === null ? true : profit < 0,
      verdict: verdict, periodsToResolve: periods,
      resolvedWithinBound: periods <= P.livenessBoundPeriods,
      livenessBoundPeriods: P.livenessBoundPeriods,
      deliveredBps: deliverBps, notes: notes
    };
  }

  /* ---------- matrix, sweep and protocol summary ---------- */

  function matrix(bondBps, opts) {
    var P = params(opts);
    var rows = [];
    PROTOCOLS.forEach(function (proto) {
      ATTACKS.forEach(function (atk) {
        rows.push(simulateCell(proto.id, atk.id, bondBps, P));
      });
    });
    return rows;
  }

  function cellOf(rows, protocolId, attackId) {
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].protocol === protocolId && rows[i].attack === attackId) return rows[i];
    }
    return null;
  }

  // Attacker net profit over a bond ratio sweep at 50 bps resolution.
  function sweep(protocolId, attackId, opts) {
    var P = params(opts);
    var out = [];
    for (var r = 0; r <= P.maxBondBps; r += 50) {
      var cell = simulateCell(protocolId, attackId, r, P);
      out.push({ bondBps: cell.bondBps, profitCents: cell.attackerProfitCents, roiBps: cell.roiBps, deterred: cell.deterred });
    }
    return out;
  }

  // The smallest bond ratio where the attack is strictly unprofitable and
  // stays unprofitable. Attacks that re-emerge report a deterrence window
  // instead; attacks that never deter report neverDeters.
  function deterrenceProfile(protocolId, attackId, opts) {
    var pts = sweep(protocolId, attackId, opts);
    var crossings = [];
    var minBps = null;
    var maxBps = null;
    for (var i = 0; i < pts.length; i += 1) {
      var d = pts[i].deterred;
      var prev = i > 0 ? pts[i - 1].deterred : null;
      if (d && prev === false) crossings.push({ at: pts[i].bondBps, dir: 'deterred' });
      if (!d && prev === true) crossings.push({ at: pts[i].bondBps, dir: 're-emerged' });
      if (d) {
        if (minBps === null) minBps = pts[i].bondBps;
        maxBps = pts[i].bondBps;
      }
    }
    // Monotone means the deterred set is upward-closed: no 're-emerged'
    // crossing. A deterrence window (deterred prefix that re-emerges, e.g.
    // when the evidence bond outgrows the recoverable share) is reported
    // honestly as non-monotone with its min and max edges.
    var reemerged = crossings.some(function (c) { return c.dir === 're-emerged'; });
    return {
      protocol: protocolId, attack: attackId,
      deterrenceMinBps: minBps, deterrenceMaxBps: maxBps,
      monotoneDeterrence: !reemerged,
      neverDeters: minBps === null,
      crossings: crossings,
      detersAtZero: pts.length > 0 && pts[0].deterred
    };
  }

  // Per-protocol headline numbers at a given bond ratio. Only attacks that
  // actually have a lever on the protocol count toward incentive
  // compatibility; leverless attacks are deterred trivially.
  function protocolSummary(protocolId, bondBps, opts) {
    var P = params(opts);
    var proto = protocol(protocolId);
    var profiles = ATTACKS.filter(function (a) { return a.attacker !== null; })
      .map(function (a) { return deterrenceProfile(protocolId, a.id, P); });
    var levered = profiles.filter(function (pf) {
      if (pf.attack === 'sybil-jury') return proto.lever === 'juror-stake';
      if (pf.attack === 'timeout-stall') return proto.id === 'timelock-evidence';
      return true;
    });
    var undeterrable = levered.filter(function (pf) { return pf.neverDeters; });
    var windows = levered.filter(function (pf) { return !pf.monotoneDeterrence; });
    var minIC = null;
    if (!undeterrable.length && levered.length && levered.every(function (pf) { return pf.deterrenceMinBps !== null; })) {
      var lo = Math.max.apply(null, levered.map(function (pf) { return pf.deterrenceMinBps; }));
      if (!windows.length) {
        minIC = lo;
      } else {
        var hi = Math.min.apply(null, levered.map(function (pf) { return pf.deterrenceMaxBps; }));
        if (lo <= hi) minIC = lo;
      }
    }
    var cells = ATTACKS.map(function (a) { return simulateCell(protocolId, a.id, bondBps, P); });
    var maxProfit = Math.max.apply(null, cells.filter(function (c) { return c.attack !== 'honest'; }).map(function (c) { return c.attackerProfitCents; }));
    var honestCell = cellOf(cells, protocolId, 'honest');
    return {
      protocol: protocolId, name: proto.name, lever: proto.lever, bondBps: clampBond(bondBps, P),
      maxAttackProfitCents: maxProfit,
      dominanceMarginCents: -maxProfit,
      incentiveCompatible: minIC !== null,
      minBondBpsForIC: minIC,
      undeterrable: undeterrable.map(function (pf) { return pf.attack; }),
      nonMonotoneAttacks: windows.map(function (pf) { return { attack: pf.attack, minBps: pf.deterrenceMinBps, maxBps: pf.deterrenceMaxBps }; }),
      honestPayoffs: honestCell ? honestCell.payoffs : null,
      profiles: profiles
    };
  }

  /* ---------- SHA-256 audit export ---------- */

  // Canonical JSON: recursively sorted keys so the checksum is stable.
  function canonicalize(v) {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).sort().forEach(function (k) { o[k] = canonicalize(v[k]); });
      return o;
    }
    return v;
  }

  function canonicalJSON(v) { return JSON.stringify(canonicalize(v)); }

  function auditReport(bondBps, opts) {
    var P = params(opts);
    var bps = clampBond(bondBps === undefined ? 5000 : bondBps, P);
    var cells = matrix(bps, P);
    var summaries = PROTOCOLS.map(function (p2) { return protocolSummary(p2.id, bps, P); });
    var body = {
      schema: 'escrow-arena/mechanism-audit-v1',
      generatedBy: 'mechanism-lab.js',
      params: P,
      bondBps: bps,
      matrix: cells.map(function (c) {
        return {
          protocol: c.protocol, attack: c.attack, bondBps: c.bondBps,
          contributions: c.contributions, receipts: c.receipts, totalLocked: c.totalLocked,
          payoffs: c.payoffs, attacker: c.attacker,
          attackerProfitCents: c.attackerProfitCents, attackerCostCents: c.attackerCostCents,
          roiBps: c.roiBps, deterred: c.deterred, verdict: c.verdict,
          periodsToResolve: c.periodsToResolve, resolvedWithinBound: c.resolvedWithinBound
        };
      }),
      protocols: summaries.map(function (s) {
        return {
          protocol: s.protocol, dominanceMarginCents: s.dominanceMarginCents,
          maxAttackProfitCents: s.maxAttackProfitCents,
          incentiveCompatible: s.incentiveCompatible, minBondBpsForIC: s.minBondBpsForIC,
          undeterrable: s.undeterrable, nonMonotoneAttacks: s.nonMonotoneAttacks
        };
      }),
      disclosures: [
        'Payoffs are deterministic integer-cent computations from the stated model, not measurements of any live system.',
        'The naive arbiter, evidence arbiter, jury and timelock are deliberately simplified to expose each failure mode.',
        'A negative attacker profit means the attack is economically deterred under the stated rules only.'
      ]
    };
    var canonical = canonicalJSON(body);
    return {
      body: body,
      canonical: canonical,
      checksum: {
        algorithm: 'SHA-256',
        kind: 'unkeyed tamper-detection digest (integrity only, not a signature and not authentication)',
        digest: E.sha256Hex(canonical)
      }
    };
  }

  // Replay verification recomputes the canonical form from the body itself;
  // a stored canonical string is checked for consistency, never trusted.
  // Any disagreement among body, canonical and digest fails closed.
  function verifyReportChecksum(report) {
    if (!report || typeof report !== 'object' || !report.body) return { ok: false, reason: 'bad-report' };
    var canon = canonicalJSON(report.body);
    var storedCanonOk = typeof report.canonical !== 'string' || report.canonical === canon;
    var recomputed = E.sha256Hex(canon);
    var claimed = report.checksum && report.checksum.digest;
    var ok = claimed === recomputed && storedCanonOk;
    return {
      ok: ok,
      claimed: claimed || null, recomputed: recomputed,
      reason: !storedCanonOk ? 'canonical-mismatch' : (claimed === recomputed ? 'match' : 'digest-mismatch')
    };
  }

  // CSV export with spreadsheet-formula injection defense: any field that
  // begins with =, +, -, @, a tab or a carriage return is prefixed with a
  // single quote so a hostile label can never execute as a formula.
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function reportCSV(report) {
    var body = report.body || report;
    var head = ['protocol', 'attack', 'bond_bps', 'attacker', 'buyer_out_cents', 'seller_out_cents', 'arbiter_out_cents', 'slashed_cents', 'total_locked_cents', 'attacker_profit_cents', 'attacker_cost_cents', 'roi_bps', 'deterred', 'verdict', 'periods'];
    var lines = [head.join(',')];
    (body.matrix || []).forEach(function (c) {
      lines.push([
        c.protocol, c.attack, c.bondBps, c.attacker || 'none',
        c.receipts.buyer, c.receipts.seller, c.receipts.arbiter, c.receipts.slashed,
        c.totalLocked, c.attackerProfitCents, c.attackerCostCents, c.roiBps,
        c.deterred, c.verdict, c.periodsToResolve
      ].map(csvCell).join(','));
    });
    return lines.join('\n') + '\n';
  }

  function reportMarkdown(report) {
    var body = report.body || report;
    var d = report.checksum && report.checksum.digest ? report.checksum.digest : E.sha256Hex(canonicalJSON(body));
    var lines = [];
    lines.push('# EscrowArena mechanism audit');
    lines.push('');
    lines.push('Bond ratio ' + body.bondBps + ' bps on a ' + body.params.contractCents + ' cent contract. All values integer cents, deterministic model, no live calls.');
    lines.push('');
    lines.push('| Protocol | Max attack profit | Dominance margin | Min bond for IC |');
    lines.push('| --- | --- | --- | --- |');
    (body.protocols || []).forEach(function (s) {
      lines.push('| ' + s.protocol + ' | ' + s.maxAttackProfitCents + ' | ' + s.dominanceMarginCents + ' | ' + (s.minBondBpsForIC === null ? 'none' : s.minBondBpsForIC + ' bps') + ' |');
    });
    lines.push('');
    lines.push('Checksum: ' + d + ' (unkeyed SHA-256 tamper-detection digest, not a signature).');
    return lines.join('\n') + '\n';
  }

  /* ---------- strict URL bookmark codec ---------- */

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64encode(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i += 1) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else { c = 0xfffd; bytes.push(0xef, 0xbf, 0xbd); }
    }
    var out = '';
    for (var j = 0; j < bytes.length; j += 3) {
      var a = bytes[j], b = j + 1 < bytes.length ? bytes[j + 1] : null, c2 = j + 2 < bytes.length ? bytes[j + 2] : null;
      out += B64[a >> 2] + B64[((a & 3) << 4) | (b === null ? 0 : b >> 4)] +
        (b === null ? '=' : B64[((b & 15) << 2) | (c2 === null ? 0 : c2 >> 6)]) +
        (c2 === null ? '=' : B64[c2 & 63]);
    }
    return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64decode(s) {
    var clean = String(s).replace(/-/g, '+').replace(/_/g, '/');
    if (clean.length % 4 === 1) return null;
    var vals = {};
    for (var i = 0; i < B64.length; i += 1) vals[B64[i]] = i;
    var bytes = [];
    for (var j = 0; j < clean.length; j += 4) {
      var n = [0, 0, 0, 0];
      var pad = 0;
      for (var k = 0; k < 4; k += 1) {
        var ch = clean[j + k];
        if (ch === undefined || ch === '=') { pad += 1; }
        else if (vals[ch] === undefined) return null;
        else n[k] = vals[ch];
      }
      var triple = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
      bytes.push((triple >> 16) & 255);
      if (pad < 2) bytes.push((triple >> 8) & 255);
      if (pad < 1) bytes.push(triple & 255);
    }
    var esc = '';
    for (var m = 0; m < bytes.length; m += 1) esc += '%' + ('0' + bytes[m].toString(16)).slice(-2);
    try { return decodeURIComponent(esc); } catch (e) { return null; }
  }

  var BOOKMARK_PREFIX = '#escrow=';
  function encodeBookmark(state) {
    var packed = {
      c: Math.max(1, Math.round(state.contractCents || DEFAULTS.contractCents)),
      r: Math.max(0, Math.round(state.bondBps || 0)),
      p: String(state.protocol || 'single-release'),
      a: String(state.attack || 'honest')
    };
    return BOOKMARK_PREFIX + b64encode(JSON.stringify(packed));
  }
  function decodeBookmark(hash) {
    if (typeof hash !== 'string' || hash.indexOf(BOOKMARK_PREFIX) !== 0) return null;
    var payload = hash.slice(BOOKMARK_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
    var text = b64decode(payload);
    if (!text) return null;
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    var keys = Object.keys(obj).sort();
    if (keys.join(',') !== 'a,c,p,r') return null;
    var state = {
      contractCents: Math.round(Number(obj.c)),
      bondBps: Math.round(Number(obj.r)),
      protocol: String(obj.p),
      attack: String(obj.a)
    };
    // Cap the contract at one billion cents so cent math stays exact and a
    // crafted hash cannot overflow the ledger's integer invariants.
    if (!Number.isSafeInteger(state.contractCents) || state.contractCents < 1 || state.contractCents > 1000000000) return null;
    if (!Number.isSafeInteger(state.bondBps) || state.bondBps < 0 || state.bondBps > DEFAULTS.maxBondBps) return null;
    if (!protocol(state.protocol) || !attack(state.attack)) return null;
    return state;
  }

  /* ---------- self tests (identical in node and the browser) ---------- */

  function selfTests(opts) {
    var P = params(opts);
    var out = [];
    function t(id, name, pass, detail) { out.push({ id: id, name: name, pass: pass === true, detail: detail || '' }); }

    // FIPS 180-4 known-answer vectors.
    t('sha256-kat-empty', 'FIPS 180-4 SHA-256 KAT: empty string',
      E.sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      E.sha256Hex('').slice(0, 16));
    t('sha256-kat-abc', 'FIPS 180-4 SHA-256 KAT: abc',
      E.sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      E.sha256Hex('abc').slice(0, 16));
    t('sha256-kat-fox', 'FIPS 180-4 SHA-256 KAT: quick brown fox',
      E.sha256Hex('The quick brown fox jumps over the lazy dog') === 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
      E.sha256Hex('The quick brown fox jumps over the lazy dog').slice(0, 16));

    // Integer-cent conservation across every protocol, attack and bond grid.
    var conserveFail = [];
    var checked = 0;
    [0, 1, 2500, 5000, 8427, 9999, 10000, 13333, 15000].forEach(function (r) {
      matrix(r, P).forEach(function (c) {
        checked += 1;
        var sum = c.receipts.buyer + c.receipts.seller + c.receipts.arbiter + c.receipts.slashed;
        if (sum !== c.totalLocked) conserveFail.push(c.protocol + '/' + c.attack + '@' + r);
      });
    });
    t('conservation-grid', 'exact integer-cent conservation in every matrix cell',
      conserveFail.length === 0, checked + ' cells checked' + (conserveFail.length ? ', failures: ' + conserveFail.join(';') : ''));

    // Payoff identity: party payoffs equal delivered value minus incurred
    // cost, burned sink and out-of-pot effort costs.
    var payoffFail = [];
    var idChecked = 0;
    [0, 5000, 10000].forEach(function (r) {
      matrix(r, P).forEach(function (c) {
        idChecked += 1;
        var net = c.payoffs.buyer + c.payoffs.seller + c.payoffs.arbiter;
        var expected = c.utility.deliveredValueCents - c.utility.workCostCents - c.receipts.slashed - c.utility.outOfPotCosts.buyer - c.utility.outOfPotCosts.seller;
        if (net !== expected) payoffFail.push(c.protocol + '/' + c.attack + '@' + r + ' (' + net + ' vs ' + expected + ')');
      });
    });
    t('payoff-identity', 'party payoffs equal delivered value minus costs and burns',
      payoffFail.length === 0, idChecked + ' cells checked' + (payoffFail.length ? ', failures: ' + payoffFail.join(';') : ''));

    // Deterrence thresholds are either monotone or honestly reported as
    // windows with both edges.
    var monoFail = [];
    var profChecked = 0;
    PROTOCOLS.forEach(function (p2) {
      ATTACKS.forEach(function (a) {
        if (!a.attacker) return;
        profChecked += 1;
        var pf = deterrenceProfile(p2.id, a.id, P);
        var pts = sweep(p2.id, a.id, P);
        var switches = 0;
        for (var i = 1; i < pts.length; i += 1) if (pts[i].deterred !== pts[i - 1].deterred) switches += 1;
        if (pf.monotoneDeterrence && switches > 1) monoFail.push(p2.id + '/' + a.id + ' flips ' + switches + 'x');
        if (!pf.monotoneDeterrence && pf.deterrenceMaxBps === null) monoFail.push(p2.id + '/' + a.id + ' non-monotone with no bounded deterred region');
      });
    });
    t('threshold-monotonicity', 'deterrence thresholds monotone or reported as windows',
      monoFail.length === 0, profChecked + ' attack profiles checked' + (monoFail.length ? ', failures: ' + monoFail.join(';') : ''));

    // Timeout-bounded liveness.
    var liveFail = [];
    [0, 5000, 15000].forEach(function (r) {
      matrix(r, P).forEach(function (c) {
        if (!c.resolvedWithinBound) liveFail.push(c.protocol + '/' + c.attack + '@' + r + ' took ' + c.periodsToResolve);
      });
    });
    var worst = Math.max.apply(null, matrix(5000, P).map(function (c) { return c.periodsToResolve; }));
    t('liveness-bound', 'every cell resolves inside the ' + P.livenessBoundPeriods + '-period liveness bound',
      liveFail.length === 0, liveFail.length ? liveFail.join(';') : 'worst cell resolves by period ' + worst);

    // CSV formula-injection escaping.
    var inj = csvCell('=1+1') === "'=1+1" && csvCell('@x') === "'@x" && csvCell('-9') === "'-9" && csvCell('+2') === "'+2" &&
      csvCell('\t=x') === "'\t=x" && csvCell('a,b') === '"a,b"' && csvCell('say "hi"') === '"say ""hi"""';
    t('csv-injection', 'CSV export escapes formula-triggering and quoting characters', inj, '');

    // Tamper detection: a mutation in the stored canonical string or in the
    // report body must both fail verification.
    var rep = auditReport(5000, P);
    var okTamper = verifyReportChecksum(rep).ok;
    var mut = rep.canonical.slice(0, 40) + (rep.canonical[40] === 'a' ? 'b' : 'a') + rep.canonical.slice(41);
    var fakeCanon = { body: rep.body, canonical: mut, checksum: { digest: rep.checksum.digest } };
    var fakeBody = { body: JSON.parse(JSON.stringify(rep.body)), canonical: rep.canonical, checksum: { digest: rep.checksum.digest } };
    fakeBody.body.bondBps += 1;
    var detect = !verifyReportChecksum(fakeCanon).ok && !verifyReportChecksum(fakeBody).ok;
    t('tamper-detection', 'a mutation in canonical or body breaks the SHA-256 digest', okTamper && detect, 'recompute ' + (okTamper ? 'matches' : 'FAILED') + ', mutations ' + (detect ? 'caught' : 'MISSED'));

    // Bookmark round-trip and malformed-hash rejection.
    var st = { contractCents: 320000, bondBps: 8427, protocol: 'schelling-jury', attack: 'sybil-jury' };
    var rt = decodeBookmark(encodeBookmark(st));
    var rtOk = rt && rt.contractCents === st.contractCents && rt.bondBps === st.bondBps && rt.protocol === st.protocol && rt.attack === st.attack;
    var bad = [null, '', '#escrow=', '#escrow=!!!', '#escrow=AAAA', '#other=abc'].every(function (h) { return decodeBookmark(h) === null; });
    t('bookmark-roundtrip', 'strict #escrow= bookmarks round-trip and reject malformed hashes', !!(rtOk && bad), '');

    // ROI sign convention: deterred iff profit strictly negative on a real cost.
    var roiFail = [];
    matrix(5000, P).forEach(function (c) {
      if (c.attack === 'honest') return;
      if (c.deterred !== (c.attackerProfitCents < 0)) roiFail.push(c.protocol + '/' + c.attack);
      if (c.attackerCostCents < 1) roiFail.push(c.protocol + '/' + c.attack + ' zero-cost');
    });
    t('roi-sign', 'deterred means strictly negative attacker profit on a positive cost base', roiFail.length === 0, roiFail.join(';'));

    // Matrix shape.
    t('matrix-shape', 'the matrix is 5 protocols by 6 behaviors (30 cells)', matrix(0, P).length === 30 && PROTOCOLS.length === 5 && ATTACKS.length === 6, '');

    var passing = out.filter(function (x) { return x.pass; }).length;
    return { checks: out, passing: passing, total: out.length, allPass: passing === out.length };
  }

  var api = {
    DEFAULTS: DEFAULTS, PROTOCOLS: PROTOCOLS, ATTACKS: ATTACKS,
    params: params, clampBond: clampBond, bondCents: bondCents, jurorStakeCents: jurorStakeCents,
    protocol: protocol, attack: attack,
    simulateCell: simulateCell, matrix: matrix, cellOf: cellOf,
    sweep: sweep, deterrenceProfile: deterrenceProfile, protocolSummary: protocolSummary,
    auditReport: auditReport, verifyReportChecksum: verifyReportChecksum,
    canonicalJSON: canonicalJSON, csvCell: csvCell, reportCSV: reportCSV, reportMarkdown: reportMarkdown,
    encodeBookmark: encodeBookmark, decodeBookmark: decodeBookmark, BOOKMARK_PREFIX: BOOKMARK_PREFIX,
    b64encode: b64encode, b64decode: b64decode,
    selfTests: selfTests
  };
  return api;
}));
