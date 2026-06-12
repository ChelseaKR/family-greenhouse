# Security Policy

Family Greenhouse is a small, actively maintained project. Security reports
are read and acted on quickly — thank you for taking the time.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Preferred: use GitHub's private vulnerability reporting
  ("Security" tab → "Report a vulnerability") on this repository.
- Or email: security@familygreenhouse.net

You can expect an acknowledgement within 72 hours. Please include enough
detail to reproduce (endpoint, request shape, account state). Reports
affecting other users' data are treated as the highest severity.

## Scope

- The application at https://familygreenhouse.net and its API
- This repository's code and infrastructure definitions

Out of scope: denial-of-service volume testing, social engineering, and
findings that require a compromised device or account. Automated scanning
against production is discouraged — the same code runs locally
(`npm --workspace backend run dev`), so most findings can be demonstrated
offline.

## Disclosure

Coordinated disclosure is appreciated; fixes for confirmed reports are
typically deployed within days. Past security reviews and their remediations
are documented in `docs/reviews/` and `docs/security-review-2026-05-31.md`.
