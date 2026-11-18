# 0049 — AWS trusts GitHub environments, and the deploy pipeline cannot widen itself

**Status:** Accepted

**Date:** 2026-11-17

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0002](0002-serverless-on-aws.md) (the stack the pipeline deploys). The single
deploy approval (`scripts/production-approval-gate.test.mjs`, #1119) is kept.

## Context

GitHub Actions reaches AWS by OIDC: a job asks GitHub for a token, and AWS exchanges it for a
role's credentials if the role's trust policy accepts the token's subject. There was one role. Its
trust accepted any job on `main`, any job on a `v*` tag, and any job in the `production`
environment. Its policy allowed IAM writes on every project-prefixed role and policy, its own
included, with a deny on four actions against itself. And several jobs that could ask for that
token ran `npm ci`, which runs each dependency's install script.

Each of those is wider than what a release needs. Together they meant the approval on a release
was a property of one workflow file and not something AWS enforced.

A release pauses for one approval, on the `terraform` job, by an earlier decision. Any design that
put the reviewed environment on every job would bring back a pause per job, the automatic rollback
included.

## Decision

1. **AWS trusts environments, never refs.** No trust policy names a branch or a tag. A job with no
   `environment:` can assume nothing.
2. **Three roles, by what the job needs.**
   - **deploy:** `terraform apply`. The only role with IAM writes. Trusted from `production` and
     `staging-infrastructure`, the two environments that carry a required reviewer.
   - **release:** what a release does after Terraform, in production and staging: Lambda code, the
     frontend bucket, CloudFront, the smoke test's fixtures, the rollback. The stack's services and
     IAM reads; no IAM write. Trusted from `production-release` and `staging`, which carry no
     reviewer, so a release still pauses once and a rollback never waits.
   - **alert-relay:** two read-only actions for the scheduled alarm relay. Trusted from
     `alert-relay`.
3. **The deploy role cannot change who it is.** It is denied every IAM action that is not a read on
   the three roles, their policies, the permissions boundary and the OIDC provider.
4. **The deploy role cannot create something wider than itself.** A role it creates must carry the
   project permissions boundary, a boundary can only be set to that policy and never removed, and
   the only managed policies it may attach are the project's own and the one AWS-managed policy the
   Lambda roles use. The boundary lists the services the application's roles use and no IAM.
5. **The CI/CD identities are applied by an admin.** Because of 3, a change to
   `infrastructure/modules/cicd` cannot be applied by the pipeline. The production `terraform` job
   reads its own plan and stops, before applying anything, if the plan would change that module.
6. **No install scripts beside a token or a secret.** Every job that holds an OIDC token or a
   secret installs with `npm ci --ignore-scripts`. Nothing in the lockfile needs its script; a test
   fails when a package that declares one is added.
7. **A release checks the release role first.** `preflight-release-role` assumes it and makes one
   read-only call before the approval is asked for, so a missing role, environment or secret stops
   a release before Terraform has applied anything.

## Consequences

- The reviewers on `production` and `staging-infrastructure` are now what stands between a workflow
  run and the deploy role, and they are repository settings. No file can pin them. GitHub also
  creates a missing environment, unreviewed, the first time a job names it. Both are on
  `docs/production-checklist.md`.
- A job in an unreviewed environment can assume the release role without an approval. That role can
  replace Lambda code and read and write the application's data, as the jobs that use it must. It
  cannot touch IAM, so it cannot become anything else or leave a way back in.
- A staging deploy now asks for one approval, on its `terraform` job.
- A change to the CI/CD module is two steps: an admin applies it, then the pull request merges. The
  order depends on whether the change adds or removes something (`docs/cicd-setup.md`).
- The boundary is switched per environment and is on in staging first. Until it is on in
  production, a production Lambda role's own policy is the only limit on that role. Turning it off
  again is an admin action, because the pipeline may not remove a boundary.
- A new Lambda permission in a service the boundary does not list fails a test in CI, and needs the
  boundary changed by an admin before the release.
- Not done here: scoping the release role to the actions each job uses, a separate role for the
  smoke test's fixtures, moving repository secrets into environments, a ruleset for `v*` tags, and
  splitting staging into its own account.
