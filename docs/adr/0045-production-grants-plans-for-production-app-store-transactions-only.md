# 0045 — Production grants plans for Production App Store transactions only

**Status:** Accepted

**Date:** 2026-11-17

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0041](0041-apple-in-app-purchase-in-the-iphone-app.md) (In-App Purchase in the
iPhone app; this record replaces the Sandbox sentence in its decision 3).

## Context

Apple signs a transaction with the App Store environment it came from: `Production` for a purchase
somebody paid for, `Sandbox` for a test purchase that costs nothing. ADR 0041 accepted both on every
deployment, production included, because App Review buys in Sandbox against the production server.
`APP_STORE_ENVIRONMENTS` could narrow that, and nothing set it.

A plan should be granted in production only for a purchase that was paid for. Accepting Sandbox
there is needed for a few days around a review, not all year.

## Decision

1. **The backend default is Production only.** With `APP_STORE_ENVIRONMENTS` unset,
   `appStoreEnvironments()` accepts `Production` and nothing else. A value that names neither
   environment accepts nothing.
2. **Sandbox is an opt-in a deployment writes out.** Terraform gains `app_store_environments`,
   default `"Production"`, validated to be exactly `"Production"` or `"Production,Sandbox"`, and
   passes it to the billing Lambda as `APP_STORE_ENVIRONMENTS`.
3. **Staging opts in, always.** It has no real customers, and it is where a Sandbox purchase is
   tested end to end.
4. **Production says `"Production"`, in its tfvars.** The line is written out, not left to the
   default, so the value is visible in review and a wiring test can read it.
5. **Production opts in only around an App Store submission.** The owner sets
   `"Production,Sandbox"` in the release before her TestFlight purchase check and sets it back in
   the first release after Apple approves the build. Each change is a tfvars line and a tag.

## Consequences

- A Sandbox transaction posted to production is verified, logged as
  `app_store_environment_refused` and ignored: nothing is bound and no plan is written. The app
  shows the purchase as not finished, and Apple's Sandbox notifications get a 200.
- A Sandbox subscription already recorded on a household keeps its plan until the expiry already
  recorded. Renewals are not applied while Sandbox is closed.
- **A TestFlight purchase check and an App Review purchase both fail while production is closed
  to Sandbox.** Opening it is a release step, and forgetting it reads as a broken purchase to the
  reviewer. `docs/mobile-release-checklist.md` carries the step.
- While the window is open, the old trade-off applies: a TestFlight tester's free Sandbox
  subscription unlocks the plan on the tester's own household while it lasts.
- Two releases carry a one-line change each. That is the cost of not leaving the window open.
- Not built: accepting Sandbox only for named households. It would shrink the window's exposure
  further, at the price of a list to maintain for a demo account that is new on each submission.
