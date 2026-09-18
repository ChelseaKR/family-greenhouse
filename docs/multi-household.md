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

`authMiddleware` projects the Cognito JWT's identity (`sub`, `email`) onto `event.user`, then resolves the household context — whichever comes from the `X-Household-Id` override header or, absent that, the `custom:household_id` claim. **The membership row is authoritative for BOTH membership and role.** For the resolved household, the middleware reads the caller's `MEMBER#{userId}` row and sets `user.householdRole` to the role stored there — `admin` or `member`. It does **not** downgrade to `member`, and it never trusts the `custom:household_role` claim (that claim is defense-in-depth only and lags membership changes by up to the token lifetime).

So an admin keeps admin on a switched household, and a member who was removed loses access — both correctly — within the cache TTL (below). `requireAdmin` therefore reflects the caller's real role on the addressed household with no client-side `/me/households` refresh needed.

The lookup goes through a small per-warm-container cache (`utils/membershipCache.ts`, 60s TTL). Mutations that change membership (`setMemberRole`, `removeMember`) invalidate the cache synchronously in the container that processed them; other warm containers honor the change within ≤60s. A non-member who sets `X-Household-Id` to a household they don't belong to gets a 403 ("Not a member of the requested household").

The local Express server mirrors this by reading the role straight from its in-memory memberships array.

### Cross-household reads

Resource handlers refuse cross-household access by checking `user.householdId === <addressed household>`. Combined with the X-Header override, that means a user can only see plants/tasks/activity in the household pinned for the request. There is no global "all my plants" view by design — it would be confusing and would mix unrelated households' data on the same screen.

The one cross-household read is `GET /me/today`, and it is a work queue, not that view ([ADR 0017](adr/0017-cross-home-today-is-a-work-queue-not-a-global-view.md)). For every membership it runs the same due/overdue task query the dashboard runs, with that household's role from its membership row, and returns the result **grouped by household with the household name on every row** — never merged. A household whose read fails is returned as an explicit `status: 'unavailable'` entry rather than dropped. The read is not pinned to a household (`X-Household-Id` is irrelevant to it); acting on a row goes back through the ordinary single-household task routes with an explicit `X-Household-Id` for that row's home, so the refusal above is untouched. It is a Greenhouse feature (`crossHomeToday` in `models/plans.ts`), gated per user across every household they belong to.

## How many households a user may belong to

Belonging to several households is a PAID capability as of ADR 0014: the plan
catalog's `limits.homes` is one on Seedling and Garden and unlimited on
Greenhouse, and `services/homesGate.ts` enforces it on the two routes that
grow the set — `POST /households` and `POST /households/join/:inviteCode`.

Because plans belong to households and people belong to several, the cap is
resolved against the **strongest plan the user would hold after the action**:
every household they are already in, plus the one being joined. Two
consequences are deliberate.

- A Greenhouse household never turns a hand away. Joining one always passes,
  whatever the joiner already belongs to — "many homes, many hands" is the
  tier's whole story, and it would be self-defeating to refuse the helper.
- A Greenhouse member may help at any number of homes, because one of the
  homes they hold has no ceiling.

**The cap limits new growth only.** The gate answers "may one more be added?",
so a user who already belongs to five households keeps all five, reads and
acts in every one of them, and is told no only on the sixth. Nothing here
removes, hides, or downgrades an existing membership; the same rule the plant
and member caps follow.

## Adding a household

The switcher exposes a "+ Add a household" affordance that links to `/onboarding?mode=add`. The same `HouseholdOnboarding` component handles both first-time setup and additional households; the `mode` param flips two behaviors:

1. Skip the "create vs join" choice screen (we know it's a create flow).
2. On success, set the new household as the _active_ one (via `setActiveHouseholdId`) but leave the user's default unchanged. The new household becomes the focus immediately without breaking the default-household contract.

## Leaving a household

`POST /households/{id}/leave` (#686) lets a member leave ONE household and keep
their account and every other household. It is admin removal seen from the
other side, so both run the same departure sequence
(`services/householdDeparture.ts`): the membership row goes under the
TOCTOU-safe last-admin guard, the credentials the leaver minted are revoked
(#449), then `accountCleanup.anonymizeUserInHousehold` clears their live
references and rewrites their history to "Former member", and finally the
Cognito default moves only if this was it.

Leaving is **instant** — like removal and `DELETE /me` — behind its own confirm
dialog on the Household page. There is no grace window an admin can see: the
point of the route is leaving without having to ask the admin.

Every dangling reference has a stated outcome:

| Reference                                     | Outcome                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Tasks assigned to or claimed by the leaver    | unassigned — up for grabs; the count is returned, put in the feed row and in the admins' email         |
| `SpaceRotation.memberIds`                     | the leaver is removed, anchor kept; a rotation left with fewer than two people is cleared              |
| A space's `defaultCaregiverId`                | cleared                                                                                                |
| Vacation windows naming the leaver            | deleted (as away member or as cover)                                                                   |
| Open "ask family" requests they raised        | stay open (the task is already up for grabs); the asker reads as Former member                         |
| Sitter links, kiosk links, plant tags, shares | revoked                                                                                                |
| Their calendar-feed token for the household   | deleted                                                                                                |
| Pending household emails about the household  | dropped from their queue                                                                               |
| Notification preferences, phone verification  | untouched — both belong to the account (`USER#` partition), not to a household                         |
| The Cognito default claim                     | unchanged for a secondary household; re-pointed at a remaining membership, or cleared when none remain |

A token issued before the leave still carries the old `custom:household_id`
until it refreshes. With no `X-Household-Id`, `authMiddleware` finds no
membership row and degrades to "no active household" — `GET /me/households`
still answers, and household routes get a coherent 403 ("User must belong to a
household"), never a 500. The client refreshes its token and switches to the
remaining default (or onboarding) straight after leaving.

Three states are refused with a coded 409 (`details.code`) and nothing changed:

- `LAST_MEMBER` — the only member. A leave never ends or deletes a household;
  invite and promote someone first, or delete the account (below), which is
  the existing path for abandoning a household.
- `LAST_ADMIN` — the only admin of a household with other members.
- `BILLING_ACK_REQUIRED` — an **admin** leaving a household whose Stripe
  subscription will renew (`active`/`trialing`/`past_due`/`unpaid`, not set to
  cancel at period end), until they send `acknowledgeBilling: true`. Leaving
  never touches billing — subscriptions belong to households — but the card on
  file may be theirs, and once gone they cannot reach this household's billing.
  Plain members are never asked: billing is admin-only.

## Deletion

`DELETE /me` walks every membership the user has. For each one:

- If the user is the lone admin in a multi-member household, refuse the entire deletion. The error tells them which household to promote a co-admin in. We don't allow partial deletion across households — it's all or nothing.
- If they're the only member, the household, plants, tasks, and completion records are wiped before the user row is removed.
- If they're the only member and the household has a Stripe subscription, it is cancelled immediately — before anything is deleted. Subscriptions are per household, so leaving a household that keeps other members never touches billing; but an abandoned household is erased together with the only login that could reach the billing portal, so its subscription has to go first. If Stripe can't confirm the subscription is dead, the deletion is refused with a 502 and nothing has been touched; retrying is safe (an already-cancelled or missing subscription counts as done).

A rename never rewrites past activity events or task completion records: the
name on them is a snapshot, as documented in `docs/profile.md`. Account
deletion is the exception, and it does rewrite them —
`accountCleanup.anonymizeUserInHousehold` replaces the departing user's
`actorId` / `completedBy` with `deleted-user` and their `actorName` /
`completedByName` with "Former member" on every event and completion they
authored. That is what the privacy policy and `docs/support.md` describe, and
it is why a household keeps the history without keeping the person.

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
