# Architecture Decision Records

Short, dated records of significant or non-obvious technical decisions — the _why_ behind choices a future contributor (or future you) would otherwise have to reverse-engineer or accidentally undo.

## Format

One file per decision: `NNNN-short-title.md`, numbered sequentially. Each has: **Status** (Proposed / Accepted / Superseded by NNNN), **Context** (the forces at play), **Decision** (what we chose), **Consequences** (the trade-off we accepted). Keep them short — a screen or less.

## When to write one

- A choice with real trade-offs that wasn't obvious (storage model, auth provider, framework, a deliberate deferral).
- A decision someone might reasonably try to reverse later — capture _why not_ so they don't relearn it the hard way.
- Not every PR. Routine changes don't need an ADR.

## Index

This table is GENERATED from the files in this directory by
`scripts/check-adr-index.mjs`, which runs in `npm run verify` and in CI's
`Lint` job. Do not hand-edit it: add the ADR file, then run
`node scripts/check-adr-index.mjs --write && npx prettier --write docs/adr/README.md`.

It used to be hand-maintained, and every branch carrying a decision appended a
row to the same last line — a merge conflict on every parallel PR whose only
correct resolution was mechanical, and whose easiest wrong resolution silently
dropped somebody else's row (issue #475). Deriving it also means a renamed file
can no longer leave a dead link, and an ADR added without a row can no longer
be invisible.

<!-- BEGIN:ADR-INDEX -->

| #                                                                   | Title                                                                                              | Status   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| [0000](0000-record-architecture-decisions.md)                       | Record architecture decisions                                                                      | Accepted |
| [0002](0002-serverless-on-aws.md)                                   | Serverless on AWS, single region                                                                   | Accepted |
| [0003](0003-single-table-dynamodb.md)                               | Single-table DynamoDB                                                                              | Accepted |
| [0004](0004-no-waf-on-http-api.md)                                  | No WAF on the HTTP API (it's unsupported)                                                          | Accepted |
| [0005](0005-npm-workspaces-monorepo.md)                             | npm-workspaces monorepo layout                                                                     | Accepted |
| [0006](0006-standards-applicability-declarations.md)                | Standards applicability declarations                                                               | Accepted |
| [0007](0007-i18n-json-catalogs-native-format.md)                    | i18n: per-locale JSON catalogs, i18next-native message format                                      | Accepted |
| [0008](0008-unit-aware-rag-grounding.md)                            | Unit-aware quantitative grounding for RAG answers                                                  | Accepted |
| [0009](0009-three-state-grounding-verdict.md)                       | The grounding guard reports a three-state verdict, not a boolean                                   | Accepted |
| [0010](0010-settled-read-states.md)                                 | A settled read with no data is its own state, not an empty one                                     | Accepted |
| [0011](0011-categorical-pet-safety-claims-block.md)                 | An ungrounded pet-safety claim blocks; it is never merely `unverified`                             | Accepted |
| [0012](0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md)    | Identification has a real per-call cost, and at that cost the annual and lifetime plans lose money | Accepted |
| [0013](0013-build-time-prerendering-of-public-routes.md)            | Build-time prerendering of the public routes                                                       | Accepted |
| [0014](0014-plans-drawn-on-homes-and-hands.md)                      | The plan line is drawn on homes and hands, not on collection size                                  | Accepted |
| [0015](0015-the-away-kit.md)                                        | The Away Kit: sitter links become the product's paid differentiator                                | Accepted |
| [0016](0016-plant-tags-account-free-care-actions.md)                | Plant Tags: account-free care actions from a printed QR label                                      | Accepted |
| [0017](0017-cross-home-today-is-a-work-queue-not-a-global-view.md)  | Cross-home Today is a work queue, not a global view                                                | Accepted |
| [0018](0018-one-assignment-resolver-for-escalation-and-rotation.md) | One assignment resolver for auto-handoff escalation and care rotation                              | Accepted |
| [0019](0019-identification-top-up-packs.md)                         | Identification is sold by the pack beyond the plan allowance, not raised in tiers                  | Accepted |
| [0020](0020-token-scoped-caretaker-seats.md)                        | Caretaker seats are token-scoped identities, not accounts                                          | Accepted |
| [0021](0021-email-rendering-and-usefulness.md)                      | HTML email, localized, with one-click unsubscribe                                                  | Accepted |
| [0022](0022-email-deliverability-and-bounce-handling.md)            | Outbound mail authenticates twice, and a bounce has consequences                                   | Accepted |
| [0023](0023-billing-lifecycle-emails.md)                            | Billing lifecycle emails: transactional, idempotent, and never a number we did not read            | Accepted |
| [0024](0024-ask-family-to-do-it.md)                                 | "Ask family to do it" is a second door onto one state                                              | Accepted |
| [0025](0025-household-timezone-and-the-due-date-migration.md)       | A due date is a calendar day in the household's zone, and the migration to it is staged            | Proposed |
| [0026](0026-household-counts-over-a-partial-payload-block.md)       | An answer may not count a household it was only partly given                                       | Accepted |

> Numbers not in use: 0001. Gaps are expected — a number can be claimed on a branch that never lands — and this line is generated, so a file that goes missing shows up here instead of silently.

<!-- END:ADR-INDEX -->

> Several earlier decisions (Cognito for auth, React+Vite+TanStack Query, gated external integrations) are documented inline in `docs/architecture.md` / `docs/strategy-review.md` and could be backfilled as ADRs when next touched.
