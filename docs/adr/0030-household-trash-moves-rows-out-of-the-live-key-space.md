# 0030 — The household trash moves rows out of the live key space instead of flagging them

**Status:** Proposed

**Date:** 2026-09-17

**Deciders:** Chelsea Kelly-Reif

**Related:** [#670](https://github.com/ChelseaKR/family-greenhouse/issues/670);
[ADR 0003](0003-single-table-dynamodb.md) (single-table keys);
[ADR 0010](0010-settled-read-states.md) (a failed read is not an empty one);
`backend/src/services/trashService.ts`, which carries the working detail.

## Context

Deleting a plant used to be permanent and cascaded across its tasks, completions and photo
timeline. A household is several people with delete rights, so "someone deleted the wrong
plant" is a support case the docs already name, and the answer was a DynamoDB point-in-time
restore. #670 asks for a 30-day trash: deleted plants and tasks disappear from **every**
surface — lists, reminders, the calendar feed, digests, the sitter / kiosk / tag / share token
views, the public API and the export — and come back intact on restore.

The issue sketched the usual design: a `deletedAt` attribute plus a filter (or a third GSI) so
listings exclude it. That design fails **open**. The product reads plants and tasks from more
than a dozen places, several of them unauthenticated token views, and every one of them would
have to remember the predicate; the one that forgot would keep showing a deleted plant — or its
photo, or its care note — to somebody. Photos make it worse: they are served publicly through
CloudFront's `/plants/*` behaviour, so no DynamoDB flag can make an already-known image URL stop
answering.

## Decision

1. **Trashing MOVES rows; it does not flag them.** The root item (`PLANT#` / `TASK#`) becomes a
   manifest at `SK = TRASH#PLANT#{id}` (or `TRASH#TASK#{id}`) in the household's base partition,
   carrying the original item verbatim. A plant's dependents — its tasks, its whole per-plant
   partition (completions, photo timeline), its plant tags and its share links — move under
   `PK = HOUSEHOLD#{id}#TRASH#PLANT#{plantId}`, each wrapped verbatim. No wrapper carries a
   top-level GSI key, so the rows leave GSI1 and GSI2 as well. Every existing read finds
   nothing without being changed: the design fails **closed**.
2. **Restore puts the original items back byte-for-byte**, index keys included. The one
   exception is safety, not convenience: a tag or share link whose issuer has since left the
   household is not revived (removal revokes them, #449), an expired share stays gone, and a
   task assigned to a departed member comes back unassigned.
3. **Photos move with the plant**, from `plants/{household}/{plant}/` to
   `trash/plants/{household}/{plant}/`, which nothing serves, and move back on restore to the
   same keys, so every stored URL resolves again unchanged.
4. **Order carries the recovery story.** Trash moves dependents first and the root last (with
   the manifest, in one transaction) — the order `deletePlant` already uses, so a failed trash
   is retried through the still-live plant. Restore moves the root first (with the plan-cap
   counter and a `restoring` mark), then images, then dependents, then deletes the manifest;
   an interrupted restore is finished by the next restore, a re-trash, or the purge job.
5. **Retention is a job, with two backstops.** A daily purge (the digests Lambda,
   `{ "job": "trashPurge" }`, sharing `scheduledFanOut`) deletes entries past 30 days through
   the #603 retry-then-throw batch writer. DynamoDB `ttl` on every trashed row and an S3
   lifecycle rule on `trash/` both fire at 37 days, only so that a stopped job cannot turn
   "30 days" into "forever".
6. **Erasure bypasses the trash.** `DELETE /me` enumerates manifests directly (never through the
   listing's "hide expired" rule) and purges them whatever their age; a member leaving a shared
   household is scrubbed from wrapped rows by the same rules `anonymizeUserInHousehold` applies
   to live ones.
7. **Scope.** Plants and tasks are trash entries. Photos enter the trash with their plant: there
   is no per-photo delete in the product to route through it. Households, members, spaces and
   API keys are out of scope, as #670 says.

## Consequences

- A trashed plant stops counting against the plan's plant cap; restoring an active one is
  adding a plant, refused at the cap with the same 402 and wording `POST /plants` uses.
- Activity events are history and stay, exactly as they did after a hard delete; the feed gains
  `plant.trashed`, and `plant.restored` carries `fromTrash`.
- Trashing and restoring cost O(rows) writes rather than one attribute update. At household
  scale (hundreds of completions for an old plant) this is a few dozen batch writes.
- An image already fetched can stay in a CloudFront edge cache for up to the images cache
  policy's TTL after it moves — the same exposure a hard delete has always had.
- Shipping it is one route group entry per route, one EventBridge rule, one IAM list prefix and
  one lifecycle rule: no new Lambda, and no entry in `cd-production.yml`'s function list.
