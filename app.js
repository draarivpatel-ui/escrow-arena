/*
 * EscrowArena UI controller. Game rules and money math live in engine.js; this file renders
 * state, binds events and mounts AG Grid when the library is present. createController takes
 * any document-like object so the tests can drive it without a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EscrowArenaApp = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function usd(cents, engine) { return '$' + engine.fmtCents(cents); }

  function drawLatency(ctx, samples, sla, w, h) {
    ctx.clearRect(0, 0, w, h);
    var max = Math.max(sla * 1.5, Math.max.apply(null, samples) * 1.05);
    var pad = 10;
    var bw = (w - pad * 2) / samples.length;
    samples.forEach(function (v, i) {
      var bh = (v / max) * (h - 30);
      ctx.beginPath();
      ctx.moveTo(pad + i * bw, h - 18);
      ctx.lineTo(pad + i * bw, h - 18 - bh);
      ctx.lineWidth = Math.max(1, bw - 1);
      ctx.strokeStyle = v > sla ? '#b4283a' : '#3b4cca';
      ctx.stroke();
    });
    var y = h - 18 - (sla / max) * (h - 30);
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0b7d57';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#26364f';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SLA ' + sla + ' ms', pad + 4, y - 5);
    ctx.fillText('100 sampled requests, sorted by latency', pad + 4, h - 4);
  }

  function createController(engine, doc, opts) {
    var options = opts || {};
    var els = {};
    function $(id) {
      if (!els[id]) els[id] = doc.getElementById(id);
      return els[id];
    }
    function setHTML(id, html) { var e = $(id); if (e) e.innerHTML = html; }
    function setText(id, text) { var e = $(id); if (e) e.textContent = text; }

    var ctl = {
      engine: engine,
      caseObj: null,
      escrow: null,
      convened: null,
      consulted: false,
      ruling: { captureBps: 5000, flags: [] },
      filed: null,
      run: null,
      stepIdx: 0,
      results: {},
      token: '',
      liveMode: 'simulated sandbox',
      ledgerMode: 'table',
      grid: null
    };

    ctl.loadCase = function (id) {
      var c = engine.getCase(id);
      if (!c) return false;
      ctl.caseObj = c;
      ctl.convened = null;
      ctl.consulted = false;
      ctl.filed = null;
      ctl.run = null;
      ctl.stepIdx = 0;
      ctl.ruling = { captureBps: 5000, flags: [] };
      ctl.escrow = engine.createEscrow(c);
      c.milestones.forEach(function (m, i) {
        engine.applyEvent(ctl.escrow, m.id, 'fund');
        if (i < c.disputedIndex) { engine.applyEvent(ctl.escrow, m.id, 'submit'); engine.applyEvent(ctl.escrow, m.id, 'approve'); }
        if (i === c.disputedIndex) { engine.applyEvent(ctl.escrow, m.id, 'submit'); engine.applyEvent(ctl.escrow, m.id, 'dispute'); }
      });
      var slider = $('ruling-slider');
      if (slider) slider.value = String(ctl.ruling.captureBps);
      ctl.render();
      return true;
    };

    ctl.convene = function () {
      ctl.convened = engine.convene(ctl.caseObj);
      ctl.consulted = true;
      ctl.render();
      return ctl.convened;
    };

    ctl.applyTribunal = function () {
      if (!ctl.convened) ctl.convene();
      var s = ctl.convened.settlement;
      ctl.ruling = { captureBps: s.captureBps, flags: s.flags.slice() };
      var slider = $('ruling-slider');
      if (slider) slider.value = String(s.captureBps);
      ctl.render();
      return ctl.ruling;
    };

    ctl.setRuling = function (bps) {
      var n = Math.max(0, Math.min(10000, Math.round(Number(bps) / 50) * 50));
      ctl.ruling.captureBps = isNaN(n) ? 5000 : n;
      ctl.renderRuling();
      ctl.renderPayloads();
    };

    ctl.toggleFlag = function (id) {
      if (engine.FLAG_IDS.indexOf(id) === -1) return false;
      var i = ctl.ruling.flags.indexOf(id);
      if (i === -1) ctl.ruling.flags.push(id); else ctl.ruling.flags.splice(i, 1);
      ctl.renderRuling();
      return true;
    };

    ctl.runSandbox = function () {
      ctl.run = engine.runRuling(ctl.caseObj, ctl.ruling);
      ctl.stepIdx = 0;
      ctl.render();
      return ctl.run;
    };

    ctl.fileRuling = function () {
      if (ctl.filed) return ctl.filed;
      var c = ctl.caseObj;
      var scored = engine.scoreRuling(c, ctl.ruling, { consulted: ctl.consulted });
      engine.applyEvent(ctl.escrow, c.disputed.id, 'rule', { captureBps: ctl.ruling.captureBps });
      ctl.run = engine.runRuling(c, ctl.ruling);
      ctl.stepIdx = 0;
      ctl.filed = scored;
      ctl.results[c.id] = scored;
      ctl.render();
      return scored;
    };

    ctl.nextCase = function () {
      var idx = engine.CASES.indexOf(ctl.caseObj);
      return ctl.loadCase(engine.CASES[(idx + 1) % engine.CASES.length].id);
    };

    ctl.selectStep = function (i) {
      ctl.stepIdx = Math.max(0, i | 0);
      ctl.renderPayloads();
    };

    ctl.setToken = function (t) {
      ctl.token = String(t || '').trim();
      ctl.liveMode = ctl.token ? 'live sandbox armed' : 'simulated sandbox';
      setText('live-status', 'Mode: ' + ctl.liveMode);
    };

    ctl.sendLive = function () {
      var run = currentRun();
      var step = run.steps[Math.min(ctl.stepIdx, run.steps.length - 1)];
      if (!ctl.token) { setText('live-status', 'Mode: simulated sandbox (paste a sandbox token to send live)'); return Promise.resolve({ ok: false, reason: 'no-token' }); }
      return engine.executeRequest(step.request, { token: ctl.token, fetchImpl: options.fetchImpl }).then(function (res) {
        ctl.liveMode = res.ok ? 'live sandbox responded ' + res.status : 'live sandbox error ' + (res.status || res.reason);
        setText('live-status', 'Mode: ' + ctl.liveMode);
        return res;
      });
    };

    ctl.act = function (name, arg) {
      if (name === 'flag') return ctl.toggleFlag(arg);
      if (name === 'step') return ctl.selectStep(parseInt(arg, 10));
      return null;
    };

    function currentRun() {
      return ctl.run || engine.runRuling(ctl.caseObj, ctl.ruling);
    }

    /* ----- rendering ----- */

    ctl.renderCase = function () {
      var c = ctl.caseObj;
      setText('case-title', c.title + ' (' + c.buyer + ' vs ' + c.seller + ')');
      setText('case-brief', c.brief);
      setHTML('milestone-rows', ctl.escrow.milestones.map(function (m) {
        return '<tr><th scope="row">' + esc(m.id + ' ' + m.title) + '</th><td><span class="state ' + m.state + '">' + m.state + '</span></td><td class="num">' + engine.fmtCents(m.amountCents) + '</td></tr>';
      }).join(''));
      setHTML('claim-box', '<strong>' + esc(c.claim.by === 'buyer' ? c.buyer : c.seller) + ' claims</strong> (refund demand ' + c.claim.demandRefundBps + ' bps): ' + esc(c.claim.text));
    };

    ctl.renderEvidence = function () {
      var c = ctl.caseObj;
      var reqRows = c.requirements.map(function (r) {
        return '<tr><td>' + esc(r.id) + '</td><td>' + esc(r.text) + (r.addedByBuyer ? ' <em>(added after signing)</em>' : '') + '</td><td class="num">' + Math.round(r.weight * 100) + '%</td></tr>';
      }).join('');
      var fileRows = c.diff.files.map(function (f) {
        return '<tr><td>' + esc(f.path) + '</td><td class="num">+' + f.added + ' -' + f.removed + '</td><td class="num">' + f.tests + ' tests</td></tr>';
      }).join('');
      setHTML('spec-evidence',
        '<table aria-label="Requirements"><thead><tr><th scope="col">Id</th><th scope="col">Requirement</th><th scope="col" class="num">Weight</th></tr></thead><tbody>' + reqRows + '</tbody></table>' +
        '<table aria-label="Git diff"><thead><tr><th scope="col">File</th><th scope="col" class="num">Lines</th><th scope="col" class="num">Tests</th></tr></thead><tbody>' + fileRows + '</tbody></table>');
      var manifestRows = c.manifest.map(function (m) {
        return '<tr><td>' + esc(m.path) + '</td><td class="num">' + m.approvedSha.slice(0, 10) + '</td><td class="num">' + m.deliveredSha.slice(0, 10) + '</td></tr>';
      }).join('');
      setHTML('telemetry-evidence',
        '<p class="hint-line">Claimed SLA: p95 under ' + c.telemetry.slaP95Ms + ' ms. The tribunal recomputes p95 from the raw samples.</p>' +
        '<table aria-label="Artifact manifest"><thead><tr><th scope="col">Artifact</th><th scope="col" class="num">Approved SHA-256</th><th scope="col" class="num">Delivered SHA-256</th></tr></thead><tbody>' + manifestRows + '</tbody></table>');
      setHTML('dispute-log', c.log.map(function (e) {
        return '<li><time>' + esc(e.t) + '</time><span class="who ' + esc(e.party) + '">' + esc(e.party) + '</span> (' + esc(e.kind) + '): ' + esc(e.text) + '</li>';
      }).join(''));
      var canvas = $('latency-canvas');
      if (canvas && typeof canvas.getContext === 'function') {
        var ctx = canvas.getContext('2d');
        if (ctx) drawLatency(ctx, c.telemetry.samples, c.telemetry.slaP95Ms, canvas.width, canvas.height);
        if (canvas.setAttribute) canvas.setAttribute('aria-label', 'Latency samples against the ' + c.telemetry.slaP95Ms + ' ms SLA, measured p95 ' + engine.p95(c.telemetry.samples) + ' ms');
      }
    };

    ctl.renderAgents = function () {
      var conv = ctl.convened;
      var defs = [
        { name: 'Spec Compliance Auditor', role: 'Maps the git diff onto the contract requirements' },
        { name: 'Telemetry & Hash Verifier', role: 'Recomputes p95 latency and every SHA-256' },
        { name: 'Settlement Split Calculator', role: 'Turns the findings into a capture and refund split' }
      ];
      setHTML('agent-cards', defs.map(function (d, i) {
        var body = '<span class="hint-line">Idle. Press Convene AI Tribunal.</span>';
        if (conv) {
          var kv = function (k, v) { return '<div class="kv"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'; };
          if (i === 0) body = kv('Spec coverage', (conv.spec.coverageBps / 100).toFixed(2) + '%') + kv('Unrequested code', (conv.spec.unmappedRatioBps / 100).toFixed(2) + '%') + kv('Buyer-added requirements', conv.spec.buyerAddedRequirements.join(', ') || 'none');
          if (i === 1) body = kv('Measured p95', conv.telemetry.measuredP95Ms + ' ms vs ' + conv.telemetry.slaP95Ms + ' ms') + kv('SLA score', (conv.telemetry.slaScoreBps / 100).toFixed(2) + '%') + kv('Hash mismatches', String(conv.telemetry.mismatches));
          if (i === 2) body = kv('Capture', conv.settlement.captureBps + ' bps (' + usd(conv.settlement.captureCents, engine) + ')') + kv('Refund', conv.settlement.refundBps + ' bps (' + usd(conv.settlement.refundCents, engine) + ')') + kv('Flags', conv.settlement.flags.join(', ') || 'none');
        }
        return '<article class="agent' + (conv ? ' done' : '') + '"><div class="agent-name">' + esc(d.name) + '</div><div class="agent-role">' + esc(d.role) + '</div><div class="agent-body">' + body + '</div></article>';
      }).join(''));
    };

    ctl.renderRuling = function () {
      var c = ctl.caseObj;
      var s = engine.splitByBps(c.disputed.amountCents, ctl.ruling.captureBps);
      setHTML('split-readout',
        '<div class="cap">Seller capture<strong>' + usd(s.captureCents, engine) + '</strong>' + s.captureBps + ' bps</div>' +
        '<div class="ref">Buyer refund<strong>' + usd(s.refundCents, engine) + '</strong>' + s.refundBps + ' bps</div>');
      setHTML('flag-buttons', engine.FLAGS.map(function (f) {
        var on = ctl.ruling.flags.indexOf(f.id) !== -1;
        return '<button type="button" class="chip" data-act="flag" data-arg="' + f.id + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(f.label) + '</button>';
      }).join(''));
      var file = $('btn-file');
      if (file) file.disabled = !!ctl.filed;
    };

    ctl.renderScore = function () {
      var ids = Object.keys(ctl.results);
      var total = ids.reduce(function (a, id) { return a + ctl.results[id].score; }, 0);
      setText('score-total', total + ' points, ' + ids.length + ' of ' + engine.CASES.length + ' disputes ruled, rank ' + engine.rankFor(total));
      setHTML('score-list', engine.CASES.map(function (c) {
        var r = ctl.results[c.id];
        return '<li>' + esc(c.title) + ': ' + (r ? r.score + ' (error ' + r.errorBps + ' bps)' : 'not ruled') + '</li>';
      }).join(''));
      var banner = $('result-banner');
      if (banner) {
        if (ctl.filed) {
          var f = ctl.filed;
          banner.hidden = false;
          banner.className = 'result' + (f.errorBps > 1000 ? ' warn' : '');
          banner.innerHTML = '<strong>Ruling filed.</strong> Fair split was ' + f.fairCaptureBps + ' bps to the seller, you ruled ' + ctl.ruling.captureBps + ' bps (error ' + f.errorBps + '). Score ' + f.score + '. Findings matched: ' + (f.hits.join(', ') || 'none') + '. Missed: ' + (f.missed.join(', ') || 'none') + '. Wrong: ' + (f.falsePositives.join(', ') || 'none') + '.' + (f.unaidedBonus ? ' Unaided bonus ' + f.unaidedBonus + '.' : '');
        } else { banner.hidden = true; banner.innerHTML = ''; }
      }
    };

    ctl.renderPayloads = function () {
      var run = currentRun();
      var i = Math.min(ctl.stepIdx, run.steps.length - 1);
      setHTML('step-tabs', run.steps.map(function (s, k) {
        return '<button type="button" class="tab" data-act="step" data-arg="' + k + '" aria-pressed="' + (k === i ? 'true' : 'false') + '">' + (k + 1) + '. ' + esc(s.label) + '</button>';
      }).join(''));
      var s = run.steps[i];
      setText('payload-title', s.request.method + ' ' + s.request.path);
      var shown = { method: s.request.method, url: engine.SANDBOX_BASE + s.request.path, headers: engine.redactHeaders(Object.assign({ Authorization: 'Bearer token' }, s.request.headers)), body: s.request.body };
      setText('payload-request', JSON.stringify(shown, null, 2));
      setText('payload-response', 'HTTP ' + s.response.status + '\n' + JSON.stringify(s.response.body, null, 2));
    };

    ctl.renderLedger = function () {
      var rows = engine.buildLedger(ctl.caseObj, ctl.run, ctl.convened, ctl.filed ? ctl.ruling : null);
      var useGrid = ctl.ledgerMode === 'ag-grid' && ctl.grid;
      var gridEl = $('ledger-grid'), fallback = $('ledger-fallback');
      if (useGrid) {
        if (ctl.grid.setGridOption) ctl.grid.setGridOption('rowData', rows);
        if (gridEl) gridEl.hidden = false;
        if (fallback) fallback.hidden = true;
      } else {
        var head = engine.LEDGER_COLUMNS.map(function (c) { return '<th scope="col">' + esc(c.headerName) + '</th>'; }).join('');
        var body = rows.map(function (r) {
          return '<tr>' + engine.LEDGER_COLUMNS.map(function (c) { return '<td>' + esc(r[c.field]) + '</td>'; }).join('') + '</tr>';
        }).join('');
        setHTML('ledger-table', '<caption class="hint-line">Audit ledger, ' + rows.length + ' rows</caption><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody>');
        if (gridEl) gridEl.hidden = true;
        if (fallback) fallback.hidden = false;
      }
      setText('ledger-mode', useGrid ? 'Ledger view: AG Grid Community (sortable, filterable, resizable)' : 'Ledger view: accessible HTML table fallback (AG Grid unavailable)');
      ctl.ledgerRows = rows;
    };

    ctl.mountGrid = function () {
      var lib = options.agGrid !== undefined ? options.agGrid : (typeof window !== 'undefined' ? window.agGrid : null);
      var el = $('ledger-grid');
      if (lib && typeof lib.createGrid === 'function' && el) {
        ctl.grid = lib.createGrid(el, {
          columnDefs: engine.LEDGER_COLUMNS,
          rowData: [],
          defaultColDef: { sortable: true, filter: true, resizable: true },
          animateRows: false
        });
        ctl.ledgerMode = 'ag-grid';
      } else {
        ctl.ledgerMode = 'table';
      }
    };

    ctl.renderHeader = function () {
      var sel = $('case-select');
      if (sel) {
        sel.innerHTML = engine.CASES.map(function (c) { return '<option value="' + c.id + '">' + esc(c.title) + '</option>'; }).join('');
        sel.value = ctl.caseObj.id;
      }
    };

    ctl.render = function () {
      if (!ctl.caseObj) return;
      ctl.renderHeader();
      ctl.renderCase();
      ctl.renderEvidence();
      ctl.renderAgents();
      ctl.renderRuling();
      ctl.renderScore();
      ctl.renderPayloads();
      ctl.renderLedger();
      setText('live-status', 'Mode: ' + ctl.liveMode);
    };

    ctl.bind = function () {
      function on(id, type, fn) { var e = $(id); if (e && e.addEventListener) e.addEventListener(type, fn); }
      on('case-select', 'change', function (e) { ctl.loadCase(e.target.value); });
      on('btn-convene', 'click', function () { ctl.convene(); });
      on('btn-apply', 'click', function () { ctl.applyTribunal(); });
      on('btn-sandbox', 'click', function () { ctl.runSandbox(); });
      on('btn-file', 'click', function () { ctl.fileRuling(); });
      on('btn-next', 'click', function () { ctl.nextCase(); });
      on('btn-live', 'click', function () { ctl.sendLive(); });
      on('ruling-slider', 'input', function (e) { ctl.setRuling(e.target.value); });
      on('paypal-token', 'input', function (e) { ctl.setToken(e.target.value); });
      ['flag-buttons', 'step-tabs'].forEach(function (id) {
        on(id, 'click', function (e) {
          var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
          if (!t) return;
          var d = t.dataset || {};
          ctl.act(d.act, d.arg);
        });
      });
    };

    ctl.init = function () {
      ctl.mountGrid();
      ctl.bind();
      ctl.loadCase(engine.CASES[0].id);
      return ctl;
    };

    return ctl;
  }

  var api = { createController: createController, drawLatency: drawLatency, esc: esc };

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.EscrowArena) {
    api.app = createController(window.EscrowArena, document).init();
  }
  return api;
}));
