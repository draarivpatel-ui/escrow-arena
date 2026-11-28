# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/escrow-arena/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the static EscrowArena browser application, the deterministic escrow engine, PayPal sandbox request builders, the local sandbox simulator, tribunal output, the audit ledger and report exports.

In scope:

- A cross-site scripting or HTML injection path through dispute evidence, ruling input, ledger rendering, analytics output, share links or exported reports.
- A validation or state-transition flaw that permits overcapture, double capture, over-refund, forged settlement state or another violation of the documented money-conservation rules.
- A sandbox credential handling flaw that sends a token to any host other than the documented PayPal sandbox endpoint or exposes it through page output, storage or exports.
- A report export or serialization flaw that makes generated output execute a formula or script when opened.

Out of scope:

- Live PayPal API behavior, PayPal account security, or availability of PayPal services.
- Browser vulnerabilities, operating system compromise or physical access to the machine.
- The invented dispute facts and game scoring model, unless a report shows a specific validation or output integrity failure.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
