# Profile management

Account-level user data lives in three places:

| Field      | Source of truth               | Where it's denormalized                                           |
| ---------- | ----------------------------- | ----------------------------------------------------------------- |
| `id` (sub) | Cognito                       | nowhere                                                           |
| `email`    | Cognito                       | nowhere — read at session-verify time                             |
| `name`     | Cognito user attribute `name` | `HouseholdMember.name` rows in DDB (one per household membership) |
| `password` | Cognito                       | nowhere                                                           |

Cognito is the canonical store for identity. We denormalize `name` onto each `HouseholdMember` row so the household roster page can render member names with a single query — without that, listing members would require N Cognito lookups.

## Endpoints

### `GET /auth/me`

Returns the caller's profile from Cognito. Used by the SPA to verify a session is still good and to refresh stale local state.

### `PATCH /auth/me`

Updates editable profile fields. Today only `name` is mutable. Email changes require a verification round-trip we haven't built yet — adding email here would be a footgun.

```json
PATCH /auth/me
{ "name": "New Display Name" }
```

Returns `{ id, email, name }`.

The handler:

1. Calls `UpdateUserAttributesCommand` against Cognito with the user's access token (no admin privilege required — this is a self-service update).
2. Calls `householdService.updateMemberNameAcrossHouseholds(userId, newName)`, which queries GSI1 by `USER#{id}` to find every membership row, then updates each `name` attribute in parallel.
3. Emits an `auth.profile_updated` audit event.

If the DDB fan-out fails partway, Cognito and member rows can drift. The handler returns a 5xx in that case so the user knows to retry; resubmitting converges. We deliberately do not roll back the Cognito update — the user-visible source of truth (their next login) is correct, and partial drift is preferable to a phantom rollback.

### `POST /auth/change-password`

Unchanged. Mentioned here for completeness — `PATCH /auth/me` is for non-sensitive attributes only; password mutations stay on the dedicated endpoint with its own rate limiter.

## Historical artifacts

Past activity events (`actorName`) and task completion records (`completedByName`) snapshot the user's name at the time of the action. **They are not rewritten when the user renames themselves.** This is intentional — a completion record signed by "Alex (formerly known as Sam)" tells a less truthful story than the snapshot at the time the task was completed. This also matches the documented behavior of `DELETE /me`, which leaves historical names intact as well.

If the long-tail of user research argues we should rewrite history, the path is `householdService.updateMemberNameAcrossHouseholds` — extend it to also walk activity rows. Don't do this without an explicit user-facing "rename my history" action; silent retroactive edits to audit-style data are a trust hazard.

## Local development

`PATCH /auth/me` is mirrored in `local-server.ts` against the in-memory `db.users` map. The local mirror skips the DDB fan-out (members come straight from `db.users` in the local server, so there's no separate row to update).

Integration test coverage: `tests/integration/local-server.test.ts` — `account` describe block exercises both the success and validation paths.
