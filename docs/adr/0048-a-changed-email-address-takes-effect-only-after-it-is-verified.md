# 0048 — A changed email address takes effect only after it is verified

**Status:** Accepted

**Date:** 2026-11-17

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0022](0022-email-deliverability-and-bounce-handling.md) (bounces and the suppression
list), [ADR 0034](0034-the-app-stays-signed-in.md) (sessions).

## Context

An account's email address is where reminders, digests, household mail and billing mail go, and it
is the sign-in name. The app has no screen for changing it. The user pool's public app client has to
be able to write `email`, because sign-up writes it, and any attribute an app client can write can
also be changed later by the signed-in person through Cognito's own API.

`docs/security.md` said a new address had to be verified before it replaced the old one. The pool was
not configured that way: without `user_attribute_update_settings`, Cognito applies the new address
at once and marks it unverified.

## Decision

1. **The pool holds an email change until the new address is verified.**
   `user_attribute_update_settings { attributes_require_verification_before_update = ["email"] }` on
   the user pool. The old address stays the account's address, in the pool and in tokens, until the
   code sent to the new address is entered.
2. **`email` stays writable by the app client.** Removing it would break sign-up, which writes the
   address through the same client.
3. **The ID token says whether the address is verified.** `email_verified` joins the app client's
   readable attributes, and the API's auth middleware reads it onto the caller.
4. **One route refuses an unverified address:** `DELETE /notifications/email-suppression`, which puts
   the caller's address back on the send list after a bounce or a complaint. It acts on the mailbox
   itself, so the mailbox has to be the caller's.
5. **No other route refuses on it.** A token issued before the claim was readable carries no claim
   for up to an hour after the deploy, and an account confirmed by an operator may never have had its
   address verified. A blanket refusal would lock those people out of everything. The middleware
   treats a missing claim as "not stated" and only a stated `false` as unverified.
6. **`docs/security.md` says what is configured, and a wiring test reads both** the Terraform and
   the paragraph.

## Consequences

- An account whose address was changed outside the app before this deploy keeps that address,
  marked unverified. The setting applies to changes from here on. Such an account cannot clear an
  email suppression until support verifies the address.
- The plan for `aws_cognito_user_pool.main` and `aws_cognito_user_pool_client.main` must read
  `~ update in-place`. Neither change replaces the pool or the client.
- Not tested here: Cognito's behavior for the setting. It is AWS's documented behavior, and it is
  worth one manual check on staging after the deploy.
- Not built: an in-app way to change an email address. If one is added, it uses the same
  verification step.
