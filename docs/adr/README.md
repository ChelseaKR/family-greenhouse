# Architecture Decision Records

Short, dated records of significant or non-obvious technical decisions — the _why_ behind choices a future contributor (or future you) would otherwise have to reverse-engineer or accidentally undo.

## Format

One file per decision: `NNNN-short-title.md`, numbered sequentially. Each has: **Status** (Proposed / Accepted / Superseded by NNNN), **Context** (the forces at play), **Decision** (what we chose), **Consequences** (the trade-off we accepted). Keep them short — a screen or less.

## When to write one

- A choice with real trade-offs that wasn't obvious (storage model, auth provider, framework, a deliberate deferral).
- A decision someone might reasonably try to reverse later — capture _why not_ so they don't relearn it the hard way.
- Not every PR. Routine changes don't need an ADR.

## Index

| #                                                    | Title                                      | Status   |
| ---------------------------------------------------- | ------------------------------------------ | -------- |
| [0000](0000-record-architecture-decisions.md)        | Record architecture decisions              | Accepted |
| [0002](0002-serverless-on-aws.md)                    | Serverless on AWS, single region           | Accepted |
| [0003](0003-single-table-dynamodb.md)                | Single-table DynamoDB                      | Accepted |
| [0004](0004-no-waf-on-http-api.md)                   | No WAF on the HTTP API (it's unsupported)  | Accepted |
| [0005](0005-npm-workspaces-monorepo.md)              | npm-workspaces monorepo layout             | Accepted |
| [0006](0006-standards-applicability-declarations.md) | Standards applicability declarations       | Accepted |
| [0007](0007-i18n-json-catalogs-native-format.md)     | i18n: JSON catalogs, i18next-native format | Accepted |

> Several earlier decisions (Cognito for auth, React+Vite+TanStack Query, gated external integrations) are documented inline in `docs/architecture.md` / `docs/strategy-review.md` and could be backfilled as ADRs when next touched.
