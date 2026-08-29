# Branch ruleset artifacts

`main.json` is the committed, reviewable copy of the **live** GitHub branch
ruleset `protect-main` (id 18752847), per `STANDARDS/CI-CD-STANDARD.md` §5
("committed as a per-repo artifact so the posture is reviewable in-tree").
Plain JSON — comments aren't valid JSON, so the context lives here instead.

**Provenance:** fetched read-only on 2026-07-10 via the GitHub API, with
`bypass_actors` deliberately diverged from the fetched value on 2026-08-29 (see
"Bypass actors" below). This is the repo's only ruleset; the earlier permissive
ruleset ("main: PRs + green gates", id 17592136,
`required_approving_review_count: 0`) was deleted on 2026-07-09 and its stale
snapshot at `docs/branch-ruleset.json` is removed.

**Regenerate whenever the ruleset changes:**

```sh
gh api repos/ChelseaKR/family-greenhouse/rulesets/18752847 \
  | jq 'del(._links, .current_user_can_bypass)' \
  > .github/rulesets/main.json
```

(`_links` is API hypermedia noise; `current_user_can_bypass` depends on who
fetched. Everything else is committed verbatim.) Regenerating does **not**
excuse re-checking `bypass_actors`: GitHub omits that key entirely for callers
without ruleset write access, so a regeneration run with a read-only token
would drop the owner's bypass from this file without saying so. The guard below
fails on the absent key for exactly that reason.

## Bypass actors: the repository owner, and nobody else

This file carries exactly one bypass actor:

```json
{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
```

`RepositoryRole` 5 is the repository **admin** role — the owner. `bypass_mode`
is `always`, not `pull_request`.

**This reverses what this README said until 2026-08-29.** The previous posture
reading listed "**No bypass actors** (`bypass_actors: []`) — no admin bypass on
`main`" as a hardening win. It was not one. It is a lockout, and the reasoning
is reversed here deliberately rather than quietly deleted, so the next reader
can see which way it went and why:

- An empty bypass list is not a stricter gate on the same rules. It is the
  removal of the only break-glass path. Every rule in this file — required
  status checks, `non_fast_forward`, `deletion` — then applies to the owner
  with no exception, including the rule that would let her repair the
  situation. She cannot merge past a required check that can never report
  (a runner that cannot be allocated, a retired check name that is still in
  the required list), cannot push a fix directly, and cannot delete the
  ruleset that is blocking her, because deleting a ruleset is itself gated.
- Nothing in this repository applies this file, but the file is a complete,
  valid ruleset document: anyone — a person, or an agent following the
  repository's own instructions — can post it with
  `gh api -X POST repos/ChelseaKR/family-greenhouse/rulesets --input .github/rulesets/main.json`.
  GitHub answers **201** for a ruleset with no bypass actors exactly as it does
  for a correct one. Nothing warns you. That apply is what locked the owner out
  of eighteen repositories in this portfolio; restoring access took a sweep
  across all of them.
- `always` rather than `pull_request` because a bypass that only works inside a
  pull request is no use when the thing that is wedged **is** the pull request.
  `pull_requests_only` is exactly the state the live ruleset is in today (see
  below), and it is why the owner currently has no break-glass path at all when
  a required check cannot report.

The bypass stays a break-glass path, not a second merge policy: the CICD-15
procedure (run every local equivalent first, record the blocked check and the
explicit authorization in the PR, merge through the PR so the timeline is the
audit trail, never disable or delete the ruleset to force a merge) still
governs when it may be used. What changed is that the path exists at all.

### Deliberate divergence from the vendored standard (CICD-15, §5.1)

`docs/standards/CI-CD-STANDARD.md` is vendored upstream content, synced
verbatim from `ChelseaKR/portfolio-standards` and not edited here. On this one
point this repository **knowingly diverges from it**:

| Vendored standard                                                                                                                           | This repo                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| CICD-15: emergency bypass is "one designated maintainer, **PR-only** (`bypass_mode: pull_request`)"                                         | `bypass_mode: always` for the admin role                                                     |
| §5 example ruleset hardcodes `{ "actor_id": 3114598, "actor_type": "User", "bypass_mode": "pull_request" }`                                 | `RepositoryRole` 5, so the bypass follows the role, not a user id that dies with the account |
| §5.1 solo-maintainer profile requires "empty bypass actors", and its `solo-governance` validator fails on "a visible non-empty bypass list" | a visible, single-entry bypass list is required here, and an empty one is a test failure     |

A strict reading of the vendored standard therefore calls the correct fix a
violation. The divergence is recorded rather than resolved because the standard
is upstream-owned; the case for changing it upstream is the one above — a
PR-only bypass is not a break-glass path, and an empty list is a lockout the
platform reports as success. Until upstream moves, the `solo-governance`
validator's empty-bypass expectation is a **known, deliberate non-conformance**
for this repository, and the README "Standards conformance" CI/CD row says so.

## Live versus committed: they disagree today

Fetched read-only on 2026-08-29:

```console
$ gh api repos/ChelseaKR/family-greenhouse/rulesets/18752847 | jq '{name, enforcement, updated_at, bypass_actors, current_user_can_bypass}'
{
  "name": "protect-main",
  "enforcement": "active",
  "updated_at": "2026-07-19T22:28:45.905-07:00",
  "bypass_actors": [
    {
      "actor_id": 3114598,
      "actor_type": "User",
      "bypass_mode": "pull_request"
    }
  ],
  "current_user_can_bypass": "pull_requests_only"
}
```

So the live ruleset names the owner as a **user** (3114598 is `ChelseaKR`) with
a **PR-only** bypass, while this file names the **admin role** with an `always`
bypass. That is a real, currently-open divergence, stated here rather than
papered over: as of today, if a pull request wedges, the owner has no
break-glass path outside a pull request.

**Reconciling it is an owner action and was not performed by this change.** It
needs ruleset write access, which PR-time CI is never given. The exact,
minimal command — it sends only `bypass_actors`, taken from this committed
file, and leaves every other live field untouched:

```sh
jq '{ bypass_actors }' .github/rulesets/main.json \
  | gh api -X PUT repos/ChelseaKR/family-greenhouse/rulesets/18752847 --input -
```

Then verify, and expect `"always"`:

```sh
gh api repos/ChelseaKR/family-greenhouse/rulesets/18752847 \
  | jq '{ bypass_actors, current_user_can_bypass }'
```

That `PUT` changes the live `updated_at`, so regenerate this file afterwards
with the command at the top and commit the new `id`/`updated_at` — the rest of
the document should come back byte-identical.

## The guard

`backend/tests/unit/config/branchRuleset.test.ts` fails the required
`Test Backend` check if this file loses the owner's bypass. It is a pure
`lockoutRisk(document)` over the parsed JSON, run against the five losing
shapes (empty list, absent key, wrong type, wrong actor, `pull_request` mode on
the right actor) plus a positive control, and its loader fails on a missing or
unparseable file rather than passing when its subject is absent. The parse is
load-bearing: a truncated `main.json` still contains the literal string
`bypass_actors`, so a grep would wave it through. `make verify` runs it locally
and in pre-push; CI runs it in `Test Backend`.

## Honest reading of the current posture

- **Required status checks (13):** Lint, Type Check, Test Frontend, Test
  Backend, Security Scan, SAST (Semgrep), Terraform Validate, Build, E2E +
  accessibility (Playwright), Lighthouse (mobile + desktop) (desktop) and
  (mobile), Bundle size, CodeQL analysis (javascript-typescript, actions).
  Lighthouse is now required (it was the gap called out in
  `docs/cicd-setup.md` against the old ruleset).
- **One bypass actor:** the repository admin role, `bypass_mode: always` — the
  owner's break-glass path, deliberately not empty and deliberately not
  PR-only. See above; the live ruleset does not match this yet.
- **Force-push and branch deletion blocked** (`non_fast_forward`, `deletion`).
  The bypass does not weaken these as a merge policy; it makes them repairable
  by the owner.
- **`strict_required_status_checks_policy: false`** — a PR can merge without
  being up to date with `main` first. Known deviation from the standard.
- **No `pull_request` rule** — no required approving reviews. Deliberate for
  a solo-maintainer repo (GitHub won't count self-approval); see the
  solo-maintainer caveat in `DEFINITION_OF_DONE.md`. Revisit when a second
  maintainer joins.
- `zizmor` and Scorecard run as workflows but are not required checks
  (path-filtered / main-branch-scheduled respectively — see
  `DEFINITION_OF_DONE.md`).

Last verified: 2026-08-29 (live fetch, read-only) · Recheck cadence: regenerate
and re-review on any ruleset change (GitHub audit log will show edits); verify
at least quarterly that `main.json` still matches the live ruleset, and that
the `bypass_actors` divergence above is either reconciled or still recorded.
