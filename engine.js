/*
 * EscrowArena engine: milestone escrow state machine, three tribunal agents,
 * PayPal request builders, a deterministic sandbox simulator and scoring.
 * Zero dependencies. UMD: require() in Node, window.EscrowArena in a browser.
 * All money is integer cents; all splits are integer basis points (10000 = 100%).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EscrowArena = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- deterministic helpers ---------- */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function round(n, d) {
    var p = Math.pow(10, d === undefined ? 4 : d);
    return Math.round(n * p) / p;
  }

  /* ---------- SHA-256 (pure JS, used to verify artifact manifests) ---------- */

  var K256 = [];
  var H256 = [];
  (function initSha() {
    var primes = [];
    for (var n = 2; primes.length < 64; n += 1) {
      var ok = true;
      for (var d = 0; d < primes.length && primes[d] * primes[d] <= n; d += 1) if (n % primes[d] === 0) { ok = false; break; }
      if (ok) primes.push(n);
    }
    primes.forEach(function (p, i) {
      K256.push(Math.floor((Math.cbrt(p) % 1) * 4294967296) >>> 0);
      if (i < 8) H256.push(Math.floor((Math.sqrt(p) % 1) * 4294967296) >>> 0);
    });
  }());

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i += 1) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(i + 1) - 0xdc00);
        i += 1;
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function sha256Hex(str) {
    var bytes = utf8Bytes(String(str));
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    [hi, lo].forEach(function (w) { bytes.push((w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255); });
    var h = H256.slice();
    var w = new Array(64);
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var off = 0; off < bytes.length; off += 64) {
      for (var i = 0; i < 16; i += 1) {
        w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
      }
      for (var j = 16; j < 64; j += 1) {
        var s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
        var s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (var k = 0; k < 64; k += 1) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K256[k] + w[k]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return h.map(function (x) { return ('00000000' + x.toString(16)).slice(-8); }).join('');
  }

  /* ---------- money and basis points ---------- */

  var CURRENCY = 'USD';
  var PLATFORM_FEE_BPS = 250;

  function toCents(value) {
    var m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
    if (!m) throw new Error('bad amount: ' + value);
    return parseInt(m[1], 10) * 100 + parseInt((m[2] || '0').padEnd(2, '0'), 10);
  }

  function fmtCents(cents) {
    var c = Math.round(cents);
    return Math.floor(c / 100) + '.' + ('0' + (c % 100)).slice(-2);
  }

  // Rounding rule: the seller's capture is rounded DOWN to a whole cent and the residual cent
  // always goes to the buyer, so capture + refund equals the milestone amount exactly.
  function splitByBps(amountCents, captureBps) {
    var bps = Math.max(0, Math.min(10000, Math.round(captureBps)));
    var captureCents = Math.floor(amountCents * bps / 10000);
    return { captureBps: bps, refundBps: 10000 - bps, captureCents: captureCents, refundCents: amountCents - captureCents };
  }

  function platformFee(cents) { return Math.floor(cents * PLATFORM_FEE_BPS / 10000); }

  /* ---------- evidence cases ---------- */

  var FLAGS = [
    { id: 'refund_fraud', label: 'Refund fraud by buyer' },
    { id: 'scope_creep_buyer', label: 'Scope creep by buyer' },
    { id: 'scope_creep_seller', label: 'Scope creep by seller' },
    { id: 'tampered_artifact', label: 'Tampered artifact' },
    { id: 'sla_breach', label: 'Latency SLA breach' },
    { id: 'underdelivery', label: 'Under-delivery against spec' }
  ];
  var FLAG_IDS = FLAGS.map(function (f) { return f.id; });

  function genSamples(seed, p95Ms) {
    var rng = mulberry32(seed);
    var s = [];
    for (var i = 0; i < 94; i += 1) s.push(Math.round(p95Ms * (0.3 + rng() * 0.65)));
    s.push(p95Ms);
    for (var j = 0; j < 5; j += 1) s.push(Math.round(p95Ms * (1.02 + rng() * 0.4)));
    return s.sort(function (a, b) { return a - b; });
  }

  function mf(path, approved, delivered) {
    return { path: path, approvedContent: approved, deliveredContent: delivered === undefined ? approved : delivered };
  }

  var CASE_DEFS = [
    {
      id: 'cold-feet', title: 'Cold Feet After Approval', intent: 'AUTHORIZE', amounts: [150000, 300000, 200000], disputedIndex: 1,
      buyer: 'Harbor Pantry Co', seller: 'Juno Labs',
      brief: 'The seller shipped the checkout service exactly to spec. Two days after signing it off, the buyer asks for the whole milestone back.',
      claim: { by: 'buyer', demandRefundBps: 10000, text: 'We changed direction. Nothing here is usable for us, refund the full milestone.' },
      requirements: [
        { id: 'R1', text: 'Cart API with price rules', weight: 0.4, paths: ['src/cart.js', 'src/pricing.js'] },
        { id: 'R2', text: 'Checkout endpoint with idempotency keys', weight: 0.4, paths: ['src/checkout.js'] },
        { id: 'R3', text: 'Receipt email template', weight: 0.2, paths: ['src/receipt.js'] }
      ],
      diff: { files: [
        { path: 'src/cart.js', added: 240, removed: 12, tests: 14 }, { path: 'src/pricing.js', added: 130, removed: 4, tests: 9 },
        { path: 'src/checkout.js', added: 310, removed: 20, tests: 18 }, { path: 'src/receipt.js', added: 90, removed: 0, tests: 5 }
      ] },
      telemetry: { slaP95Ms: 500, samples: genSamples(11, 410) },
      manifest: [mf('dist/checkout.tar', 'build-1042-checkout'), mf('dist/openapi.json', 'spec-v2-1042')],
      log: [
        { t: '2026-09-03T09:10:00Z', party: 'seller', kind: 'message', text: 'Milestone 2 delivered to staging with test report.' },
        { t: '2026-09-04T14:30:00Z', party: 'buyer', kind: 'approve', text: 'Looks good. Approved for release.' },
        { t: '2026-09-04T16:45:00Z', party: 'buyer', kind: 'deploy', text: 'Deployed to our production storefront.' },
        { t: '2026-09-06T08:05:00Z', party: 'buyer', kind: 'claim', text: 'We changed direction. Refund the full milestone.' }
      ]
    },
    {
      id: 'extra-dashboard', title: 'The Extra Dashboard', intent: 'CAPTURE', amounts: [120000, 240000, 180000], disputedIndex: 1,
      buyer: 'Lantern Retail', seller: 'Orbit Works',
      brief: 'The seller built what the contract lists. The buyer now insists a reporting dashboard was always part of the deal and is withholding the milestone.',
      claim: { by: 'buyer', demandRefundBps: 6000, text: 'The dashboard was obviously included. We are refunding 60 percent until it exists.' },
      requirements: [
        { id: 'R1', text: 'Inventory sync job', weight: 0.5, paths: ['jobs/sync.js'] },
        { id: 'R2', text: 'Low-stock alert endpoint', weight: 0.5, paths: ['api/alerts.js'] },
        { id: 'R4', text: 'Reporting dashboard (added by buyer after signing)', weight: 0.4, paths: ['ui/dashboard.js'], addedByBuyer: true }
      ],
      diff: { files: [
        { path: 'jobs/sync.js', added: 280, removed: 30, tests: 12 }, { path: 'api/alerts.js', added: 200, removed: 5, tests: 10 }
      ] },
      telemetry: { slaP95Ms: 800, samples: genSamples(12, 640) },
      manifest: [mf('dist/sync.tar', 'build-77-sync'), mf('dist/alerts.tar', 'build-77-alerts')],
      log: [
        { t: '2026-09-10T10:00:00Z', party: 'seller', kind: 'message', text: 'Delivered sync job and alert endpoint per contract sections 2 and 3.' },
        { t: '2026-09-11T11:20:00Z', party: 'buyer', kind: 'message', text: 'Where is the dashboard? We discussed it on a call.' },
        { t: '2026-09-11T11:40:00Z', party: 'seller', kind: 'message', text: 'It is not in the signed scope. Happy to quote it as a new milestone.' },
        { t: '2026-09-12T09:00:00Z', party: 'buyer', kind: 'claim', text: 'Refunding 60 percent until the dashboard exists.' }
      ]
    },
    {
      id: 'slow-endpoint', title: 'The Slow Endpoint', intent: 'AUTHORIZE', amounts: [180000, 320000, 150000], disputedIndex: 1,
      buyer: 'Meridian Clinics', seller: 'Pine Street Dev',
      brief: 'Everything in the spec shipped and the artifacts are intact, but the search endpoint misses its latency promise by a wide margin.',
      claim: { by: 'buyer', demandRefundBps: 3000, text: 'Search is far slower than the 500 ms we contracted. We want 30 percent back.' },
      requirements: [
        { id: 'R1', text: 'Patient search endpoint', weight: 0.6, paths: ['api/search.js'] },
        { id: 'R2', text: 'Search index builder', weight: 0.4, paths: ['jobs/index.js'] }
      ],
      diff: { files: [
        { path: 'api/search.js', added: 260, removed: 14, tests: 16 }, { path: 'jobs/index.js', added: 180, removed: 0, tests: 8 }
      ] },
      telemetry: { slaP95Ms: 500, samples: genSamples(13, 840) },
      manifest: [mf('dist/search.tar', 'build-310-search'), mf('dist/index.tar', 'build-310-index')],
      log: [
        { t: '2026-09-14T13:00:00Z', party: 'seller', kind: 'message', text: 'Delivered. Load test attached.' },
        { t: '2026-09-15T09:30:00Z', party: 'buyer', kind: 'message', text: 'p95 is 840 ms in our load test, contract says 500.' },
        { t: '2026-09-15T10:10:00Z', party: 'seller', kind: 'message', text: 'We can tune it next sprint but functionality is complete.' },
        { t: '2026-09-16T08:00:00Z', party: 'buyer', kind: 'claim', text: 'Requesting 30 percent back for the SLA miss.' }
      ]
    },
    {
      id: 'swapped-build', title: 'Swapped After Approval', intent: 'CAPTURE', amounts: [140000, 260000, 200000], disputedIndex: 1,
      buyer: 'Tidewater Freight', seller: 'Cobalt Studio',
      brief: 'The buyer approved a build by its hash. The artifact now sitting in the release bucket hashes differently, and one file was replaced after approval.',
      claim: { by: 'buyer', demandRefundBps: 5000, text: 'The binary is not the one we approved. We want half the milestone back.' },
      requirements: [
        { id: 'R1', text: 'Route planner service', weight: 0.7, paths: ['svc/planner.js'] },
        { id: 'R2', text: 'Driver notification hook', weight: 0.3, paths: ['svc/notify.js'] }
      ],
      diff: { files: [
        { path: 'svc/planner.js', added: 420, removed: 40, tests: 22 }, { path: 'svc/notify.js', added: 110, removed: 3, tests: 6 }
      ] },
      telemetry: { slaP95Ms: 600, samples: genSamples(14, 520) },
      manifest: [mf('dist/planner.tar', 'build-9-planner'), mf('dist/notify.tar', 'build-9-notify', 'build-9-notify-hotfix-after-approval'), mf('dist/schema.sql', 'schema-v4')],
      log: [
        { t: '2026-09-18T10:00:00Z', party: 'seller', kind: 'message', text: 'Delivered build 9, hashes in the manifest.' },
        { t: '2026-09-19T10:00:00Z', party: 'buyer', kind: 'approve', text: 'Approved build 9 by manifest hash.' },
        { t: '2026-09-21T07:30:00Z', party: 'seller', kind: 'message', text: 'Pushed a small hotfix to the notify artifact.' },
        { t: '2026-09-21T12:00:00Z', party: 'buyer', kind: 'claim', text: 'The notify artifact hash no longer matches approval. Half back.' }
      ]
    },
    {
      id: 'gold-plating', title: 'Gold Plating', intent: 'AUTHORIZE', amounts: [160000, 280000, 220000], disputedIndex: 1,
      buyer: 'Fennel and Oak', seller: 'Static Harbor',
      brief: 'The seller skipped one required feature and instead spent the sprint on an unrequested admin console. The buyer wants a refund for what is missing.',
      claim: { by: 'buyer', demandRefundBps: 4000, text: 'Gift cards were required and are missing. We did not ask for an admin console.' },
      requirements: [
        { id: 'R1', text: 'Menu API', weight: 0.3, paths: ['api/menu.js'] },
        { id: 'R2', text: 'Order queue', weight: 0.3, paths: ['api/orders.js'] },
        { id: 'R3', text: 'Gift card redemption', weight: 0.2, paths: ['api/giftcards.js'] },
        { id: 'R4', text: 'Daily summary export', weight: 0.2, paths: ['jobs/export.js'] }
      ],
      diff: { files: [
        { path: 'api/menu.js', added: 150, removed: 5, tests: 7 }, { path: 'api/orders.js', added: 260, removed: 20, tests: 12 },
        { path: 'jobs/export.js', added: 140, removed: 0, tests: 6 }, { path: 'admin/console.js', added: 1500, removed: 0, tests: 0 },
        { path: 'admin/theme.css', added: 400, removed: 0, tests: 0 }
      ] },
      telemetry: { slaP95Ms: 700, samples: genSamples(15, 560) },
      manifest: [mf('dist/api.tar', 'build-55-api'), mf('dist/admin.tar', 'build-55-admin')],
      log: [
        { t: '2026-09-22T09:00:00Z', party: 'seller', kind: 'message', text: 'Delivered. Also included a bonus admin console.' },
        { t: '2026-09-22T15:00:00Z', party: 'buyer', kind: 'message', text: 'We never asked for that. Where are gift cards?' },
        { t: '2026-09-23T08:20:00Z', party: 'buyer', kind: 'claim', text: 'Refund 40 percent for the missing feature.' }
      ]
    },
    {
      id: 'late-add-on', title: 'Half Delivered, Late Add-On', intent: 'CAPTURE', amounts: [130000, 310000, 190000], disputedIndex: 1,
      buyer: 'Sparrow Health', seller: 'Quill Systems',
      brief: 'The seller delivered some of the contracted work. The buyer also bolted on a new requirement mid-sprint and wants the entire milestone refunded.',
      claim: { by: 'buyer', demandRefundBps: 10000, text: 'Not finished, and the new reminders feature is not there either. Full refund.' },
      requirements: [
        { id: 'R1', text: 'Appointment booking API', weight: 0.4, paths: ['api/book.js'] },
        { id: 'R2', text: 'Calendar sync', weight: 0.3, paths: ['api/calendar.js'] },
        { id: 'R3', text: 'Cancellation and waitlist', weight: 0.3, paths: ['api/cancel.js', 'api/waitlist.js'] },
        { id: 'R5', text: 'SMS reminders (added by buyer mid-sprint)', weight: 0.3, paths: ['jobs/sms.js'], addedByBuyer: true }
      ],
      diff: { files: [
        { path: 'api/book.js', added: 330, removed: 18, tests: 15 }, { path: 'api/cancel.js', added: 120, removed: 2, tests: 5 }
      ] },
      telemetry: { slaP95Ms: 450, samples: genSamples(16, 380) },
      manifest: [mf('dist/book.tar', 'build-21-book'), mf('dist/cancel.tar', 'build-21-cancel')],
      log: [
        { t: '2026-09-25T10:00:00Z', party: 'buyer', kind: 'message', text: 'Please also add SMS reminders, our users keep asking.' },
        { t: '2026-09-25T10:30:00Z', party: 'seller', kind: 'message', text: 'That is new scope. We will quote it separately.' },
        { t: '2026-09-28T17:00:00Z', party: 'seller', kind: 'message', text: 'Delivered booking and cancellation. Calendar sync and waitlist are not done.' },
        { t: '2026-09-29T09:00:00Z', party: 'buyer', kind: 'claim', text: 'Full refund please.' }
      ]
    }
  ];

  function buildCase(def) {
    var c = JSON.parse(JSON.stringify(def));
    c.total = c.amounts.reduce(function (a, b) { return a + b; }, 0);
    c.milestones = c.amounts.map(function (a, i) {
      return { id: 'M' + (i + 1), title: ['Foundation', 'Core service', 'Launch and handover'][i] || ('Milestone ' + (i + 1)), amountCents: a };
    });
    c.disputed = c.milestones[c.disputedIndex];
    c.manifest.forEach(function (m) {
      m.approvedSha = sha256Hex(m.approvedContent);
      m.deliveredSha = sha256Hex(m.deliveredContent);
    });
    return c;
  }

  var CASES = CASE_DEFS.map(buildCase);

  function getCase(id) {
    for (var i = 0; i < CASES.length; i += 1) if (CASES[i].id === id) return CASES[i];
    return null;
  }

  /* ---------- tribunal agents ---------- */

  function p95(samples) {
    var s = samples.slice().sort(function (a, b) { return a - b; });
    if (!s.length) return 0;
    return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)];
  }

  function slaScore(ratio) {
    if (ratio <= 1) return 1;
    if (ratio <= 1.25) return 1 - 0.5 * (ratio - 1) / 0.25;
    if (ratio <= 2) return 0.5 * (2 - ratio) / 0.75;
    return 0;
  }

  // Agent 1: Spec Compliance Auditor
  function auditSpec(c) {
    var files = c.diff.files;
    var mappedPaths = {};
    var original = c.requirements.filter(function (r) { return !r.addedByBuyer; });
    var addedByBuyer = c.requirements.filter(function (r) { return r.addedByBuyer; });
    c.requirements.forEach(function (r) { r.paths.forEach(function (p) { mappedPaths[p] = true; }); });
    var weightSum = original.reduce(function (a, r) { return a + r.weight; }, 0);
    var perReq = original.map(function (r) {
      var hit = r.paths.filter(function (p) { return files.some(function (f) { return f.path === p && f.added > 0; }); }).length;
      return { id: r.id, text: r.text, weight: r.weight, coverage: round(hit / r.paths.length, 4) };
    });
    var coverage = perReq.reduce(function (a, r) { return a + r.weight * r.coverage; }, 0) / weightSum;
    var totalAdded = files.reduce(function (a, f) { return a + f.added; }, 0);
    var extraAdded = files.filter(function (f) { return !mappedPaths[f.path]; }).reduce(function (a, f) { return a + f.added; }, 0);
    return {
      perRequirement: perReq,
      coverageBps: Math.round(coverage * 10000),
      totalAdded: totalAdded,
      testsAdded: files.reduce(function (a, f) { return a + f.tests; }, 0),
      unmappedAdded: extraAdded,
      unmappedRatioBps: totalAdded ? Math.round(extraAdded / totalAdded * 10000) : 0,
      buyerAddedRequirements: addedByBuyer.map(function (r) { return r.id; })
    };
  }

  // Agent 2: Telemetry and Hash Verifier
  function verifyTelemetry(c) {
    var measured = p95(c.telemetry.samples);
    var ratio = measured / c.telemetry.slaP95Ms;
    var rows = c.manifest.map(function (m) {
      var recomputedApproved = sha256Hex(m.approvedContent);
      var recomputedDelivered = sha256Hex(m.deliveredContent);
      return { path: m.path, approvedSha: recomputedApproved, deliveredSha: recomputedDelivered, match: recomputedApproved === recomputedDelivered };
    });
    var mismatches = rows.filter(function (r) { return !r.match; });
    return {
      measuredP95Ms: measured,
      slaP95Ms: c.telemetry.slaP95Ms,
      ratio: round(ratio, 4),
      slaMet: measured <= c.telemetry.slaP95Ms,
      slaScoreBps: Math.round(slaScore(ratio) * 10000),
      samples: c.telemetry.samples.length,
      manifest: rows,
      mismatches: mismatches.length,
      tampered: mismatches.length > 0,
      hashScoreBps: mismatches.length ? 0 : 10000
    };
  }

  // Agent 3: Settlement Split Calculator
  function calculateSettlement(c, spec, tel) {
    var quality = 0.6 + 0.2 * (tel.slaScoreBps / 10000) + 0.2 * (tel.hashScoreBps / 10000);
    var captureBps = Math.max(0, Math.min(10000, Math.round(spec.coverageBps * quality)));
    var split = splitByBps(c.disputed.amountCents, captureBps);
    var flags = [];
    var claimIdx = -1;
    c.log.forEach(function (e, i) { if (e.kind === 'claim' && claimIdx === -1) claimIdx = i; });
    var acceptedBefore = c.log.some(function (e, i) { return e.party === 'buyer' && (e.kind === 'approve' || e.kind === 'deploy') && (claimIdx === -1 || i < claimIdx); });
    var demand = c.claim.demandRefundBps;
    if (demand >= 5000 && captureBps >= 9000 && acceptedBefore) flags.push('refund_fraud');
    if (spec.buyerAddedRequirements.length) flags.push('scope_creep_buyer');
    if (spec.unmappedRatioBps >= 2500) flags.push('scope_creep_seller');
    if (tel.tampered) flags.push('tampered_artifact');
    if (!tel.slaMet) flags.push('sla_breach');
    if (spec.coverageBps < 9000) flags.push('underdelivery');
    return {
      qualityBps: Math.round(quality * 10000),
      captureBps: split.captureBps,
      refundBps: split.refundBps,
      captureCents: split.captureCents,
      refundCents: split.refundCents,
      amountCents: c.disputed.amountCents,
      flags: flags,
      buyerAcceptedBeforeClaim: acceptedBefore
    };
  }

  function convene(c) {
    var trace = [];
    var seq = 0;
    function log(agent, tool, input, output) { seq += 1; trace.push({ seq: seq, agent: agent, tool: tool, input: input, output: output }); }
    var spec = auditSpec(c);
    log('Spec Compliance Auditor', 'diff_vs_spec', { files: c.diff.files.length, requirements: c.requirements.length }, {
      coverageBps: spec.coverageBps, unmappedRatioBps: spec.unmappedRatioBps, buyerAdded: spec.buyerAddedRequirements
    });
    var tel = verifyTelemetry(c);
    log('Telemetry & Hash Verifier', 'p95_from_samples', { samples: tel.samples, slaP95Ms: tel.slaP95Ms }, {
      measuredP95Ms: tel.measuredP95Ms, slaMet: tel.slaMet, slaScoreBps: tel.slaScoreBps
    });
    log('Telemetry & Hash Verifier', 'sha256_manifest', { artifacts: tel.manifest.length }, {
      mismatches: tel.mismatches, tampered: tel.tampered, paths: tel.manifest.filter(function (r) { return !r.match; }).map(function (r) { return r.path; })
    });
    var settle = calculateSettlement(c, spec, tel);
    log('Settlement Split Calculator', 'split_bps', { amountCents: settle.amountCents, qualityBps: settle.qualityBps }, {
      captureBps: settle.captureBps, refundBps: settle.refundBps, captureCents: settle.captureCents, refundCents: settle.refundCents
    });
    log('Settlement Split Calculator', 'flag_risks', { demandRefundBps: c.claim.demandRefundBps }, { flags: settle.flags });
    return { spec: spec, telemetry: tel, settlement: settle, trace: trace };
  }

  /* ---------- escrow state machine ---------- */

  var STATES = ['PENDING', 'FUNDED', 'SUBMITTED', 'DISPUTED', 'RELEASED', 'SETTLED_PARTIAL', 'REFUNDED'];
  var TRANSITIONS = {
    PENDING: { fund: 'FUNDED' },
    FUNDED: { submit: 'SUBMITTED' },
    SUBMITTED: { approve: 'RELEASED', dispute: 'DISPUTED' },
    DISPUTED: { rule: null },
    RELEASED: {}, SETTLED_PARTIAL: {}, REFUNDED: {}
  };

  function createEscrow(c) {
    return {
      caseId: c.id,
      intent: c.intent,
      milestones: c.milestones.map(function (m) { return { id: m.id, title: m.title, amountCents: m.amountCents, state: 'PENDING', captureCents: 0, refundCents: 0 }; }),
      history: []
    };
  }

  function findMilestone(escrow, id) {
    for (var i = 0; i < escrow.milestones.length; i += 1) if (escrow.milestones[i].id === id) return escrow.milestones[i];
    return null;
  }

  function applyEvent(escrow, milestoneId, event, payload) {
    var m = findMilestone(escrow, milestoneId);
    if (!m) return { ok: false, reason: 'unknown-milestone' };
    var allowed = TRANSITIONS[m.state];
    if (!allowed || !Object.prototype.hasOwnProperty.call(allowed, event)) return { ok: false, reason: 'invalid-transition', from: m.state, event: event };
    var from = m.state;
    if (event === 'rule') {
      var bps = payload && typeof payload.captureBps === 'number' ? payload.captureBps : null;
      if (bps === null || bps < 0 || bps > 10000) return { ok: false, reason: 'bad-ruling' };
      var s = splitByBps(m.amountCents, bps);
      m.captureCents = s.captureCents;
      m.refundCents = s.refundCents;
      m.state = s.captureBps === 0 ? 'REFUNDED' : (s.captureBps === 10000 ? 'RELEASED' : 'SETTLED_PARTIAL');
    } else if (event === 'approve') {
      m.state = 'RELEASED';
      m.captureCents = m.amountCents;
    } else {
      m.state = allowed[event];
    }
    escrow.history.push({ milestone: milestoneId, event: event, from: from, to: m.state });
    return { ok: true, from: from, to: m.state };
  }

  function escrowStatus(escrow) {
    var done = escrow.milestones.every(function (m) { return ['RELEASED', 'SETTLED_PARTIAL', 'REFUNDED'].indexOf(m.state) !== -1; });
    return done ? 'COMPLETE' : (escrow.milestones.some(function (m) { return m.state === 'DISPUTED'; }) ? 'IN_DISPUTE' : 'OPEN');
  }

  /* ---------- PayPal request builders (Orders v2, Payments v2, Payouts) ---------- */

  var SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

  function money(cents) { return { currency_code: CURRENCY, value: fmtCents(cents) }; }

  function idemKey(label) { return 'escrow-arena-' + hashString(label).toString(16); }

  function jsonHeaders(label) {
    return { 'Content-Type': 'application/json', 'PayPal-Request-Id': idemKey(label) };
  }

  function buildOrderRequest(c, opts) {
    var o = opts || {};
    var intent = o.intent || c.intent;
    return {
      method: 'POST',
      path: '/v2/checkout/orders',
      headers: jsonHeaders('order:' + c.id + ':' + intent),
      body: {
        intent: intent,
        purchase_units: c.milestones.map(function (m) {
          return {
            reference_id: c.id + '-' + m.id,
            custom_id: m.id,
            description: m.title + ' milestone for ' + c.seller,
            amount: money(m.amountCents)
          };
        })
      }
    };
  }

  function buildCaptureRequest(authId, cents, finalCapture, label) {
    return {
      method: 'POST',
      path: '/v2/payments/authorizations/' + authId + '/capture',
      headers: jsonHeaders('capture:' + authId + ':' + cents),
      body: { amount: money(cents), final_capture: !!finalCapture, note_to_payer: label || 'Milestone release', invoice_id: 'INV-' + idemKey(authId + cents).slice(-8) }
    };
  }

  function buildVoidRequest(authId) {
    return { method: 'POST', path: '/v2/payments/authorizations/' + authId + '/void', headers: jsonHeaders('void:' + authId), body: null };
  }

  function buildRefundRequest(captureId, cents, label) {
    return {
      method: 'POST',
      path: '/v2/payments/captures/' + captureId + '/refund',
      headers: jsonHeaders('refund:' + captureId + ':' + cents),
      body: { amount: money(cents), note_to_payer: label || 'Tribunal refund', invoice_id: 'REF-' + idemKey(captureId + cents).slice(-8) }
    };
  }

  function buildPayoutRequest(c, cents, batchLabel) {
    var fee = platformFee(cents);
    return {
      method: 'POST',
      path: '/v1/payments/payouts',
      headers: jsonHeaders('payout:' + c.id + ':' + cents),
      body: {
        sender_batch_header: { sender_batch_id: 'escrow-arena-' + c.id + '-' + (batchLabel || 'M'), email_subject: 'Milestone payout' },
        items: [{
          recipient_type: 'EMAIL',
          receiver: 'seller@example.com',
          amount: money(cents - fee),
          sender_item_id: c.disputed.id + '-seller',
          note: 'Capture ' + fmtCents(cents) + ' less platform fee ' + fmtCents(fee)
        }]
      }
    };
  }

  /* ---------- sandbox simulator ---------- */

  function createSandbox(seed) {
    var rng = mulberry32(seed || 1);
    var db = { orders: {}, auths: {}, captures: {}, refunds: {}, payouts: {} };
    var clock = Date.parse('2026-09-30T12:00:00Z');
    function hex(n) { var s = ''; for (var i = 0; i < n; i += 1) s += Math.floor(rng() * 16).toString(16).toUpperCase(); return s; }
    function newId(prefix) { return 'SIM-' + prefix + '-' + hex(10); }
    function stamp(plusDays) { clock += 60000; return new Date(clock + (plusDays || 0) * 86400000).toISOString().replace('.000Z', 'Z'); }
    function err(status, name, msg) { return { status: status, body: { name: name, message: msg, simulated: true } }; }

    function amountOf(a) { return a && a.value !== undefined ? toCents(a.value) : NaN; }

    return {
      db: db,
      createOrder: function (body) {
        if (!body || (body.intent !== 'AUTHORIZE' && body.intent !== 'CAPTURE')) return err(422, 'INVALID_REQUEST', 'intent must be AUTHORIZE or CAPTURE');
        var units = body.purchase_units;
        if (!Array.isArray(units) || units.length < 1 || units.length > 10) return err(422, 'INVALID_REQUEST', 'purchase_units must hold 1 to 10 units');
        for (var i = 0; i < units.length; i += 1) {
          var c = amountOf(units[i].amount);
          if (!(c > 0)) return err(422, 'INVALID_REQUEST', 'purchase_units[' + i + '].amount must be positive');
        }
        var order = { id: newId('ORD'), intent: body.intent, status: 'CREATED', create_time: stamp(), purchase_units: units.map(function (u) { return { reference_id: u.reference_id, amount: u.amount, custom_id: u.custom_id }; }), simulated: true };
        db.orders[order.id] = order;
        return { status: 201, body: order };
      },
      authorizeOrder: function (orderId) {
        var o = db.orders[orderId];
        if (!o) return err(404, 'RESOURCE_NOT_FOUND', 'order not found');
        if (o.intent !== 'AUTHORIZE') return err(422, 'ORDER_NOT_AUTHORIZE_INTENT', 'order intent is not AUTHORIZE');
        if (o.status !== 'CREATED') return err(422, 'ORDER_ALREADY_AUTHORIZED', 'order already processed');
        o.status = 'COMPLETED';
        o.purchase_units.forEach(function (u) {
          var a = { id: newId('AUTH'), status: 'CREATED', amount: u.amount, orderId: orderId, reference_id: u.reference_id, capturedCents: 0, expiration_time: stamp(29) };
          db.auths[a.id] = a;
          u.payments = { authorizations: [a] };
        });
        return { status: 201, body: o };
      },
      captureOrder: function (orderId) {
        var o = db.orders[orderId];
        if (!o) return err(404, 'RESOURCE_NOT_FOUND', 'order not found');
        if (o.intent !== 'CAPTURE') return err(422, 'ORDER_NOT_CAPTURE_INTENT', 'order intent is not CAPTURE');
        if (o.status !== 'CREATED') return err(422, 'ORDER_ALREADY_CAPTURED', 'order already processed');
        o.status = 'COMPLETED';
        o.purchase_units.forEach(function (u) {
          var cap = { id: newId('CAP'), status: 'COMPLETED', amount: u.amount, orderId: orderId, reference_id: u.reference_id, refundedCents: 0, create_time: stamp() };
          db.captures[cap.id] = cap;
          u.payments = { captures: [cap] };
        });
        return { status: 201, body: o };
      },
      captureAuthorization: function (authId, body) {
        var a = db.auths[authId];
        if (!a) return err(404, 'RESOURCE_NOT_FOUND', 'authorization not found');
        if (a.status === 'VOIDED') return err(422, 'AUTHORIZATION_VOIDED', 'authorization was voided');
        if (a.status === 'CAPTURED') return err(422, 'AUTHORIZATION_ALREADY_CAPTURED', 'authorization is closed');
        var cents = amountOf(body && body.amount);
        if (!(cents > 0)) return err(422, 'INVALID_REQUEST', 'amount must be positive');
        var remaining = toCents(a.amount.value) - a.capturedCents;
        if (cents > remaining) return err(422, 'AMOUNT_EXCEEDS_AUTHORIZED', 'capture of ' + fmtCents(cents) + ' exceeds remaining ' + fmtCents(remaining));
        a.capturedCents += cents;
        var closed = !!(body && body.final_capture) || a.capturedCents === toCents(a.amount.value);
        a.status = closed ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
        a.releasedCents = closed ? toCents(a.amount.value) - a.capturedCents : 0;
        var cap = { id: newId('CAP'), status: 'COMPLETED', amount: money(cents), authId: authId, refundedCents: 0, final_capture: closed, create_time: stamp() };
        db.captures[cap.id] = cap;
        return { status: 201, body: cap };
      },
      voidAuthorization: function (authId) {
        var a = db.auths[authId];
        if (!a) return err(404, 'RESOURCE_NOT_FOUND', 'authorization not found');
        if (a.status !== 'CREATED' && a.status !== 'PARTIALLY_CAPTURED') return err(422, 'AUTHORIZATION_NOT_VOIDABLE', 'authorization is ' + a.status);
        a.status = 'VOIDED';
        a.releasedCents = toCents(a.amount.value) - a.capturedCents;
        return { status: 204, body: null };
      },
      refundCapture: function (capId, body) {
        var cap = db.captures[capId];
        if (!cap) return err(404, 'RESOURCE_NOT_FOUND', 'capture not found');
        var cents = amountOf(body && body.amount);
        if (!(cents > 0)) return err(422, 'INVALID_REQUEST', 'amount must be positive');
        var left = toCents(cap.amount.value) - cap.refundedCents;
        if (cents > left) return err(422, 'REFUND_AMOUNT_EXCEEDS_CAPTURE', 'refund of ' + fmtCents(cents) + ' exceeds refundable ' + fmtCents(left));
        cap.refundedCents += cents;
        cap.status = cap.refundedCents === toCents(cap.amount.value) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        var r = { id: newId('REF'), status: 'COMPLETED', amount: money(cents), captureId: capId, create_time: stamp() };
        db.refunds[r.id] = r;
        return { status: 201, body: r };
      },
      createPayout: function (body) {
        if (!body || !body.sender_batch_header || !Array.isArray(body.items) || !body.items.length) return err(400, 'MALFORMED_REQUEST', 'sender_batch_header and items are required');
        var total = 0;
        for (var i = 0; i < body.items.length; i += 1) {
          var c = amountOf(body.items[i].amount);
          if (!(c > 0)) return err(422, 'INVALID_REQUEST', 'item amount must be positive');
          total += c;
        }
        var p = { batch_header: { payout_batch_id: newId('PAY'), batch_status: 'SUCCESS', sender_batch_header: body.sender_batch_header }, totalCents: total, items: body.items.length, simulated: true };
        db.payouts[p.batch_header.payout_batch_id] = p;
        return { status: 201, body: p };
      }
    };
  }

  // Runs the full lifecycle for a case on the simulator: order, authorize or capture, M1 release,
  // then the tribunal ruling on the disputed milestone, then the seller payout.
  function runRuling(c, ruling, seed) {
    var sb = createSandbox(seed || hashString(c.id));
    var steps = [];
    function step(label, req, res) { steps.push({ label: label, request: req, response: res }); return res; }
    var disputedIdx = c.disputedIndex;
    var orderReq = buildOrderRequest(c);
    var orderRes = step('Create order', orderReq, sb.createOrder(orderReq.body));
    var order = orderRes.body;
    var ledgerOut = { capturedCents: 0, refundedCents: 0, releasedCents: 0, payoutCents: 0, feeCents: 0 };
    var split = splitByBps(c.disputed.amountCents, ruling.captureBps);
    var capturedUnitId = null;

    if (c.intent === 'AUTHORIZE') {
      var authRes = step('Authorize order', { method: 'POST', path: '/v2/checkout/orders/' + order.id + '/authorize', headers: jsonHeaders('authorize:' + order.id), body: null }, sb.authorizeOrder(order.id));
      var units = authRes.body.purchase_units;
      var a1 = units[0].payments.authorizations[0];
      var capReq1 = buildCaptureRequest(a1.id, c.milestones[0].amountCents, true, 'Milestone 1 release');
      var cap1 = step('Release milestone 1', capReq1, sb.captureAuthorization(a1.id, capReq1.body));
      ledgerOut.capturedCents += c.milestones[0].amountCents;
      var ad = units[disputedIdx].payments.authorizations[0];
      if (split.captureCents > 0) {
        var capReq = buildCaptureRequest(ad.id, split.captureCents, true, 'Tribunal ruling capture');
        var capRes = step('Capture ruling amount', capReq, sb.captureAuthorization(ad.id, capReq.body));
        capturedUnitId = capRes.body && capRes.body.id;
        ledgerOut.capturedCents += split.captureCents;
        ledgerOut.releasedCents += split.refundCents;
      } else {
        var voidReq = buildVoidRequest(ad.id);
        step('Void authorization', voidReq, sb.voidAuthorization(ad.id));
        ledgerOut.releasedCents += c.disputed.amountCents;
      }
      void cap1;
    } else {
      var capOrder = step('Capture order', { method: 'POST', path: '/v2/checkout/orders/' + order.id + '/capture', headers: jsonHeaders('capture-order:' + order.id), body: null }, sb.captureOrder(order.id));
      var capUnits = capOrder.body.purchase_units;
      var disputedCap = capUnits[disputedIdx].payments.captures[0];
      ledgerOut.capturedCents += c.milestones[0].amountCents + split.captureCents;
      if (split.refundCents > 0) {
        var refReq = buildRefundRequest(disputedCap.id, split.refundCents, 'Tribunal ruling refund');
        step('Refund ruling amount', refReq, sb.refundCapture(disputedCap.id, refReq.body));
        ledgerOut.refundedCents += split.refundCents;
      }
      capturedUnitId = disputedCap.id;
    }

    if (split.captureCents > 0) {
      var payReq = buildPayoutRequest(c, split.captureCents, 'ruling');
      step('Pay seller', payReq, sb.createPayout(payReq.body));
      ledgerOut.feeCents = platformFee(split.captureCents);
      ledgerOut.payoutCents = split.captureCents - ledgerOut.feeCents;
    }
    return { sandbox: sb, steps: steps, split: split, totals: ledgerOut, capturedUnitId: capturedUnitId };
  }

  // Live mode. Only the PayPal sandbox host is ever allowed; the token is supplied by the user at runtime.
  function executeRequest(req, opts) {
    var o = opts || {};
    var base = o.base || SANDBOX_BASE;
    if (base !== SANDBOX_BASE) return Promise.resolve({ ok: false, reason: 'sandbox-only' });
    if (!o.token) return Promise.resolve({ ok: false, reason: 'no-token' });
    var impl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!impl) return Promise.resolve({ ok: false, reason: 'no-fetch' });
    var headers = Object.assign({}, req.headers, { Authorization: 'Bearer ' + o.token });
    return impl(base + req.path, { method: req.method, headers: headers, body: req.body ? JSON.stringify(req.body) : undefined })
      .then(function (res) {
        return res.text().then(function (txt) {
          var parsed = null;
          try { parsed = txt ? JSON.parse(txt) : null; } catch (e) { parsed = { raw: txt }; }
          return { ok: res.ok, status: res.status, body: parsed };
        });
      })
      .catch(function (e) { return { ok: false, reason: 'network: ' + (e && e.message ? e.message : 'failed') }; });
  }

  function redactHeaders(headers) {
    var out = {};
    Object.keys(headers).forEach(function (k) { out[k] = k.toLowerCase() === 'authorization' ? 'Bearer <token>' : headers[k]; });
    return out;
  }

  /* ---------- scoring ---------- */

  function rankFor(total) {
    if (total >= 1000 * 6 * 0.85) return 'Chief Arbiter';
    if (total >= 1000 * 6 * 0.65) return 'Senior Arbiter';
    if (total >= 1000 * 6 * 0.4) return 'Arbiter';
    if (total > 0) return 'Clerk';
    return 'Unseated';
  }

  function scoreRuling(c, ruling, ctx) {
    var truth = convene(c).settlement;
    var errorBps = Math.abs(ruling.captureBps - truth.captureBps);
    var accuracy = Math.max(0, Math.round(1000 - errorBps / 2));
    var picked = ruling.flags || [];
    var hits = picked.filter(function (f) { return truth.flags.indexOf(f) !== -1; });
    var falsePos = picked.filter(function (f) { return truth.flags.indexOf(f) === -1; });
    var missed = truth.flags.filter(function (f) { return picked.indexOf(f) === -1; });
    var flagPoints = hits.length * 150 - falsePos.length * 100;
    var unaided = !(ctx && ctx.consulted) && errorBps <= 300 ? 200 : 0;
    return {
      score: Math.max(0, accuracy + flagPoints + unaided),
      accuracy: accuracy,
      errorBps: errorBps,
      fairCaptureBps: truth.captureBps,
      hits: hits, falsePositives: falsePos, missed: missed,
      flagPoints: flagPoints, unaidedBonus: unaided
    };
  }

  /* ---------- audit ledger ---------- */

  var LEDGER_COLUMNS = [
    { field: 'seq', headerName: '#', width: 70 },
    { field: 'time', headerName: 'Time', width: 190 },
    { field: 'type', headerName: 'Type', width: 130 },
    { field: 'actor', headerName: 'Actor', width: 170 },
    { field: 'milestone', headerName: 'Milestone', width: 110 },
    { field: 'amount', headerName: 'Amount (USD)', width: 130 },
    { field: 'status', headerName: 'Status', width: 140 },
    { field: 'ref', headerName: 'Reference', flex: 1, minWidth: 200 }
  ];

  function buildLedger(c, sessionRun, convened, ruling) {
    var rows = [];
    function push(time, type, actor, milestone, amountCents, status, ref) {
      rows.push({ seq: rows.length + 1, time: time, type: type, actor: actor, milestone: milestone, amount: amountCents === null ? '' : fmtCents(amountCents), status: status, ref: ref });
    }
    c.milestones.forEach(function (m, i) {
      push('2026-09-01T09:00:00Z', 'MILESTONE', 'Contract', m.id, m.amountCents, i === c.disputedIndex ? 'DISPUTED' : (i < c.disputedIndex ? 'RELEASED' : 'PENDING'), m.title);
    });
    c.log.forEach(function (e) {
      push(e.t, e.kind === 'claim' ? 'DISPUTE' : 'EVIDENCE', e.party, c.disputed.id, null, e.kind.toUpperCase(), e.text);
    });
    if (convened) {
      convened.trace.forEach(function (t) { push('tribunal', 'AGENT', t.agent, c.disputed.id, null, 'OK', t.tool); });
    }
    if (ruling) push('ruling', 'RULING', 'Arbiter', c.disputed.id, null, 'FILED', 'capture ' + ruling.captureBps + ' bps, refund ' + (10000 - ruling.captureBps) + ' bps');
    if (sessionRun) {
      sessionRun.steps.forEach(function (s) {
        var b = s.response.body || {};
        var amt = null;
        if (s.request.body && s.request.body.amount) amt = toCents(s.request.body.amount.value);
        if (s.request.body && s.request.body.items) amt = toCents(s.request.body.items[0].amount.value);
        push(b.create_time || 'sandbox', 'PAYPAL', s.label, c.disputed.id, amt, s.response.status + (b.status ? ' ' + b.status : ''), b.id || (b.batch_header && b.batch_header.payout_batch_id) || s.request.path);
      });
    }
    return rows;
  }

  return {
    FLAGS: FLAGS, FLAG_IDS: FLAG_IDS, CASES: CASES, STATES: STATES, TRANSITIONS: TRANSITIONS, LEDGER_COLUMNS: LEDGER_COLUMNS,
    CURRENCY: CURRENCY, PLATFORM_FEE_BPS: PLATFORM_FEE_BPS, SANDBOX_BASE: SANDBOX_BASE,
    mulberry32: mulberry32, hashString: hashString, round: round, sha256Hex: sha256Hex,
    toCents: toCents, fmtCents: fmtCents, splitByBps: splitByBps, platformFee: platformFee,
    getCase: getCase, p95: p95, slaScore: slaScore,
    auditSpec: auditSpec, verifyTelemetry: verifyTelemetry, calculateSettlement: calculateSettlement, convene: convene,
    createEscrow: createEscrow, applyEvent: applyEvent, escrowStatus: escrowStatus, findMilestone: findMilestone,
    buildOrderRequest: buildOrderRequest, buildCaptureRequest: buildCaptureRequest, buildVoidRequest: buildVoidRequest,
    buildRefundRequest: buildRefundRequest, buildPayoutRequest: buildPayoutRequest,
    createSandbox: createSandbox, runRuling: runRuling, executeRequest: executeRequest, redactHeaders: redactHeaders,
    scoreRuling: scoreRuling, rankFor: rankFor, buildLedger: buildLedger
  };
}));
