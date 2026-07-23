# Security Policy

## Supported versions

nit is a developer tool released from a single line. Only the latest published
version of `@spaceparrots/nit` receives security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report privately through
[GitHub Security Advisories](https://github.com/SpaceParrots/nit/security/advisories/new),
or by email to <kevin.mattutat@spaceparrots.de>.

Include the affected version, reproduction steps, and what an attacker gains.
You can expect an acknowledgement within 7 days and, for confirmed issues, a fix
or mitigation plan within 30 days. Please give us a chance to ship a fix before
disclosing publicly.

## Threat model

Two things are worth knowing when judging whether a finding is in scope:

- **nit drives a real browser against sites you point it at.** `nit review` and
  `nit verify` inject an overlay into arbitrary third-party pages. Treat the
  page as untrusted: anything that lets page content escape the overlay's shadow
  root and reach the Node side, or write outside the review folder, is in scope.
- **`annotations.json` and `review.md` are consumed by coding agents.** The
  fields are attacker-influenceable (they can contain text scraped from the
  page). Anything that lets that content forge structure in the rendered review,
  or escape sanitization, is in scope.

Out of scope: issues that require the operator to deliberately point nit at a
malicious site *and* hand the result to an agent without review, vulnerabilities
in Playwright or Chromium themselves (report those upstream), and findings that
only affect unsupported Node versions.
