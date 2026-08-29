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

> **Do not run that command blind (2026-08-28).** `bypass_actors` is the one
> field where this file is deliberately _not_ a mirror of live right now: the
> file records the intended state and the live ruleset is missing it. A blind
> regeneration would overwrite the intent with the defect and leave no trace
> that anything was wrong. Read "The owner's bypass" below first; once the live
> ruleset is repaired, the two agree again and the command is safe.

## Honest reading of the current posture

- **Required status checks (13):** Lint, Type Check, Test Frontend, Test
  Backend, Security Scan, SAST (Semgrep), Terraform Validate, Build, E2E +
  accessibility (Playwright), Lighthouse (mobile + desktop) (desktop) and
  (mobile), Bundle size, CodeQL analysis (javascript-typescript, actions).
  Lighthouse is now required (it was the gap called out in
  `docs/cicd-setup.md` against the old ruleset).
- **One bypass actor: the repository owner** (`RepositoryRole` 5,
  `bypass_mode: always`) — recorded here as the intended state. **The live
  ruleset does not currently have it.** See "The owner's bypass" below; this is
  the one line on this page that describes intent rather than what is enforced.
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

## The owner's bypass, and the live gap

`main.json` records **one bypass actor: the repository owner** (`RepositoryRole`
5, `bypass_mode: always`). That is deliberate and permanent, and this file used
to say `[]`.

**An agent once applied a ruleset with no bypass and locked the owner out of her
own repository**, and restoring access took a sweep across eighteen repositories
in this portfolio. The standing instruction since is that the owner must always
be able to bypass, in any repository. An empty `bypass_actors` list is not a
stricter gate; it is the lockout.

**The live ruleset is currently missing that bypass.** Read 2026-08-28,
`gh api repos/ChelseaKR/family-greenhouse/rulesets/18752847`:

```json
"bypass_actors": [
  {"actor_id": 3114598, "actor_type": "User", "bypass_mode": "pull_request"}
]
```

`current_user_can_bypass` reads `"pull_requests_only"`. Actor 3114598 is the
owner's own user account, but `pull_request` mode does **not** cover a direct
push, so if one of the thirteen required checks wedges there is no way through
it. That gap is a repository-settings change and is deliberately left for the
owner to make — an agent changing a live ruleset is how the original lockout
happened.

This is why the file and the live ruleset disagree on this one field, and why
the regenerate command above carries a warning: the disagreement is the finding,
and regenerating would erase it.

Last verified: 2026-07-10 · Recheck cadence: regenerate and re-review on any
ruleset change (GitHub audit log will show edits); verify at least quarterly
that `main.json` still matches the live ruleset.
