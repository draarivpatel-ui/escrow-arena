/*
 * EscrowArena adversarial mechanism lab UI.
 * Renders the payoff matrix, bond-threshold chart, ledger detail, self-test
 * chips and the checksummed audit exports computed by mechanism-lab.js.
 * Zero dependencies. createLab takes any document-like object so the tests
 * can drive it without a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EscrowArenaMechUI = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var ATTACK_COLORS = {
    'buyer-grief': '#b4283a',
    'seller-ghost': '#3b4cca',
    'bribed-arbiter': '#7a5300',
    'sybil-jury': '#5d6c85',
    'timeout-stall': '#0b7d57'
  };

  // Attacks with no lever on a protocol are drawn dashed, honestly showing
  // that the flat line means "this attack does not apply here".
  var LEVERLESS = {
    'single-release': ['sybil-jury', 'timeout-stall'],
    'milestone-partial': ['sybil-jury', 'timeout-stall'],
    'mad-collateral': ['sybil-jury', 'timeout-stall'],
    'schelling-jury': ['timeout-stall'],
    'timelock-evidence': ['sybil-jury']
  };

  function createLab(E, M, doc, opts) {
    var options = opts || {};
    var els = {};
    function $(id) {
      if (!els[id]) els[id] = doc.getElementById(id);
      return els[id];
    }
    function setHTML(id, html) { var e = $(id); if (e) e.innerHTML = html; }
    function setText(id, text) { var e = $(id); if (e) e.textContent = text; }
    function status(text) { setText('lab-status', text); }

    function getHash() {
      if (typeof options.getHash === 'function') return options.getHash();
      if (typeof window !== 'undefined' && window.location) return window.location.hash || '';
      return '';
    }
    function setHash(h) {
      if (typeof options.setHash === 'function') { options.setHash(h); return; }
      if (typeof window !== 'undefined' && window.location) window.location.hash = h;
    }
    function clipboard() {
      if (options.clipboard) return options.clipboard;
      if (typeof navigator !== 'undefined' && navigator.clipboard) return navigator.clipboard;
      return null;
    }

    function usd(cents) { return (cents < 0 ? '-$' : '$') + E.fmtCents(Math.abs(cents)); }
    function signed(cents) { return (cents >= 0 ? '+' : '') + usd(cents); }
    function pct(bps) { return (bps / 100).toFixed(1) + '%'; }

    var ctl = {
      engine: E, mech: M,
      state: { contractCents: M.DEFAULTS.contractCents, bondBps: 5000, protocol: 'schelling-jury', attack: 'bribed-arbiter' },
      lastReport: null,
      lastTests: null
    };

    function leverless(protocolId, attackId) {
      return (LEVERLESS[protocolId] || []).indexOf(attackId) !== -1;
    }

    /* ---------- state ---------- */

    ctl.setContract = function (cents) {
      var n = Math.round(Number(cents));
      if (!Number.isSafeInteger(n) || n < 1) return false;
      ctl.state.contractCents = Math.min(n, 1000000000);
      ctl.lastReport = null;
      ctl.render();
      return true;
    };

    ctl.setBond = function (bps) {
      var n = Math.round(Number(bps));
      if (!Number.isFinite(n)) return false;
      ctl.state.bondBps = Math.max(0, Math.min(M.DEFAULTS.maxBondBps, n));
      ctl.lastReport = null;
      ctl.render();
      return true;
    };

    ctl.selectCell = function (protocolId, attackId) {
      if (!M.protocol(protocolId) || !M.attack(attackId)) return false;
      ctl.state.protocol = protocolId;
      ctl.state.attack = attackId;
      ctl.render();
      return true;
    };

    ctl.applyBookmark = function (hash) {
      var st = M.decodeBookmark(hash);
      if (!st) return false;
      ctl.state = { contractCents: st.contractCents, bondBps: Math.min(st.bondBps, M.DEFAULTS.maxBondBps), protocol: st.protocol, attack: st.attack };
      ctl.lastReport = null;
      ctl.render();
      return true;
    };

    /* ---------- rendering ---------- */

    ctl.renderControls = function () {
      var sel = $('lab-contract');
      if (sel) {
        var known = {};
        var optsHtml = E.CASES.map(function (c) {
          known[c.disputed.amountCents] = true;
          return '<option value="' + c.disputed.amountCents + '">' + esc(c.title) + ' (' + usd(c.disputed.amountCents) + ')</option>';
        });
        if (!known[ctl.state.contractCents]) {
          optsHtml.push('<option value="' + ctl.state.contractCents + '">Bookmarked contract (' + usd(ctl.state.contractCents) + ')</option>');
        }
        sel.innerHTML = optsHtml.join('');
        sel.value = String(ctl.state.contractCents);
      }
      var slider = $('lab-bond');
      if (slider) slider.value = String(ctl.state.bondBps);
      setText('lab-bond-readout', pct(ctl.state.bondBps) + ' of contract');
    };

    ctl.renderMatrix = function () {
      var st = ctl.state;
      var cells = M.matrix(st.bondBps, { contractCents: st.contractCents });
      var head = '<caption class="hint-line">Attacker net profit over honest play at bond ' + esc(pct(st.bondBps)) + '; select a cell for its ledger</caption><thead><tr><th scope="col">Protocol</th>' + M.ATTACKS.map(function (a) {
        return '<th scope="col">' + esc(a.name) + '</th>';
      }).join('') + '</tr></thead>';
      var body = M.PROTOCOLS.map(function (p) {
        var tds = M.ATTACKS.map(function (a) {
          var c = M.cellOf(cells, p.id, a.id);
          var sel = st.protocol === p.id && st.attack === a.id;
          var cls = 'mcell ' + (a.attacker === null ? 'base' : (c.deterred ? 'det' : 'pos')) + (sel ? ' sel' : '');
          var label = a.attacker === null ? 'baseline' : signed(c.attackerProfitCents);
          return '<td><button type="button" class="' + cls + '" data-act="cell" data-arg="' + p.id + '|' + a.id + '" aria-pressed="' + (sel ? 'true' : 'false') + '">' + esc(label) + '</button></td>';
        }).join('');
        return '<tr><th scope="row">' + esc(p.name) + '</th>' + tds + '</tr>';
      }).join('');
      setHTML('lab-matrix', head + '<tbody>' + body + '</tbody>');
    };

    ctl.renderDetail = function () {
      var st = ctl.state;
      var c = M.simulateCell(st.protocol, st.attack, st.bondBps, { contractCents: st.contractCents });
      var p = M.protocol(st.protocol);
      var a = M.attack(st.attack);
      var sum = c.receipts.buyer + c.receipts.seller + c.receipts.arbiter + c.receipts.slashed;
      var rows = ['buyer', 'seller', 'arbiter'].map(function (who) {
        return '<tr><th scope="row">' + who + '</th><td class="num">' + esc(E.fmtCents(c.contributions[who])) + '</td><td class="num">' + esc(E.fmtCents(c.receipts[who])) + '</td><td class="num">' + esc(signed(c.payoffs[who])) + '</td></tr>';
      }).join('') + '<tr><th scope="row">slashed sink</th><td class="num">0.00</td><td class="num">' + esc(E.fmtCents(c.receipts.slashed)) + '</td><td class="num">n/a</td></tr>';
      var kv = [
        ['verdict', c.verdict],
        ['periods to resolve', String(c.periodsToResolve) + ' (bound ' + c.livenessBoundPeriods + ')'],
        ['attacker', c.attacker || 'none'],
        ['attacker profit', signed(c.attackerProfitCents)],
        ['attack cost base', usd(c.attackerCostCents)],
        ['griefing ROI', (c.roiBps / 100).toFixed(1) + '%'],
        ['deterred', c.deterred ? 'yes (profit under zero)' : 'no']
      ].map(function (pair) {
        return '<div class="kv"><span>' + esc(pair[0]) + '</span><b>' + esc(pair[1]) + '</b></div>';
      }).join('');
      var notes = c.notes.length ? '<ul class="lab-notes">' + c.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '';
      setHTML('lab-detail',
        '<h3>' + esc(p.name) + ' vs ' + esc(a.name) + '</h3>' +
        '<p class="hint-line">' + esc(a.blurb) + '</p>' +
        '<div class="table-wrap"><table class="lab-ledger"><caption class="hint-line">Escrow pot ledger at bond ' + esc(pct(st.bondBps)) + '</caption>' +
        '<thead><tr><th scope="col">Party</th><th scope="col" class="num">Paid in</th><th scope="col" class="num">Paid out</th><th scope="col" class="num">Payoff</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' +
        '<p class="conserve">Conservation: ' + esc(E.fmtCents(sum)) + ' out of ' + esc(E.fmtCents(c.totalLocked)) + ' locked, ' + (sum === c.totalLocked ? 'exact' : 'BROKEN') + '.</p>' +
        '<div class="kv-list">' + kv + '</div>' + notes);
    };

    ctl.renderScore = function () {
      var st = ctl.state;
      var rows = M.PROTOCOLS.map(function (p) {
        var s = M.protocolSummary(p.id, st.bondBps, { contractCents: st.contractCents });
        var ic = s.minBondBpsForIC === null ? 'none' : pct(s.minBondBpsForIC);
        var weak = s.undeterrable.length ? s.undeterrable.join(', ') : (s.nonMonotoneAttacks.length ? 'window: ' + s.nonMonotoneAttacks.map(function (w) { return w.attack; }).join(', ') : 'none');
        return '<tr><th scope="row">' + esc(p.name) + '</th>' +
          '<td class="num">' + esc(signed(s.maxAttackProfitCents)) + '</td>' +
          '<td class="num">' + esc(signed(s.dominanceMarginCents)) + '</td>' +
          '<td class="num">' + esc(ic) + '</td>' +
          '<td>' + esc(weak) + '</td></tr>';
      }).join('');
      setHTML('lab-score',
        '<caption class="hint-line">Headline game-theory metrics at bond ' + esc(pct(st.bondBps)) + '</caption>' +
        '<thead><tr><th scope="col">Protocol</th><th scope="col" class="num">Max attack profit</th><th scope="col" class="num">Honest dominance margin</th><th scope="col" class="num">Min bond for IC</th><th scope="col">Undeterred lever</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>');
    };

    /* ---------- SVG threshold chart ---------- */

    ctl.renderChart = function () {
      var st = ctl.state;
      var p = M.protocol(st.protocol);
      var opts2 = { contractCents: st.contractCents };
      var attacks = M.ATTACKS.filter(function (a) { return a.attacker !== null; });
      var curves = attacks.map(function (a) {
        return { attack: a, pts: M.sweep(st.protocol, a.id, opts2), profile: M.deterrenceProfile(st.protocol, a.id, opts2) };
      });
      var ymin = 0, ymax = 0;
      curves.forEach(function (cv) {
        cv.pts.forEach(function (pt) {
          if (pt.profitCents < ymin) ymin = pt.profitCents;
          if (pt.profitCents > ymax) ymax = pt.profitCents;
        });
      });
      var padY = Math.max(1000, Math.round((ymax - ymin) * 0.06));
      ymin -= padY; ymax += padY;
      var W = 760, H = 320, ml = 68, mr = 14, mt = 18, mb = 40;
      var pw = W - ml - mr, ph = H - mt - mb;
      function X(r) { return ml + (r / M.DEFAULTS.maxBondBps) * pw; }
      function Y(v) { return mt + ((ymax - v) / (ymax - ymin)) * ph; }
      var maxB = M.DEFAULTS.maxBondBps;

      var parts = [];
      parts.push('<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Attacker net profit against collateral bond ratio for ' + esc(p.name) + ', zero line marks the deterrence boundary">');
      parts.push('<title>Attacker net profit vs bond ratio, ' + esc(p.name) + '</title>');

      // Deterrence zone shading under the zero line.
      parts.push('<rect class="chart-detzone" x="' + ml + '" y="' + Y(0) + '" width="' + pw + '" height="' + (Y(ymin) - Y(0)) + '"/>');

      // Y ticks.
      for (var i = 0; i <= 4; i += 1) {
        var v = ymin + (ymax - ymin) * i / 4;
        parts.push('<line class="chart-grid" x1="' + ml + '" y1="' + Y(v) + '" x2="' + (W - mr) + '" y2="' + Y(v) + '"/>');
        parts.push('<text class="chart-tick" x="' + (ml - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + esc(usd(Math.round(v))) + '</text>');
      }
      // X ticks at 0, 50, 100, 150 percent.
      [0, 5000, 10000, 15000].forEach(function (r) {
        parts.push('<text class="chart-tick" x="' + X(r) + '" y="' + (H - mb + 18) + '" text-anchor="middle">' + esc(pct(r)) + '</text>');
      });
      parts.push('<text class="chart-axis" x="' + (ml + pw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">collateral bond ratio</text>');

      // Zero line.
      parts.push('<line class="chart-zero" x1="' + ml + '" y1="' + Y(0) + '" x2="' + (W - mr) + '" y2="' + Y(0) + '"/>');
      parts.push('<text class="chart-tick zero-label" x="' + (W - mr) + '" y="' + (Y(0) - 5) + '" text-anchor="end">deterrence boundary</text>');

      // Current bond cursor.
      parts.push('<line class="chart-cursor" x1="' + X(st.bondBps) + '" y1="' + mt + '" x2="' + X(st.bondBps) + '" y2="' + (H - mb) + '"/>');

      // Curves.
      curves.forEach(function (cv) {
        var color = ATTACK_COLORS[cv.attack.id] || '#26364f';
        var dashed = leverless(st.protocol, cv.attack.id);
        var d = cv.pts.map(function (pt) { return X(pt.bondBps).toFixed(1) + ',' + Y(pt.profitCents).toFixed(1); }).join(' ');
        parts.push('<polyline class="chart-line' + (dashed ? ' leverless' : '') + '" points="' + d + '" stroke="' + color + '"' + (dashed ? ' stroke-dasharray="5 4"' : '') + '/>');
        // Threshold markers at each crossing.
        cv.profile.crossings.forEach(function (cr) {
          var pt = null;
          for (var k = 0; k < cv.pts.length; k += 1) if (cv.pts[k].bondBps === cr.at) pt = cv.pts[k];
          if (!pt) return;
          parts.push('<circle class="chart-cross" cx="' + X(cr.at).toFixed(1) + '" cy="' + Y(pt.profitCents).toFixed(1) + '" r="4" stroke="' + color + '"/>');
        });
        // Exact threshold label for the deterrence min edge.
        if (cv.profile.deterrenceMinBps !== null && !cv.profile.detersAtZero) {
          var pt2 = null;
          for (var k2 = 0; k2 < cv.pts.length; k2 += 1) if (cv.pts[k2].bondBps === cv.profile.deterrenceMinBps) pt2 = cv.pts[k2];
          if (pt2) {
            var lx = Math.min(X(cv.profile.deterrenceMinBps) + 8, W - mr - 96);
            var ly = Math.max(Y(pt2.profitCents) - 8, mt + 10);
            parts.push('<text class="chart-threshold" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" fill="' + color + '">deters at ' + esc(pct(cv.profile.deterrenceMinBps)) + '</text>');
          }
        }
        // Window label for non-monotone deterrence.
        if (!cv.profile.monotoneDeterrence && cv.profile.deterrenceMaxBps !== null) {
          var lx2 = Math.min(X(cv.profile.deterrenceMaxBps) + 8, W - mr - 150);
          parts.push('<text class="chart-threshold" x="' + lx2.toFixed(1) + '" y="' + (mt + 12) + '" fill="' + color + '">' + esc(cv.attack.id) + ' re-emerges at ' + esc(pct(cv.profile.deterrenceMaxBps + 50)) + '</text>');
        }
      });
      parts.push('</svg>');

      var legend = '<div class="chart-legend">' + curves.map(function (cv) {
        var color = ATTACK_COLORS[cv.attack.id] || '#26364f';
        var tag = '';
        if (cv.profile.neverDeters) tag = ', never deterred';
        else if (!cv.profile.monotoneDeterrence) tag = ', deterred window';
        else if (cv.profile.deterrenceMinBps !== null) tag = cv.profile.detersAtZero ? ', always deterred' : ', deters at ' + pct(cv.profile.deterrenceMinBps);
        return '<span class="chart-key"><span class="chart-dot" style="background:' + color + '"></span>' + esc(cv.attack.name + tag) + '</span>';
      }).join('') + '</div>';
      setHTML('lab-chart', parts.join('') + legend);
    };

    /* ---------- self tests, export, bookmark ---------- */

    ctl.runTests = function () {
      var res = M.selfTests({ contractCents: ctl.state.contractCents });
      ctl.lastTests = res;
      setHTML('lab-test-chips', res.checks.map(function (chk) {
        return '<span class="verify-chip ' + (chk.pass ? 'ok' : 'bad') + '">' + esc(chk.id) + ': ' + (chk.pass ? 'OK' : 'FAIL') + '</span>';
      }).join(''));
      setText('lab-test-status', res.allPass
        ? 'All ' + res.total + ' lab self-tests pass, computed locally with no network request.'
        : res.passing + ' of ' + res.total + ' lab self-tests pass.');
      return res;
    };

    function report() {
      if (!ctl.lastReport) {
        ctl.lastReport = M.auditReport(ctl.state.bondBps, { contractCents: ctl.state.contractCents });
      }
      return ctl.lastReport;
    }
    ctl.currentReport = report;

    function download(name, mime, text) {
      if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof doc.createElement !== 'function') {
        status('Download is unavailable in this environment; the copy button still works.');
        return false;
      }
      var blob = new Blob([text], { type: mime });
      var a = doc.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      if (typeof setTimeout === 'function') setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      return true;
    }

    ctl.exportJSON = function () {
      var r = report();
      setText('lab-digest', 'SHA-256 ' + r.checksum.digest);
      var cb = clipboard();
      if (cb && cb.writeText) {
        cb.writeText(JSON.stringify(r, null, 2)).then(function () {
          status('Audit JSON copied to the clipboard; digest is an unkeyed tamper-detection checksum, not a signature.');
        }, function () {
          status('Clipboard refused; use the download buttons instead.');
        });
      } else {
        status('Clipboard unavailable; use the download buttons instead.');
      }
      return r;
    };

    ctl.downloadJSON = function () {
      var r = report();
      setText('lab-digest', 'SHA-256 ' + r.checksum.digest);
      if (download('escrow-arena-mechanism-audit.json', 'application/json', JSON.stringify(r, null, 2))) {
        status('Audit JSON downloaded; digest is an unkeyed tamper-detection checksum, not a signature.');
      }
    };

    ctl.downloadCSV = function () {
      var r = report();
      setText('lab-digest', 'SHA-256 ' + r.checksum.digest);
      if (download('escrow-arena-mechanism-audit.csv', 'text/csv', M.reportCSV(r))) {
        status('Audit CSV downloaded with formula-injection escaping; digest shown above.');
      }
    };

    ctl.downloadMarkdown = function () {
      var r = report();
      setText('lab-digest', 'SHA-256 ' + r.checksum.digest);
      if (download('escrow-arena-mechanism-audit.md', 'text/markdown', M.reportMarkdown(r))) {
        status('Audit Markdown downloaded; digest is an unkeyed tamper-detection checksum, not a signature.');
      }
    };

    ctl.writeBookmark = function () {
      var h = M.encodeBookmark(ctl.state);
      setHash(h);
      status('Bookmark written to the address bar: ' + h);
      return h;
    };

    ctl.verifyExport = function () {
      var r = report();
      var res = M.verifyReportChecksum(r);
      status(res.ok
        ? 'Replay check passed: recomputing the canonical body reproduces digest ' + res.recomputed.slice(0, 16) + '...'
        : 'Replay check FAILED (' + res.reason + '): the export was altered after it was written.');
      return res;
    };

    ctl.act = function (name, arg) {
      if (name === 'cell') {
        var parts = String(arg || '').split('|');
        return ctl.selectCell(parts[0], parts[1]);
      }
      return null;
    };

    ctl.render = function () {
      ctl.renderControls();
      ctl.renderMatrix();
      ctl.renderDetail();
      ctl.renderScore();
      ctl.renderChart();
    };

    ctl.bind = function () {
      function on(id, type, fn) { var e = $(id); if (e && e.addEventListener) e.addEventListener(type, fn); }
      on('lab-contract', 'change', function (e) { ctl.setContract(e.target.value); });
      on('lab-bond', 'input', function (e) { ctl.setBond(e.target.value); });
      on('lab-matrix', 'click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
        if (!t) return;
        var d = t.dataset || {};
        ctl.act(d.act, d.arg);
      });
      on('btn-lab-tests', 'click', function () { ctl.runTests(); });
      on('btn-lab-copy', 'click', function () { ctl.exportJSON(); });
      on('btn-lab-json', 'click', function () { ctl.downloadJSON(); });
      on('btn-lab-csv', 'click', function () { ctl.downloadCSV(); });
      on('btn-lab-md', 'click', function () { ctl.downloadMarkdown(); });
      on('btn-lab-bookmark', 'click', function () { ctl.writeBookmark(); });
      on('btn-lab-verify', 'click', function () { ctl.verifyExport(); });
    };

    ctl.init = function () {
      ctl.bind();
      if (!ctl.applyBookmark(getHash())) ctl.render();
      ctl.runTests();
      return ctl;
    };

    return ctl;
  }

  var api = { createLab: createLab, esc: esc, ATTACK_COLORS: ATTACK_COLORS };

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.EscrowArena && window.EscrowArenaMech) {
    api.lab = createLab(window.EscrowArena, window.EscrowArenaMech, document).init();
  }
  return api;
}));
