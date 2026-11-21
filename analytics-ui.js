/*
 * EscrowArena verification telemetry UI.
 * Renders the deterministic analytics bundle computed by analytics.js.
 * Zero dependencies. Runs only in a browser with the analytics module loaded.
 */
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  var A = window.EscrowArenaAnalytics;
  if (!A) return;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var bundleJSON = '';

  function render(bundle) {
    var chips = $('verify-chips');
    if (chips) {
      chips.innerHTML = '';
      Object.keys(bundle.selfChecks).forEach(function (k) {
        var ok = bundle.selfChecks[k] === true;
        var span = document.createElement('span');
        span.className = 'verify-chip ' + (ok ? 'ok' : 'bad');
        span.textContent = k + ': ' + (ok ? 'OK' : 'FAIL');
        chips.appendChild(span);
      });
    }

    var readout = $('verify-readout');
    if (readout) {
      var pairs = [
        ['money rows reconciled', bundle.money.passing + ' / ' + bundle.money.checked],
        ['SHA-256 artifacts audited', String(bundle.manifest.checked)],
        ['tampered artifacts detected', String(bundle.manifest.tampered)],
        ['disputes analyzed', String(bundle.fairness.cases)],
        ['state transitions checked', bundle.transitions.passing + ' / ' + bundle.transitions.checked],
        ['basis points checked', String(bundle.boundary.checked)],
        ['all checks pass', bundle.allChecksPass ? 'yes' : 'no']
      ];
      readout.innerHTML = pairs.map(function (p) {
        return '<div class="kv"><span>' + esc(p[0]) + '</span><b>' + esc(p[1]) + '</b></div>';
      }).join('');
    }

    var table = $('verify-table');
    if (table) {
      var head = '<thead><tr><th scope="col">Case</th><th scope="col">Capture bps</th><th scope="col">p95 ms</th><th scope="col">Flags</th></tr></thead>';
      var body = '<tbody>' + bundle.fairness.rows.map(function (r) {
        return '<tr><th scope="row">' + esc(r.caseId) + '</th><td class="num">' + esc(r.captureBps) +
          '</td><td class="num">' + esc(r.p95) + '</td><td>' + esc(r.flags.join(', ') || 'none') + '</td></tr>';
      }).join('') + '</tbody>';
      table.innerHTML = '<caption class="hint-line">Per case tribunal telemetry</caption>' + head + body;
    }
  }

  function run() {
    var bundle = A.verificationBundle();
    bundleJSON = JSON.stringify(bundle, null, 2);
    render(bundle);
    var status = $('verify-status');
    if (status) {
      status.textContent = 'Verification bundle computed locally: ' +
        (bundle.allChecksPass ? 'all self checks pass' : 'a check failed') +
        '. No network request was made.';
    }
    return bundle;
  }

  var runBtn = $('btn-verify');
  if (runBtn && runBtn.addEventListener) runBtn.addEventListener('click', run);

  var copyBtn = $('btn-verify-export');
  if (copyBtn && copyBtn.addEventListener) {
    copyBtn.addEventListener('click', function () {
      if (!bundleJSON) run();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(bundleJSON).catch(function () {});
      }
      var status = $('verify-status');
      if (status) status.textContent = 'Verification JSON copied to the clipboard.';
    });
  }

  var dlBtn = $('btn-verify-download');
  if (dlBtn && dlBtn.addEventListener) {
    dlBtn.addEventListener('click', function () {
      if (!bundleJSON) run();
      var blob = new Blob([bundleJSON], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'escrow-arena-verification.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
  }

  run();
}());
