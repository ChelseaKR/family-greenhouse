# Public API (v1)

A small HTTP API over your household's plant data — for Home Assistant,
dashboards, personal scripts, and the like. It reuses the same service layer
as the app, so what you read here matches what you see in the UI.

> **Status:** key-authenticated; read endpoints plus an opt-in `write:tasks`
> scope for completing/snoozing tasks. OAuth is the remaining gate before we
> call this GA — see [Roadmap](#roadmap--limits) and
> [oauth-design.md](oauth-design.md).

## Eligibility

Issuing API keys is part of the **Greenhouse** plan. On other plans the key
endpoints return `402` with an upgrade message. Only household **admins** can
issue or revoke keys.

## Authentication

Every request carries a key, either way works:

```
Authorization: Bearer fg_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# or
X-Api-Key: fg_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys look like `fg_` + 48 hex chars. They're shown **once** at creation —
copy it then; we store only a scrypt hash and the last 4 chars, so a lost key
must be revoked and re-issued. A key is scoped to exactly one household.

> **Re-create keys issued before the scrypt migration.** The key-lookup hash
> moved from SHA-256 to scrypt. Because the plaintext is never stored, the old
> hashes cannot be recomputed, so any key created before this change stops
> authenticating and must be re-created under **Settings → API keys**.

- Missing/invalid/revoked key → `401`.
- Valid key without the scope a route needs → `403` (see [Scopes](#scopes)).

Manage keys under **Settings → API keys**.

## Scopes

Keys carry least-privilege scopes. Grant only what a key needs; a request
to an endpoint outside the key's scopes is refused with `403` naming the
missing scope.

| Scope           | Grants                                                               |
| --------------- | -------------------------------------------------------------------- |
| `read:plants`   | `GET /api/v1/plants`, `GET /api/v1/plants/{id}`                      |
| `read:tasks`    | `GET /api/v1/tasks`                                                  |
| `read:activity` | `GET /api/v1/activity`                                               |
| `write:tasks`   | `POST /api/v1/tasks/{id}/complete`, `POST /api/v1/tasks/{id}/snooze` |

`GET /api/v1/me` returns only identity (the household the key belongs to) and
needs no scope. Keys created without an explicit scope selection are granted
all **read** scopes. Keys issued before scopes existed are treated as all-read
for backward compatibility — they never gain write access implicitly.

> **Write keys are a trust decision.** A key with `write:tasks` can mutate
> your household's task schedule. Create write-scoped keys only for
> integrations you trust, give each integration its own key (so you can
> revoke one without breaking the rest), and prefer read-only keys everywhere
> else. Write access is always an explicit grant — it is never included in
> any default.

## Endpoints

Base URL: `https://<your-api-domain>/api/v1`

| Method & path               | Scope           | Returns                                                   |
| --------------------------- | --------------- | --------------------------------------------------------- |
| `GET /me`                   | —               | `{ householdId, apiVersion }`                             |
| `GET /plants`               | `read:plants`   | Array of plants                                           |
| `GET /plants/{id}`          | `read:plants`   | One plant, or `404`                                       |
| `GET /tasks`                | `read:tasks`    | Array of tasks (with `plantName`)                         |
| `GET /activity?limit=N`     | `read:activity` | Recent activity, newest first (`limit` 1–200, default 50) |
| `POST /tasks/{id}/complete` | `write:tasks`   | The completed task (schedule advanced), or `404`          |
| `POST /tasks/{id}/snooze`   | `write:tasks`   | The snoozed task (nextDue pushed out), or `404`           |

### Write endpoints

`POST /tasks/{id}/complete` — body optional: `{ "notes": "…" }` (≤500 chars).
Marks the task done now and advances `nextDue` by the task's frequency,
exactly like completing it in the app.

`POST /tasks/{id}/snooze` — body optional: `{ "days": N }` (1–365). When
`days` is omitted, the snooze defaults to the task's own frequency — i.e.
"skip one cycle", the same semantics as the app's skip suggestions. The new
due date is based on `max(now, current nextDue)` so an overdue task always
lands in the future.

**Attribution:** API keys act as the household, not as a person. Mutations
made with a key are recorded with the actor id `apikey:{keyId}` and the key's
label as the display name, so the activity feed shows which integration acted
(e.g. "Home Assistant completed Watering"). Both write endpoints are also
audit-logged server-side with the key id.

### Example

```bash
curl -H "Authorization: Bearer $FG_KEY" https://api.example.com/api/v1/plants

# Complete a task from an automation (requires write:tasks):
curl -X POST -H "Authorization: Bearer $FG_KEY" \
  -H "Content-Type: application/json" \
  -d '{"notes":"auto-watered by irrigation controller"}' \
  https://api.example.com/api/v1/tasks/TASK_ID/complete
```

## Rate limits

Two layers, both per minute:

- **Per IP:** 120 requests/min (outer envelope, before key auth).
- **Per key, per route:** 60 requests/min.

Over the limit → `429`. Limits are generous for dashboards and automations;
contact us if you have a legitimate higher-volume use case.

## Versioning

The `/api/v1` prefix is the contract. Backwards-compatible additions (new
fields, new endpoints) land in `v1`; anything breaking goes behind `/api/v2`.

## Roadmap / limits

- **Writes are task-only today.** `write:tasks` covers complete/snooze; no
  create/delete surface yet, and no write access to plants or households.
- **OAuth** for third-party apps acting on a user's behalf is the gate before
  GA; API keys cover first-party scripts in the meantime. Design:
  [oauth-design.md](oauth-design.md).
- **No webhooks yet.** Poll `GET /activity` for changes.

See [`roadmap.md`](roadmap.md) (Y2Q4) for where this sits.
