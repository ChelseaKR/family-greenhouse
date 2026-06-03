# Public API (v1)

A small, read-only HTTP API over your household's plant data — for Home
Assistant, dashboards, personal scripts, and the like. It reuses the same
service layer as the app, so what you read here matches what you see in the UI.

> **Status:** read-only and key-authenticated. Write access and OAuth are the
> remaining gates before we call this GA — see [Roadmap](#roadmap--limits).

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
copy it then; we store only a SHA-256 hash and the last 4 chars, so a lost key
must be revoked and re-issued. A key is scoped to exactly one household.

- Missing/invalid/revoked key → `401`.
- Valid key without the scope a route needs → `403` (see [Scopes](#scopes)).

Manage keys under **Settings → API keys**.

## Scopes

Keys carry least-privilege read scopes. Grant only what a key needs; a request
to an endpoint outside the key's scopes is refused with `403` naming the
missing scope.

| Scope           | Grants                                          |
| --------------- | ----------------------------------------------- |
| `read:plants`   | `GET /api/v1/plants`, `GET /api/v1/plants/{id}` |
| `read:tasks`    | `GET /api/v1/tasks`                             |
| `read:activity` | `GET /api/v1/activity`                          |

`GET /api/v1/me` returns only identity (the household the key belongs to) and
needs no scope. Keys created without an explicit scope selection are granted
all read scopes. Keys issued before scopes existed are treated as all-read for
backward compatibility.

## Endpoints

Base URL: `https://<your-api-domain>/api/v1`

| Method & path           | Scope           | Returns                                                   |
| ----------------------- | --------------- | --------------------------------------------------------- |
| `GET /me`               | —               | `{ householdId, apiVersion }`                             |
| `GET /plants`           | `read:plants`   | Array of plants                                           |
| `GET /plants/{id}`      | `read:plants`   | One plant, or `404`                                       |
| `GET /tasks`            | `read:tasks`    | Array of tasks (with `plantName`)                         |
| `GET /activity?limit=N` | `read:activity` | Recent activity, newest first (`limit` 1–200, default 50) |

### Example

```bash
curl -H "Authorization: Bearer $FG_KEY" https://api.example.com/api/v1/plants
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

- **Read-only today.** No write endpoints — by design until the auth story
  below lands.
- **OAuth** for third-party apps acting on a user's behalf is the gate before
  GA; API keys cover first-party scripts in the meantime.
- **No webhooks yet.** Poll `GET /activity` for changes.

See [`roadmap.md`](roadmap.md) (Y2Q4) for where this sits.
