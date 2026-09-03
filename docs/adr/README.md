# Architecture Decision Records

Short, dated records of significant or non-obvious technical decisions — the _why_ behind choices a future contributor (or future you) would otherwise have to reverse-engineer or accidentally undo.

## Format

One file per decision: `NNNN-short-title.md`, numbered sequentially. Each has: **Status** (Proposed / Accepted / Superseded by NNNN), **Context** (the forces at play), **Decision** (what we chose), **Consequences** (the trade-off we accepted). Keep them short — a screen or less.

## When to write one

- A choice with real trade-offs that wasn't obvious (storage model, auth provider, framework, a deliberate deferral).
- A decision someone might reasonably try to reverse later — capture _why not_ so they don't relearn it the hard way.
- Not every PR. Routine changes don't need an ADR.

## Index

| #                                                                  | Title                                                  | Status   |
| ------------------------------------------------------------------ | ------------------------------------------------------ | -------- |
| [0000](0000-record-architecture-decisions.md)                      | Record architecture decisions                          | Accepted |
| [0002](0002-serverless-on-aws.md)                                  | Serverless on AWS, single region                       | Accepted |
| [0003](0003-single-table-dynamodb.md)                              | Single-table DynamoDB                                  | Accepted |
| [0004](0004-no-waf-on-http-api.md)                                 | No WAF on the HTTP API (it's unsupported)              | Accepted |
| [0005](0005-npm-workspaces-monorepo.md)                            | npm-workspaces monorepo layout                         | Accepted |
| [0006](0006-standards-applicability-declarations.md)               | Standards applicability declarations                   | Accepted |
| [0007](0007-i18n-json-catalogs-native-format.md)                   | i18n: JSON catalogs, i18next-native format             | Accepted |
| [0008](0008-unit-aware-rag-grounding.md)                           | Unit-aware quantitative RAG grounding                  | Accepted |
| [0009](0009-three-state-grounding-verdict.md)                      | Three-state grounding verdict                          | Accepted |
| [0010](0010-settled-read-states.md)                                | Settled read states                                    | Accepted |
| [0011](0011-categorical-pet-safety-claims-block.md)                | Ungrounded pet-safety claims block                     | Accepted |
| [0012](0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md)   | Plant.id unit cost withdraws annual and lifetime plans | Accepted |
| [0013](0013-build-time-prerendering-of-public-routes.md)           | Build-time prerendering of public routes               | Accepted |
| [0015](0015-the-away-kit.md)                                       | The Away Kit: sitter links as the paid differentiator  | Accepted |
| [0016](0016-plant-tags-account-free-care-actions.md)               | Plant Tags: account-free care actions                  | Accepted |
| [0017](0017-cross-home-today-is-a-work-queue-not-a-global-view.md) | Cross-home Today is a work queue, not a global view    | Accepted |
| [0021](0021-email-rendering-and-usefulness.md)                     | HTML email, localized, with one-click unsubscribe      | Accepted |
| [0022](0022-email-deliverability-and-bounce-handling.md)           | Email deliverability and bounce handling               | Accepted |
| [0023](0023-billing-lifecycle-emails.md)                           | Billing lifecycle emails                               | Accepted |

> Several earlier decisions (Cognito for auth, React+Vite+TanStack Query, gated external integrations) are documented inline in `docs/architecture.md` / `docs/strategy-review.md` and could be backfilled as ADRs when next touched.
