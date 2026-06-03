# Multi-household per user

A single user account can belong to many households — e.g. their primary home plus a vacation place plus a parent's house they help with. The DDB schema has supported this since day one (`HouseholdMember` rows are keyed under `HOUSEHOLD#{id}` with a GSI1 entry under `USER#{userId}`); this doc covers the application-layer wiring.

## Model

| Concept                              | Storage                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Membership (the source of truth)     | DDB row, `PK = HOUSEHOLD#{id}`, `SK = MEMBER#{userId}`, `GSI1PK = USER#{userId}` |
| Default household ("first one wins") | Cognito custom attribute `custom:household_id` + `custom:household_role`         |
| Active household for a request       | `X-Household-Id` request header                                                  |

The Cognito attribute stays on the user's first household forever — joining or creating additional households does not move it. This keeps legacy clients without the switcher working unchanged: every authenticated request without an `X-Household-Id` header lands on the user's first household.

## Switching households

The frontend's `HouseholdSwitcher` (`components/HouseholdSwitcher.tsx`) lists every membership returned by `GET /me/households`. Selecting one calls `setActiveHouseholdId(id)`, which the API client (`services/api.ts`) reads and forwards as `X-Household-Id` on every subsequent request. Switching also invalidates every cached query so React Query reissues with the new scope.

## Authorization across households

`authMiddleware` projects Cognito claims onto `event.user`, then applies the `X-Household-Id` override. Because the middleware can't do DDB calls (it runs on every request), it conservatively downgrades `householdRole` to `member` when the override is set. Admin-only routes call `requireAdmin` which then 403s on a switched household; clients are expected to refresh their role via `/me/households` if they need accurate role state on a non-default household.

The local Express server is more accurate because it has direct access to the in-memory memberships array — it sets the right role straight from the membership entry.

### Cross-household reads

Resource handlers refuse cross-household access by checking `user.householdId === <addressed household>`. Combined with the X-Header override, that means a user can only see plants/tasks/activity in the household pinned for the request. There is no global "all my plants" view by design — it would be confusing and would mix unrelated households' data on the same screen.

## Adding a household

The switcher exposes a "+ Add a household" affordance that links to `/onboarding?mode=add`. The same `HouseholdOnboarding` component handles both first-time setup and additional households; the `mode` param flips two behaviors:

1. Skip the "create vs join" choice screen (we know it's a create flow).
2. On success, set the new household as the _active_ one (via `setActiveHouseholdId`) but leave the user's default unchanged. The new household becomes the focus immediately without breaking the default-household contract.

## Deletion

`DELETE /me` walks every membership the user has. For each one:

- If the user is the lone admin in a multi-member household, refuse the entire deletion. The error tells them which household to promote a co-admin in. We don't allow partial deletion across households — it's all or nothing.
- If they're the only member, the household, plants, tasks, and completion records are wiped before the user row is removed.

Past activity events and task completion records intentionally retain the user's name as a snapshot, same as documented in `docs/profile.md`.

## Local development

The local server tracks memberships on the in-memory `User` record:

```ts
interface User {
  ...
  householdId: string | null;        // default for clients without X-Header
  householdRole: 'admin' | 'member' | null;
  memberships: Array<{ householdId: string; role: 'admin' | 'member' }>;
}
```

Tests in `tests/integration/local-server.test.ts` (`describe('multi-household per user')`) exercise the create-second-household flow, X-Header pinning, and admin-role accuracy across switched households.
