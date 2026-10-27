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

`app.js` only renders and binds events. `createController(engine, document, options)` accepts any document-like object, which is how the tests drive it without a browser.

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

This runs `node --test` with no installs. `tests/engine.test.js` covers hashing, money rounding, the agents, the state machine, the request builders, the simulator and scoring. `tests/dom-smoke.test.js` checks the markup, drives the controller on a small fake DOM in both grid modes, and scans every file for dashes, emoji, uppercase kickers, credential-shaped strings and private details.

## AI disclosure

This project was designed and written with an AI coding assistant (Claude), then run and tested locally. The cases, evidence and agent logic were written by the assistant. Aariv Patel directed the project and owns the repository. No human played or reviewed the game before publication.

## License

MIT, see `LICENSE`.
