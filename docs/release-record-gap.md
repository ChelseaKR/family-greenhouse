# Release record gap — measured 2026-09-06

**This is a dated measurement, not a live claim.** The live figures come from
`node scripts/check-release-record.mjs --releases <releases.json> --print`, and
`.github/workflows/release-record.yml` prints them to its job summary weekly.
Nothing regenerates the table below; it is the record of what was true on the
day it was taken.

## The question

A `v*` tag in this repository is a production deployment. `cd-production.yml`
triggers on `push: tags: ['v*']`, and this app takes real card payments, so a
tag is not a bookmark — it is money moving through code that just changed.

There were **46 tags and 8 GitHub Releases**. The question was whether that gap
is a policy (tags deploy; releases are curated for notable versions) or drift.

## The answer: drift

Four things say so, and none of them is an opinion.

1. **The repo's own standard requires a release per release.**
   `docs/standards/RELEASE-AND-VERSIONING-STANDARD.md` §4 step 7 lists "GitHub
   Release — attach SBOM + provenance + CHANGELOG section as release notes" as
   a step of the release pipeline, and §6 makes the attachments a REVIEW-GATE on
   completeness. §1 says "There is no silent default": a repo with no release
   pipeline and no `N/A (reason)` declaration fails review. No declaration of a
   curated-release policy exists anywhere in this repository.

2. **The practice was universal, then lapsed.** Every one of the first six tags
   (`v0.2.0` through `v0.7.0`, 2026-06-11 to 2026-06-17) has a release. Nothing
   after `v0.7.0` does except `v0.16.2` and `v0.20.0`. A curation policy would
   look like a rule applied throughout. This looks like a habit that stopped.

3. **The procedure ends at the tag.** `docs/deployment.md`'s "Promotion" section
   said, in full: `git tag v1.2.3` / `git push origin v1.2.3`. It never
   mentioned a release. Nothing automates one either — no workflow in
   `.github/workflows/` creates a GitHub Release.

4. **The notes already exist.** `cd-production.yml`'s REL-10 step refuses to
   deploy a tag whose version has no `## [X.Y.Z]` section in `CHANGELOG.md`, so
   every one of the 38 unrecorded tags has written, human-curated release notes
   sitting in the changelog. Only the release object is missing. That is the
   shape of a skipped step, not of a decision about what deserves a record.

## What that cost

Thirty-two tags reached a **successful** production deploy and left no release.
For those, the only public record that the deploy happened is a
`cd-production.yml` workflow run, which ages out of the Actions UI and carries
no SBOM, no provenance attestation and no notes. A user, an auditor, or the
owner in six months cannot answer "what shipped on 2026-07-16?" from the
repository.

**The inverse defect is here too, and it is worse.** `v0.3.0` has a GitHub
Release. Both of its `cd-production.yml` runs failed, and no later run for that
tag succeeded. The only public record says v0.3.0 shipped; the deploy history
says it did not. Counting releases would have missed this entirely, which is why
the table below carries the deploy outcome next to the record.

## The gap, tag by tag

Deploy outcome is the best conclusion across every `push`-triggered
`cd-production.yml` run for that tag. `failed` means no run for that tag ever
concluded `success` — it does not necessarily mean nothing reached production,
because a run can fail after a partial apply and the workflow's auto-rollback
then restores the previous state.

| Tag     | Tagged     | Deploy              | Release                           |
| ------- | ---------- | ------------------- | --------------------------------- |
| v0.2.0  | 2026-06-11 | success             | yes                               |
| v0.3.0  | 2026-06-12 | **failed (2 runs)** | **yes — record without a deploy** |
| v0.4.0  | 2026-06-16 | success             | yes                               |
| v0.5.0  | 2026-06-17 | success             | yes                               |
| v0.6.0  | 2026-06-17 | success             | yes                               |
| v0.7.0  | 2026-06-17 | success             | yes                               |
| v0.8.0  | 2026-06-21 | success             | **no**                            |
| v0.9.0  | 2026-06-21 | success             | **no**                            |
| v0.10.0 | 2026-06-21 | success             | **no**                            |
| v0.11.0 | 2026-06-21 | success             | **no**                            |
| v0.11.1 | 2026-06-21 | success             | **no**                            |
| v0.12.0 | 2026-07-04 | success             | **no**                            |
| v0.12.1 | 2026-07-04 | success             | **no**                            |
| v0.12.2 | 2026-07-04 | success             | **no**                            |
| v0.12.3 | 2026-07-05 | success             | **no**                            |
| v0.13.0 | 2026-07-05 | success             | **no**                            |
| v0.13.1 | 2026-07-05 | success             | **no**                            |
| v0.14.0 | 2026-07-10 | success             | **no**                            |
| v0.14.1 | 2026-07-10 | success             | **no**                            |
| v0.14.2 | 2026-07-10 | success             | **no**                            |
| v0.15.0 | 2026-07-11 | success             | **no**                            |
| v0.15.1 | 2026-07-11 | success             | **no**                            |
| v0.15.2 | 2026-07-11 | success             | **no**                            |
| v0.15.3 | 2026-07-11 | failed              | no                                |
| v0.15.4 | 2026-07-11 | success             | **no**                            |
| v0.16.0 | 2026-07-12 | failed              | no                                |
| v0.16.1 | 2026-07-12 | success             | **no**                            |
| v0.16.2 | 2026-07-12 | success             | yes                               |
| v0.17.0 | 2026-07-16 | success             | **no**                            |
| v0.18.0 | 2026-07-16 | success             | **no**                            |
| v0.19.0 | 2026-07-16 | success             | **no**                            |
| v0.20.0 | 2026-07-16 | success             | yes                               |
| v0.21.0 | 2026-07-16 | failed              | no                                |
| v0.22.0 | 2026-07-19 | failed              | no                                |
| v0.23.0 | 2026-07-26 | success             | **no**                            |
| v0.23.1 | 2026-08-09 | success             | **no**                            |
| v0.23.2 | 2026-09-02 | success             | **no**                            |
| v0.23.3 | 2026-09-02 | success             | **no**                            |
| v0.23.4 | 2026-09-02 | success             | **no**                            |
| v0.23.5 | 2026-09-02 | success             | **no**                            |
| v0.24.0 | 2026-09-04 | failed              | no                                |
| v0.25.0 | 2026-09-04 | failed              | no                                |
| v0.26.0 | 2026-09-04 | success             | **no**                            |
| v0.27.0 | 2026-09-04 | success             | **no**                            |
| v0.28.0 | 2026-09-04 | success             | **no**                            |
| v0.29.0 | 2026-09-05 | success             | **no**                            |

Totals on the day of measurement: 46 tags, 39 with a successful deploy, 8 with a
release, 38 without one, and 32 that both deployed successfully and have no
release.

## How it was measured

```bash
git for-each-ref --format='%(refname:short)' refs/tags
gh api repos/ChelseaKR/family-greenhouse/releases --paginate --jq '.[].tag_name'
gh api "repos/ChelseaKR/family-greenhouse/actions/workflows/cd-production.yml/runs?per_page=100" \
  --paginate --jq '.workflow_runs[] | [.head_branch, .event, .conclusion] | @tsv'
```

The run history goes back to `v0.2.0`, so no tag's deploy outcome had to be
inferred.

## What holds it from here

`.github/release-record-baseline.txt` lists the 38 tags that have no release, and
`.github/workflows/release-record.yml` runs `scripts/check-release-record.mjs`
weekly, on every `v*` tag push, and on demand. A tag that is not in the baseline
and has no release after seven days fails that workflow. The check also fails if
the baseline names a tag that does not exist, so the register cannot decay into
scaffolding, and it carries a negative control that empties the baseline and
requires the check to fail — the same discipline as `uptime.yml`.

Deliberately **not** a merge gate. It asks a question about tags and releases
that a pull request cannot answer, and a red scheduled run must never be able to
jam the PR queue.

The check cannot close the gap. It only stops it growing.

## A second gap in the same namespace: nothing protects the tags

Found while measuring the above, and reported rather than fixed.

There is no tag ruleset on this repository. `.github/rulesets/` holds only
`main.json`, and the live ruleset list is one entry, `protect-main`, whose rules
are `non_fast_forward`, `deletion` and `required_status_checks` — all scoped to
the branch, none to tags.

`RELEASE-AND-VERSIONING-STANDARD.md` §3.1 requires the opposite:

> A committed repository-owned `.github/rulesets/tags.json` named
> `protect-release-tags` targets exactly `refs/tags/v*`, restricts **all
> updates** and deletions, and has no bypass actors. `non_fast_forward` alone is
> insufficient because it can still permit a fast-forward tag move.

So today a `v*` tag can be moved or deleted, and because `cd-production.yml`
triggers on `push: tags: ['v*']`, moving one is a production deploy of whatever
it now points at.

**This is not a change to make without the owner, for a reason beyond the usual
one.** The standard's text says the ruleset must have _no bypass actors_. The
owner's standing instruction across this portfolio is that she must always be
able to bypass, in any repository — an empty bypass list has locked her out
before, and restoring access took a sweep across eighteen repositories. Those
two requirements contradict, and the contradiction has to be settled by her, not
worked around here. `gtfs-scorecard` shows what following the text produces: its
`.github/rulesets/tags.json` carries `"bypass_actors": []` and the live ruleset
confirms it, so nobody — including her — can move or delete a mistagged release
there.

Deciding this needs one answer to one question: does `protect-release-tags` get
the repository-admin bypass
(`{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}`),
with §3.1's "no bypass actors" amended to say so, or does the standard's text
win? Nothing should be applied to either repository until that is settled.

## What the owner has to decide

1. **Backfill or declare.** Either publish releases for the 32 tags that
   deployed successfully with no record — the CHANGELOG sections are already
   written, so this is `gh release create <tag> --notes-file <section>` per tag —
   or write the curated-release policy down as the §1 declaration the standard
   requires and cut the baseline to match it. Publishing a release was
   deliberately left undone here: choosing what the public record of a paid
   product says is not an automatable call.

2. **`v0.3.0`.** Its release says it shipped and its deploys failed. Either
   correct the release notes to say what actually reached production, or delete
   the release. This is the only record in the repository that is affirmatively
   wrong rather than missing.

3. **The six failed tags.** `v0.15.3`, `v0.16.0`, `v0.21.0`, `v0.22.0`,
   `v0.24.0` and `v0.25.0` have no successful deploy and no release. If the
   intent is that a failed deploy leaves no record, that is defensible and
   should be written down; the baseline currently accounts for them alongside
   the successful ones, which understates the distinction.
