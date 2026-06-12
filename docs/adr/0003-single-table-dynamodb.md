# 0003 — Single-table DynamoDB

**Status:** Accepted

## Context

The data is hierarchical and access is almost always household-scoped (a household's plants, a plant's tasks, a household's activity feed). A relational store would mean managing a server/connection pool (anti-serverless) and join-heavy queries; multiple DynamoDB tables would scatter related entities and multiply the things to provision.

## Decision

One DynamoDB table, on-demand (PAY_PER_REQUEST), single-table design: entity type encoded in the `SK` prefix (`HOUSEHOLD#`, `MEMBER#`, `PLANT#`, `TASK#`, …) under a household `PK`, with GSIs for the cross-cutting reads (tasks-by-due-date, tasks-by-assignee, API-key-by-hash). TTL on ephemeral rows (invites, caches, the Stripe-event ledger).

## Consequences

- **Single-digit-ms reads** on the known access patterns; no connection management; scales with traffic.
- **On-demand billing** fits bursty/low traffic (no capacity planning); revisit provisioned+autoscaling only at sustained high volume.
- **Trade-off: access patterns are designed up front.** A genuinely new query shape may need a new GSI — a deliberate change, not an ad-hoc `WHERE`. New non-obvious patterns warrant an ADR.
- **Trade-off: no relational integrity / ad-hoc analytics.** Cross-entity consistency is handled with `TransactWrite` where it matters; analytics is computed in-app, not via SQL.
- A curated static catalog backs species autocomplete so the app works even with Perenual off.
