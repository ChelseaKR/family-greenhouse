# Dependabot closure and dependency audit — 2026-07-13

This audit accounts for every Dependabot pull request in the repository before
the 2026-07-13 maintenance pass. The inventory command was:

```sh
gh pr list --state all --limit 100 --author app/dependabot
```

It returned **84 PRs: 24 merged, 60 closed, 0 open**. No PR was closed during
this pass, so no outstanding update was dismissed without evidence.

## Merged by GitHub

The following PRs have a merge commit in `main`:

`#191, #189, #187, #184, #183, #182, #181, #179, #178, #161,
#160, #159, #156, #155, #149, #147, #145, #143, #142, #107, #64,
#62, #61, #31`.

Two need historical context. Tailwind 4 (`#149`) was reverted deliberately in
`09357ee` because its configuration/build migration was not compatible; it
remains the one held package major. Express 5 (`#147`) was reverted in that
same recovery commit, then adapted and successfully re-landed in `#178`.

## Closed PRs whose update is now landed or superseded

Every PR in this group is satisfied by a newer bot PR, a later verified
dependency-modernization commit, or this pass's lock refresh:

`#192, #188, #186, #185, #180, #162, #158, #157, #154, #153,
#152, #151, #150, #148, #146, #144, #141, #84, #81, #80, #79,
#78, #77, #76, #75, #74, #73, #72, #71, #70, #69, #68, #67,
#57, #56, #54, #53, #52, #39, #38, #33, #32, #30, #29, #28,
#24, #23, #22, #21, #19, #17, #18, #16, #15, #14, #13`.

Concrete evidence:

- `#191` put both CodeQL `init` and `analyze` on the v4.37.0 SHA, making
  `#186`, `#188`, and `#192` redundant. The Scorecard SARIF uploader is now
  aligned to that same reviewed SHA.
- `d2917e9` landed the compatible Vite 8, plugin-react 6, jsdom 29,
  `@types/node` 26, `@types/express` 5, UUID 14, Zustand 5, and resolver 5
  majors. React 19, Vitest 4, ESLint 10, TypeScript 6, and Middy 7 have their
  own verified modernization commits in `main`.
- Artifact/action requests were superseded by checkout 7, setup-node 6,
  upload-artifact 7, download-artifact 8, Codecov 7, Terraform setup 4, and
  AWS credentials 6.2.2. The AWS Terraform constraint is `~> 6.52` and the
  lock currently selects 6.54.
- The 2026-07-13 `npm update` advances every package allowed by the declared
  semver ranges; the old SNS, Bedrock, Middy, and grouped minor/patch PRs are
  therefore below the resolved lock versions.

## Closed PRs resolved in this pass

- `#20` and `#27` (Zod 4): both workspaces now use Zod 4.4.3. The migration
  uses Zod's distinct input/output types for coerced React Hook Form fields
  and the v4 `ZodError.issues` API.
- `#25` (`@types/uuid`): removed. UUID 14 publishes its own declarations, so
  carrying the obsolete external declaration package creates type drift
  instead of adding coverage.

## Deliberate holds

- `#26` / reverted `#149` (Tailwind 4): held at 3.4.19. The repository uses
  the Tailwind 3 JavaScript config and `@tailwind` pipeline; the prior direct
  bump broke the locked install and was explicitly reverted by `09357ee`.
  This needs a real configuration/CSS migration, not a version-only PR.
- TypeScript 7 is newer than the old Dependabot inventory (whose TypeScript 6
  requests are already landed). It remains outside the declared `^6.0.3`
  range and is not silently folded into a lock refresh.

After the refresh, `npm outdated` reports only those two held majors, and
`npm audit --omit=dev --audit-level=high` reports zero vulnerabilities. The
repository's full verification evidence is recorded in the pull request for
this maintenance pass.
