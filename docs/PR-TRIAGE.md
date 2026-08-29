# Pull request triage — 2026-08-28

Triage of the eight open pull requests against `main` at `5655398`. Every claim
below was checked against the repository or the GitHub API; the closing section
separates what was verified from what was taken on trust.

No pull request was merged, closed, commented on, labelled, re-run, or edited
to produce this document. The only write is the branch that carries this file.

## Group counts

**8 open PRs.** `#361, #360, #358, #357, #356, #355, #354, #353`.

| Grouping                  | Count | PRs                                |
| ------------------------- | ----- | ---------------------------------- |
| Dependabot                | 6     | #360, #357, #356, #355, #354, #353 |
| Human-authored            | 2     | #361, #358                         |
| `CLEAN`                   | 5     | #360, #358, #357, #356, #353       |
| `BLOCKED`                 | 2     | #355, #354                         |
| `DIRTY`                   | 1     | #361                               |
| All required checks green | 5     | #360, #358, #357, #356, #353       |
| Red on a required check   | 2     | #355, #354                         |
| No CI verdict at all      | 1     | #361                               |

**`main` is green.** `npm run verify` exits 0 on a clean `origin/main` worktree
(format:check, lint, typecheck, both coverage floors, i18n, reads, observability,
`npm audit`, bare markers, silenced gates, docs-testing). Backend 1,492 cases
across 99 files; frontend 759 across 112. CI run `33128190894` on `5655398` also
concluded `success`. Nothing in this queue is red because `main` is red.

## Per-PR table

| PR   | Base   | Real merge state                                                                    | CI classification                                                                                | Recommendation                                         |
| ---- | ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| #361 | `main` | `DIRTY` — branch reused after its own squash merge (see below)                      | **No checks at all.** `refs/pull/361/merge` does not exist, so no run was dispatched             | **Rework** — re-cut off current `main`                 |
| #360 | `main` | `CLEAN`, based on current `main`                                                    | All 13 required contexts green                                                                   | **Merge**                                              |
| #358 | `main` | `CLEAN`, one commit behind `main`                                                   | All 13 required contexts green                                                                   | **Merge after** fixing the inert second test           |
| #357 | `main` | `CLEAN`, one commit behind `main`                                                   | All 13 required contexts green                                                                   | **Merge**                                              |
| #356 | `main` | `CLEAN`, one commit behind `main`                                                   | All 13 required contexts green                                                                   | **Merge**                                              |
| #355 | `main` | `BLOCKED` — required `Test Frontend` failed; two Lighthouse contexts never reported | **Genuine failure.** `react@19.2.8` against `react-dom@19.2.7`; 109/109 frontend test files fail | **Do not merge alone** — needs #354 in the same change |
| #354 | `main` | `BLOCKED` — same shape                                                              | **Genuine failure.** `react-dom@19.2.8` against `react@19.2.7`; 109/109 fail                     | **Do not merge alone** — needs #355 in the same change |
| #353 | `main` | `CLEAN`, one commit behind `main`                                                   | All 13 required contexts green                                                                   | **Merge**                                              |

There are **no starved jobs and no absent-by-filter workflows** in this queue,
and nothing is failing for a reason that is not its own. Every executed job ran
7 to 16 real steps over realistic durations; there are no budget or
spending-limit annotations anywhere, and `gh run list --limit 100` returns zero
non-success runs repo-wide. The short (~3s) check runs named `CodeQL` and
`zizmor` are code-scanning SARIF result checks, not Actions jobs, and are
`SUCCESS` by design.

## The stack: #361 re-delivers #359

There is no conventional stack — every PR targets `main` directly, and nothing
in the queue would auto-close if another merged. There is one **branch-reuse
overlap**, which is why #361 is `DIRTY`:

```
d3c454b  (merge base for #361 and for #357/#356/#355/#354/#353)
   |
   |\
   | \___ feat/settled-read-states
   |        7e10b07  settled read states  ─┐  content squash-merged as #359
   |        8fc4f95  docs                  │
   |        4b53f50  ci(gitleaks)          │  #361 = this whole branch,
   |        95d727f  chore(lint)           │  still rooted at d3c454b
   |        bfd97c4  build(verify)         │
   |        0ef32af  fix(ics)              │
   |        0d2ab38  fix(digest)           │
   |        12aaf78  fix(prefs)            │
   |        e3b233e  test: pin behaviour   │
   |        add4956  docs(testing)        ─┘
   |
   \___ main
          5655398  squash of #359, from the SAME branch
```

PR #359 was squash-merged from `feat/settled-read-states` on 2026-08-27T23:59.
The branch was not deleted, and #361 was opened from it the next day with nine
further commits. Because the squash rewrote history, `7e10b07` is not an
ancestor of `main`, so GitHub still diffs #361 from `d3c454b` and re-presents
#359's already-merged work as part of it.

Consequences, all verified:

- **#361's displayed size is roughly double its real size.** GitHub shows 47
  files / +1957 / -112 against the merge base. Against current `main` it is
  **27 files / +956 / -62**.
- **The conflict is small and mechanical.** `git merge-tree --write-tree
--messages origin/main origin/feat/settled-read-states` conflicts in exactly
  two files: `docs/testing.md` (the test-count table) and `package.json` (the
  `lint`/`verify` script chains). Everything else auto-merges, because both
  sides contain identical content.
- **#361's own note that it "merges cleanly against `origin/main` as it stands"
  is now false.** It was true when written, against `d3c454b`.
- **Three more files are pure re-presentation.** `DEFINITION_OF_DONE.md`
  (shown as +18/-17), `CONTRIBUTING.md` (+2/-1) and `CHANGELOG.md` (+53) are
  **byte-identical to `main`** once diffed from current `main` rather than from
  the merge base. #361 changes none of them.
- **A consequence worth catching in review:** #361 adds `lint:scripts` and
  `check-api-spec.mjs` to `npm run verify` and a working-tree scan to the
  `Security Scan` job, but because its `DEFINITION_OF_DONE.md` hunk is #359's,
  it leaves that file's "Local parity" list — which enumerates exactly what
  `make verify` chains — stale on both additions.
- The trees of `5655398` and `7e10b07` differ only in `CHANGELOG.md` and
  `docs/adr/0010-settled-read-states.md`, so #359 was lightly revised between
  branch and merge. That drift is the substance of the `docs/testing.md`
  conflict.

Nothing else overlaps. **#358 and #361 both edit
`backend/src/services/icsExport.ts`, and they do not collide.** Simulating
`main + #358` and then `#361` on top adds no conflict beyond the two above:
`icsExport.ts` and `icsExport.test.ts` both auto-merge, and the merged source
carries both changes intact (`fold()` byte-based from #358, `formatDateInZone()`
zone-aware from #361, no conflict markers, both test sets present).

## Dominant-defect findings

### #358: the second test passes in both the fixed and the unfixed state

#358's fix is **correct** and its first test is **genuine**. Its second test is
inert.

`backend/tests/unit/services/icsExport.test.ts` adds
`it('never splits a surrogate pair (emoji) across a fold boundary')` with the
fixture `'x'.repeat(73) + '🌱' + 'y'.repeat(20)`. The comment says the astral
character lands "exactly on a fold boundary". It does not. The
`DESCRIPTION:Recurring every 7 days. ` prefix is 36 code units, so the emoji
begins at **code-unit index 109**, while the only fold boundary the old code
produces is at **75**. Running the fixture through both implementations:

| Implementation     | Physical lines | Max bytes | Contains U+FFFD | Emoji intact |
| ------------------ | -------------- | --------- | --------------- | ------------ |
| old (UTF-16 units) | 2              | 75        | no              | yes          |
| new (UTF-8 bytes)  | 2              | 75        | no              | yes          |

The output is **byte-for-byte identical**. The test cannot fail on the code it
was written to guard.

The hazard it describes is real, and reachable one character away. With
`'x'.repeat(38)` the emoji starts at index 74, straddling the boundary, and the
old implementation splits the surrogate pair:

```
[0] "DESCRIPTION:Recurring every 7 days. xxxx…xxxx\ud83c"
[1] " \udf31yyyyyyyyyyyyyyyyyyyy"
```

Two lone surrogates; the emoji becomes U+FFFD on UTF-8 serialisation. So the
"second, related hazard" that #358's own description calls out is the half of
the fix with **no working test**. Changing `73` to `38` is the whole remedy.

The first test is sound and does discriminate: under the old code the SUMMARY
line is a single 113-octet physical line, so the `<= 75` byte assertion fails.
Note its description overstates the fixture — the PR body claims "a 72-code-unit
plant name … measured 164 UTF-8 bytes", while the committed fixture is 41 code
units / 91 bytes, giving a 55-unit / 113-byte SUMMARY line. The test is right;
the prose numbers are not.

### #361: what it adds versus what is already fixed

`e3b233e`, `12aaf78` and `add4956` are **not on `main`** — they are #361's own
commits and exist on no other ref. What is already on `main` is `7e10b07`'s
_content_, via the #359 squash: ADR 0010, `check-settled-read-states.mjs` and
its baseline. Everything else in #361 — the ICS zone fix, the digest calendar-day
fix, `localDate.ts`, `timezoneSet`, the gitleaks working-tree scan, the gate-script
lint, `check-api-spec` in `verify` — is new.

`backend/src/utils/localDate.ts` is DST-safe by construction: it resolves each
instant to its calendar date via `Intl.DateTimeFormat` in the named zone and
subtracts dates, never adding hours, and it degrades an unrecognised zone to UTC
inside a `try`/`catch` rather than throwing inside a scheduled scan.

## Type coverage: the numbers, measured here

The claim that the test suites sit outside `tsc` and ESLint is **true**, and
#361 states it honestly as a known gap it does not close. The figures it quotes
are close to, but not exactly, what this triage measured.

Mechanism, confirmed in the files:

- `backend/tsconfig.json` — `"include": ["src/**/*"]`. `backend/tests/` is never
  type-checked. `backend/package.json` `typecheck` is a bare `tsc --noEmit`.
- `frontend/tsconfig.json` — `"include": ["src"]`. The whole `frontend/tests/`
  tree is never type-checked. The 11 colocated `frontend/src/**/*.test.ts` files
  **are** checked.
- Both workspaces lint with `eslint src`, and the root `eslint.config.mjs`
  scopes its rule blocks to `backend/src/**/*.ts` and
  `frontend/src/**/*.{ts,tsx}`, so no test file matches any rule block.

Measured numbers, `tsc --noEmit` over a config identical to each workspace's own
but with the test tree added:

| Tree                                        | Cases outside `tsc`   | `tsc` errors |
| ------------------------------------------- | --------------------- | ------------ |
| `backend/tests/` on `main` (`5655398`)      | **1,492** (99 files)  | **693**      |
| `backend/tests/` on #361's head (`add4956`) | **1,527** (106 files) | **706**      |
| `frontend/tests/` on `main`                 | 715                   | **27**       |

Backend error shape on `main`: 524 `TS2345`, 88 `TS2835`, 29 `TS2322`, 23
`TS2352`, tail. On #361's branch: 537 / 88 / 29 / 23.

Reading of the claims:

- **The "1,527 backend test cases" figure is #361's branch, not `main`.** On
  `main` today the number is **1,492**, which is also what `docs/testing.md`
  states and what the suite reports when run. #361 adds seven backend test files
  and updates the doc to 1,527 in the same change. Both numbers are right about
  their own tree; they are not interchangeable.
- **#361's "709 errors" measures at 706 here**, with `TS2345` (537) and `TS2835`
  (88) matching exactly and `TS2322` differing by two. Same shape, difference
  within tooling-version noise. The claim is substantiated.
- **No PR in this queue claims to widen type coverage.** #361 is the only one
  that touches the subject, and it explicitly declines to close the gap, states
  the error count, and proposes a `tsconfig.test.json` plus a ratchet. That is an
  accurate disclosure, not a false claim.
- Worth adding to #361's framing: the frontend half is **cheap**. 27 errors, most
  of them one missing `types` entry, against 693 on the backend. The gap could be
  closed for `frontend/tests/` now and ratcheted only on the backend.

## Non-diff hazards

**Changelog position: no hazard in this queue.** Checked from each PR's own merge
base, not against `main`. Only #361 touches `CHANGELOG.md`, and its file is
**byte-identical to `main`'s** — the +53 lines GitHub shows are #359's
already-merged entry, re-presented by the branch reuse. Nothing lands inside a
released section. The inverse is worth a review note: #358 and #361 both make
user-visible fixes (calendar export correctness; three timezone defects) and
**neither adds an `## [Unreleased]` entry**. #361's checklist claims the changelog
item only for `docs/testing.md`.

**Same-file collisions: one real conflict cluster.** All of #360, #356, #353,
#355 and #354 touch `package-lock.json`, and four touch `frontend/package.json`.
Every pair was simulated with `git merge-tree --write-tree --messages`, and each
clean result was extracted and re-parsed:

| Pair    | Result                                                      |
| ------- | ----------------------------------------------------------- |
| 360+356 | clean, JSON parses, manifest and lockfile consistent        |
| 360+353 | clean, consistent                                           |
| 360+355 | clean, consistent                                           |
| 360+354 | **conflict** — `frontend/package.json`, `package-lock.json` |
| 356+353 | clean, consistent                                           |
| 356+355 | clean, consistent                                           |
| 356+354 | clean, consistent — **but carries a peer violation**        |
| 353+355 | clean, consistent                                           |
| 353+354 | **conflict** — `frontend/package.json`, `package-lock.json` |
| 355+354 | **conflict** — `frontend/package.json`, `package-lock.json` |

The conflicts are textual adjacency: `react` (line 77), `react-dom` (78) and
`react-hook-form` (79) are consecutive lines in `frontend/package.json`.

`356+354` is the shape that matters — **it merges clean, parses fine, is
manifest/lockfile consistent, and is still broken**, because it lands
`react-dom@19.2.8` whose own `peerDependencies` require `react@^19.2.8` beside
`react@19.2.7`. Baseline `main` has zero such violations; #360, #356, #353 and
#355 each introduce zero; only #354 does.

**Generated files: lockfiles all agree with their manifests.** Every
`package-lock.json` hunk was checked against its PR's `package.json` hunks for
declared range, resolved `node_modules/<pkg>` version, and semver satisfaction.
#360, #357, #356 and #353 are all internally consistent, with no stale duplicate
copies. Two standing observations, neither introduced by any open PR: the root
`overrides` block pins `react`, `react-dom`, `@types/react` and `@types/react-dom`
to `^19.2.0` while #355/#354 declare `^19.2.8` in `frontend/package.json` without
touching the root, so the override erases the floor the frontend just declared;
and `packages[""]` in `package-lock.json` records no `overrides` object at all
despite the root manifest having one.

**Test-count regeneration: not needed.** `scripts/check-docs-testing.mjs`
enforces **file** counts only and deliberately does not check case counts. No
Dependabot PR adds or removes a test file. #358 appends two cases to an existing
file, so the gate stays green while the prose figure in `docs/testing.md` (1,492)
silently becomes 1,494 — a documented limitation, not a gate failure. #361 adds
test files and updates the table in the same change, which is why the table is a
conflict rather than a breakage.

**Ruleset artifact drift** (context, not a defect, and no PR here changes it).
The live `protect-main` ruleset carries one bypass actor. The committed copy at
`.github/rulesets/main.json` records `"bypass_actors": []` and its README asserts
there is no admin bypass on `main`; live `updated_at` is ten days later than the
snapshot. The 13 required contexts match live exactly. **No open PR touches
`.github/rulesets/`, so nothing here removes the bypass.** The reviewable
in-tree artifact is simply stale and should be regenerated.

**Skipped required checks count as satisfied.** On #355 and #354, `Build`,
`Bundle size` and `E2E + accessibility (Playwright)` reported `skipped` because
they `needs:` the failing `Test Frontend`, and GitHub treats a skipped required
check as met. Separately, when the Lighthouse matrix job skips it emits one
un-matrixed check named `Lighthouse (mobile + desktop)`, which matches neither
required context string, so both sit permanently pending. Neither shape is
producing a false green today — the PRs are blocked by the genuine failure — but
both are worth knowing.

## Safe order of operations

1. **Merge #357** (codeql-action group). Workflow YAML only, no interaction with
   anything else in the queue. All three action refs move to the same SHA and no
   stale reference is left behind in `.github/`.
2. **Merge #356** (`@aws-sdk/lib-dynamodb`), then **#353** (`react-hook-form`),
   then **#360** (dev-dependencies group), in any order. All three pairs among
   them are clean and self-consistent. No regeneration step is required for any
   of them: no test file moves, no vitest config moves, no changelog hunk.
3. **#358** — apply the one-character fixture fix first (`'x'.repeat(73)` →
   `'x'.repeat(38)` in the surrogate test), confirm the test now fails against
   `main`'s `fold()` and passes against the PR's, then merge. Optionally add the
   `## [Unreleased]` entry in the same push. No count regeneration needed.
4. **#355 and #354 must land as one change.** Neither may be merged alone: each
   leaves `react` and `react-dom` on different patch versions, and React's
   runtime asserts exact version equality, so all 109 frontend test files fail.
   They also conflict with each other textually, so they cannot simply both be
   merged. Resolve by closing both and letting Dependabot reopen a single grouped
   PR after adding a group to the `/frontend` block of
   `.github/dependabot.yml` — the existing `dev-dependencies` group covers
   `dependency-type: development` only, and `react`/`react-dom` are production
   dependencies, which is exactly why they were split. A group with
   `patterns: ["react", "react-dom", "@types/react", "@types/react-dom"]` would
   prevent the recurrence. If the root `overrides` floors are meant to track, they
   need bumping in the same change.
5. **#361 last, and only after being re-cut.** Its remedy is not a conflict
   resolution in place: the branch is rooted before its own squash merge. Cut a
   fresh branch from current `main` and carry over the nine post-`7e10b07`
   commits, which reduces the PR to its real 27 files. `docs/testing.md` will then
   need its counts regenerated against the post-merge tree (the file-count gate
   will enforce this; the case counts must be re-measured by hand), and the
   `package.json` `lint`/`verify` script chains re-applied on top of `main`'s
   current versions. Only then does the PR get a CI verdict, which it has never
   had. Its own description says "Do not merge. Opened for review."

Merging #358 before or after step 2 is safe either way; it shares no file with
any Dependabot PR, and its overlap with #361 auto-merges.

## Verified here versus taken on trust

**Verified by running or reading it:**

- The open set: 8 PRs, exactly the expected numbers, via `gh pr list`.
- `main` is green: `npm run verify` exit 0 in a clean `origin/main` worktree,
  with the full backend and frontend suites and both coverage floors.
- Test-case counts (1,492 backend / 759 frontend) from the suites' own output,
  and the 715/44 split of frontend cases outside/inside `tsc` from `vitest list`.
- `tsc` error counts (693 backend on `main`, 706 on #361's head, 27 frontend)
  by running `tsc --noEmit` over each workspace's config plus its test tree.
- The `tsconfig` `include` and ESLint `files`/`ignores` patterns, read directly.
- #358's fold behaviour: both implementations executed against the committed
  fixture and against the corrected one.
- #361's ancestry: `git merge-base --is-ancestor` and `git for-each-ref
--contains` for each cited commit; tree comparison of `5655398` against
  `7e10b07`.
- Every merge and conflict result, via `git merge-tree --write-tree --messages`
  with `git commit-tree` for sequential simulation, with merged files extracted
  and re-parsed.
- CI classification: `statusCheckRollup`, per-job step counts and durations,
  annotations, and `--log-failed` output for #355 and #354.
- Lockfile/manifest agreement for #360, #357, #356 and #353, entry by entry.

**Taken on trust, or not established:**

- Runtime behaviour of the React 19.2.8 upgrade beyond what the frontend suite
  exercises. The dependency analysis is static plus the existing CI logs; no
  build or e2e run was performed with both bumps applied together.
- **#361's three timezone defects were not re-executed.** Its ancestry, size,
  conflicts, `tsc` counts and `localDate.ts` were verified directly, but its new
  tests were not run against `main`'s implementations, so the claim that each
  "failed before and passes after" is taken on trust. The same applies to its
  gate-hole experiments (the gitleaks working-tree scan, the newly linted `.mjs`
  gate scripts) and to its two deliberately "pinned, not changed" behaviours
  (#343, #346) — whether those new tests assert today's arguably wrong behaviour
  as correct, such that a future fix must rewrite them, is **not established
  here** and is the first thing to check when the PR is re-cut.
- Lighthouse, Playwright e2e, Semgrep, CodeQL and gitleaks results are read from
  their CI conclusions; none was re-run locally.
- The live ruleset was read through the API at one moment in time; it can change.
- Whether the corrected `'x'.repeat(38)` fixture is the fixture the author would
  choose. It is demonstrated to discriminate; the shape of the fix is a judgement
  for review.
