# EscrowArena

An AI milestone escrow and dispute tribunal game, with a PayPal sandbox request studio and an audit ledger.

Live demo: https://aariv.me/escrow-arena/

You play the arbiter. A contract has three milestones. The middle one is in dispute. You read the evidence (git diff against the spec, raw latency samples, SHA-256 artifact manifests, the buyer and seller message log), optionally convene a three-agent AI tribunal, and set a capture and refund split in basis points. The app then builds the PayPal request payloads for your ruling and runs them through a deterministic sandbox simulator.

This is a second entry for the PayPal AI Hackathon. It is aimed at the Most Creative, Best Use of PayPal and AI, Best Use of Agentic Commerce and Best Use of AG Grid categories. That is the intent, not a claim about any outcome.

## How to play

1. Pick a dispute (six handwritten ones).
2. Read the four evidence panels. Each case hides one or two problems: refund fraud by the buyer, scope creep by either side, a tampered artifact, a missed latency SLA, or under-delivery.
3. Move the ruling slider and tick the findings you want on the record.
4. Press "File my ruling". You are scored on how close your split is to the fair one, on the findings you named, and on a bonus if you were right without consulting the tribunal.

Judge shortcuts in the header: "Convene AI Tribunal" runs all three agents, "Apply Tribunal Ruling" copies their split and findings into your ruling, "Run Sandbox Payloads" runs the full PayPal lifecycle for the current slider position.

## Architecture

All rules and money math are in `engine.js`, a dependency-free UMD module.

| Piece | What it does |
| --- | --- |
| Spec Compliance Auditor | Maps changed files onto weighted requirements, ignores requirements the buyer added after signing, and measures the share of added lines that no requirement asked for |
| Telemetry & Hash Verifier | Recomputes p95 latency from 100 raw samples (nearest rank) and recomputes every SHA-256 in the manifest with a pure JavaScript implementation that the tests check against Node crypto |
| Settlement Split Calculator | Capture basis points = spec coverage times a quality factor of 0.6 plus 0.2 times the SLA score plus 0.2 times the hash score. It also raises the risk flags |
| Escrow state machine | PENDING, FUNDED, SUBMITTED, DISPUTED, then RELEASED, SETTLED_PARTIAL or REFUNDED, with invalid transitions rejected |
| PayPal builders | Orders v2 (`intent` AUTHORIZE or CAPTURE, one `purchase_unit` per milestone), authorization capture, authorization void, capture refund and Payouts requests |
| Sandbox simulator | Deterministic, seeded, SIM- prefixed identifiers, rejects over-capture, double capture, over-refund and intent mismatches |
| Ledger | Milestones, evidence, agent calls, the ruling and every PayPal call as rows, shown in AG Grid or an HTML table |

Money is integer cents and splits are integer basis points. The capture is rounded down to a whole cent and the residual cent goes to the buyer, so capture plus refund always equals the milestone amount.

`app.js` only renders and binds events. `createController(engine, document, options)` accepts any document-like object, which is how the tests drive it without a browser. `analytics.js` and `analytics-ui.js` add the verification layer described above; they attach to the engine and never change a rule or a cent.

## AG Grid

The audit ledger uses AG Grid Community 32.3.3 loaded from jsDelivr. If the script is blocked, offline or fails to load, the same rows render in an accessible HTML table, and the page says which view is active. The tests run in the table path by default and also inject a fake `agGrid` to check the grid path.

## PayPal usage, stated plainly

- The default mode is a simulated sandbox running locally. No live PayPal call was made while building or testing this project.
- Request shapes (Orders v2 with multiple purchase units, authorization capture with `final_capture`, capture refund, Payouts) follow the public documentation as the author understood it. They have not been verified against the live sandbox. In particular, whether the sandbox accepts three purchase units in one order for every funding source is untested.
- Simulator error names such as `AMOUNT_EXCEEDS_AUTHORIZED` are modeled approximations, not copies of PayPal responses.
- Live mode is opt-in: paste a sandbox bearer token and the selected request is sent to `https://api-m.sandbox.paypal.com` only. Any other host is refused by the code.
- All parties, evidence and amounts are invented, and the seller email is the reserved `example.com`.

## Tests

```
npm test
```

This runs `node --test` with no installs. 489 passing tests across seven suites:

- `tests/engine.test.js`: hashing, money rounding, the agents, the state machine, the request builders, the simulator and scoring.
- `tests/dom-smoke.test.js`: the markup, the controller on a small fake DOM in both grid modes, and repository scans for dashes, emoji, uppercase kickers, credential-shaped strings and private details.
- `tests/analytics.test.js`: 28 tests over money reconciliation, the SHA-256 manifest audit checked against Node crypto, tribunal fairness identities, the exhaustive state transition matrix, integer basis point boundaries and the reproducible verification bundle.
- `tests/compliance.test.js`: 10 tests locking the no-dash, no-disclosure, no-private-detail and doc consistency rules.
- `tests/hardening.test.js`: 35 adversarial tests locking input validation, NaN and Infinity rulings, sandbox double-capture and over-refund guards, malformed amount handling, money conservation invariants, CSP markup and accessibility checks.
- `tests/mechanism.test.js`: 235 tests over the mechanism lab: exact integer-cent conservation in every protocol and attack cell across the bond grid, payoff identities, ROI sign conventions, deterrence thresholds and windows, timeout-bounded liveness, the checksummed audit exports and the strict bookmark codec.
- `tests/mechanism-ui.test.js`: 50 tests over the lab markup, the CSP and script order, and the lab controller on the fake DOM: matrix selection, the SVG threshold chart, controls, the self-test panel, exports and bookmarking.

## Analytics and verification telemetry

`analytics.js` is a dependency-free UMD analysis layer over `engine.js`. It runs five deterministic computations:

- **Money reconciliation**: every ruling split over all six disputes, verifying capture plus refund equals the milestone amount, payout plus fee equals capture, and the simulator ledger totals reconcile.
- **SHA-256 manifest audit**: recompute every approved and delivered artifact hash and confirm the stored hashes match. The tests cross-check the pure JS implementation against Node crypto.
- **Tribunal fairness**: recompute spec coverage, measured p95, the quality factor identity and the flags for each case, and confirm the tribunal own ruling scores the maximum.
- **State transition matrix**: drive all 35 state and event pairs and verify valid events land in the right state while invalid ones are rejected.
- **Basis point boundaries**: prove the floor-to-cent rule and the buyer residual cent over all 10,001 integer basis point values.

`analytics-ui.js` renders these results in a Verification telemetry panel with a pass or fail chip per check, a readout, a per-case table, and copy and download controls for the full verification bundle. Every number is computed in the browser at render time.

## Adversarial mechanism lab

`mechanism-lab.js` is a deterministic game-theory workbench that stresses five escrow protocols (single-release trust, milestone partial-release, symmetric collateral, a Schelling-point stake-slashing jury, and a time-locked release with an evidence bond) against six adversarial behaviors (honest delivery, buyer griefing, seller ghosting, bribed arbiter collusion, Sybil jury packing and timeout stalling). Every cell of the five by six matrix keeps an explicit escrow pot ledger in integer cents, so value conservation (buyer + seller + arbiter + slashed equals totalLocked) is proved per cell rather than assumed.

From those ledgers the lab derives the honest-strategy payoff dominance margin, griefing attack ROI (negative means economically deterred), the deterrence threshold over a collateral bond sweep from 0 to 150 percent of contract, deterrence windows where a cheap attack re-emerges, and the minimum bond ratio at which a protocol becomes incentive compatible. The headline result: only the stake-slashing jury reaches incentive compatibility, at a 92.5 percent pool bond, while the single corruptible arbiter fails everywhere.

`mechanism-ui.js` renders the interactive payoff matrix, a bond-threshold sensitivity chart (five attack curves, the deterrence boundary and exact threshold markers), a per-protocol scoreboard, and the selected cell's escrow ledger. A Run Self-Tests panel proves twelve properties live in the browser: FIPS 180-4 SHA-256 known-answer vectors, conservation over 270 grid cells, payoff identities, threshold monotonicity or honestly reported windows, timeout-bounded liveness, CSV formula-injection escaping, tamper detection, strict `#escrow=` bookmark round-trips, ROI sign conventions and matrix shape. JSON, CSV and Markdown audit exports carry an unkeyed SHA-256 tamper-detection digest (not a signature) that the page can replay-verify.

`headless-audit.mjs` is a zero-dependency Node script that drives a real headless Chromium over the DevTools protocol at 1440x900 and 390x844. The last run reported 31 checks, all passing: zero console errors, zero page errors, zero failed requests, external hosts limited to the pinned jsDelivr CDN, zero horizontal page overflow, and the matrix scrolling inside its own wrap on the phone viewport.

## Verification & limits

All cases, evidence and agent logic are deterministic and tested locally. The verification bundle reports eight self checks and makes no network request. No live PayPal call was made while building or testing this project. Aariv Patel authored the project and owns the repository. Playtesting is verified through the automated test suite.

## License

MIT, see `LICENSE`.
