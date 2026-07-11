# Branch ruleset artifacts

`main.json` is the committed, reviewable copy of the **live** GitHub branch
ruleset `protect-main` (id 18752847), per `STANDARDS/CI-CD-STANDARD.md` §5
("committed as a per-repo artifact so the posture is reviewable in-tree").
Plain JSON — comments aren't valid JSON, so the context lives here instead.

**Provenance:** fetched read-only on 2026-07-10 via the GitHub API. This is
the repo's only ruleset; the earlier permissive ruleset ("main: PRs + green
gates", id 17592136, `required_approving_review_count: 0`) was deleted on
2026-07-09 and its stale snapshot at `docs/branch-ruleset.json` is removed.

**Regenerate whenever the ruleset changes:**

```sh
gh api repos/ChelseaKR/family-greenhouse/rulesets/18752847 \
  | jq 'del(._links, .current_user_can_bypass)' \
  > .github/rulesets/main.json
```

(`_links` is API hypermedia noise; `current_user_can_bypass` depends on who
fetched. Everything else is committed verbatim.)

## Honest reading of the current posture

- **Required status checks (13):** Lint, Type Check, Test Frontend, Test
  Backend, Security Scan, SAST (Semgrep), Terraform Validate, Build, E2E +
  accessibility (Playwright), Lighthouse (mobile + desktop) (desktop) and
  (mobile), Bundle size, CodeQL analysis (javascript-typescript, actions).
  Lighthouse is now required (it was the gap called out in
  `docs/cicd-setup.md` against the old ruleset).
- **No bypass actors** (`bypass_actors: []`) — no admin bypass on `main`.
- **Force-push and branch deletion blocked** (`non_fast_forward`, `deletion`).
- **`strict_required_status_checks_policy: false`** — a PR can merge without
  being up to date with `main` first. Known deviation from the standard.
- **No `pull_request` rule** — no required approving reviews. Deliberate for
  a solo-maintainer repo (GitHub won't count self-approval); see the
  solo-maintainer caveat in `DEFINITION_OF_DONE.md`. Revisit when a second
  maintainer joins.
- `zizmor` and Scorecard run as workflows but are not required checks
  (path-filtered / main-branch-scheduled respectively — see
  `DEFINITION_OF_DONE.md`).

Last verified: 2026-07-10 · Recheck cadence: regenerate and re-review on any
ruleset change (GitHub audit log will show edits); verify at least quarterly
that `main.json` still matches the live ruleset.
