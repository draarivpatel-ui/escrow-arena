# Build notes

Written 2026-10-26 (local clock, checked with `date`).

## Decisions

- Basis points and integer cents everywhere, so there is no floating point in the money path. The only rounding is the documented floor on the seller capture.
- One PayPal authorization per milestone (one purchase unit each). Releasing the disputed milestone is a capture with `final_capture` true, which closes the rest. A zero capture is a void.
- On capture-intent cases the ruling is a refund against the milestone capture, plus a seller payout for the kept amount minus a 2.5 percent platform fee.
- The quality factor starts at 0.6 so that a perfect spec with a failed SLA and failed hashes still earns 60 percent rather than zero. That is a game design choice, not a legal standard.
- Refund fraud is defined narrowly: refund demand of at least 50 percent, a fair capture of at least 90 percent, and a buyer approval or deploy event before the claim.
- Latency evidence is raw samples, and the p95 shown in the case text is never trusted: the verifier recomputes it.
- The hash verifier uses its own SHA-256, checked against Node crypto in the tests, so the browser needs no library.

## What was verified

- All six cases produce the intended capture split and flags (tests 20 to 22).
- Every ruling in a sweep (0, 1, 2500, 5000, 8427, 9999, 10000 bps) runs through the simulator on all six cases without an error response, and the disputed milestone is fully accounted for (tests 49 and 50).
- The AG Grid script and both stylesheets exist at the pinned jsDelivr URLs (checked with HTTP requests on the build date). 
- One headless Chrome screenshot at 1400px wide (throwaway profile) after applying the tribunal ruling and filing it showed AG Grid Community mounted with its filter icons, the score banner, the three agent cards and the payload inspector. Only that first dispute in that state was looked at; the other five disputes, the HTML fallback table (grid unavailable) and the narrow layout were not.

## What is not verified

- Live PayPal sandbox behaviour, see the README.
- Narrow phone layouts and browsers other than headless Chrome.
