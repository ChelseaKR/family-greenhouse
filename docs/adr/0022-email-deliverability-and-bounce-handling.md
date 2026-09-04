# 0022 — Outbound mail authenticates twice, and a bounce has consequences

**Status:** Accepted

**Date:** 2026-09-03

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0010](0010-settled-read-states.md) (a settled read with no data is
its own state — the suppression lookup is one)

## Context

An audit of every email the product sends found the sending infrastructure well
built and the mail hygiene absent. Three findings, in ascending order of
seriousness.

**SPF could not align.** The domain has an SES identity, DKIM (three CNAMEs),
an apex SPF record and DMARC at `p=quarantine` with relaxed alignment. What it
did not have was a custom MAIL FROM domain, so the envelope sender — the
Return-Path, which is what SPF actually authenticates — was SES's own
`*.amazonses.com`. That domain is not the header-From domain, so SPF could
never satisfy DMARC alignment no matter how correct the apex record was. DKIM
alone carried DMARC. The module comment said so, honestly, and left it there.

One passing mechanism is not redundancy. A DKIM key rotated wrong, a mailing
list that rewrites the body, a receiver that weights SPF more heavily — any of
those takes the domain from "quarantine is a policy" to "quarantine is what
happens to the password-reset email".

**There was no feedback loop at all.** No SES configuration set existed
anywhere in the stack, which means SES published no bounce or complaint events,
to anywhere. Grepping `infrastructure/` and `backend/src/` for
`configuration_set`, `bounce` or `complaint` returned nothing relevant.

**So nothing ever marked an address undeliverable.** A member's email is
written once, at join time, and never re-examined. A mailbox that stops
existing keeps receiving the hourly reminder scan, the Monday digest, and the
January recap — forever. That is the finding that matters most, because
sustained bounces are precisely what destroys a sending domain's reputation,
and that reputation is shared by every message the domain sends. A household
that stops paying attention to its plants would, over a year, quietly degrade
the deliverability of the confirmation code a completely different user needs
to get into their account.

The failure was also invisible. `sendEmail` returned `true` the moment
`SendEmailCommand` resolved, the reminder path read that as delivery and
finalized the day's marker, and the only trace of a dead mailbox was a bounce
notification nobody was listening for. The product's own theme applies exactly:
the failure looked like health.

## Decision

### 1. Two authentication mechanisms, not one

A custom MAIL FROM subdomain (`mail.<domain>`, `aws_ses_domain_mail_from`) with
its own MX (`feedback-smtp.<region>.amazonses.com`) and its own SPF record. The
Return-Path becomes `mail.<domain>`, an organizational-domain match for the
header-From under DMARC's relaxed alignment (`aspf=r`), so SPF aligns and DMARC
rests on two independent mechanisms instead of one.

`behavior_on_mx_failure = "UseDefaultValue"`, deliberately. If the MX does not
resolve — DNS not yet propagated, a zone edit gone wrong — SES falls back to
its own bounce domain and keeps sending. `RejectMessage` would convert a DNS
hiccup into a total mail outage, and the fallback state is exactly the
behaviour that shipped for the last year: worse than aligned, no worse than
before.

The apex MX for inbound mail (`inbound-smtp`, serving `support@`, `security@`,
`hello@`, `dmarc@`) is a different record at a different name and is untouched.

### 2. A configuration set, and events that reach code

`aws_sesv2_configuration_set` attached to every send, publishing `BOUNCE`,
`COMPLAINT`, `DELIVERY`, `DELIVERY_DELAY`, `REJECT` and `RENDERING_FAILURE` to
an SNS topic, which invokes `handlers/emailEvents`. `reputation_metrics_enabled`
puts per-set bounce and complaint rates in CloudWatch;
`suppression_options = ["BOUNCE", "COMPLAINT"]` turns on SES's own account-level
list as a second layer under the application's.

`DELIVERY` is subscribed for a specific reason: it is what CLEARS a transient
soft-bounce counter. Without it, a mailbox that was full for one week would
carry those strikes indefinitely.

The topic is created in the email module, next to the identity it reports on;
the subscription is created in the api module, next to the function it delivers
to. That split is what keeps `email → api` a straight line rather than a
Terraform dependency cycle.

### 3. The suppression policy

One row per address (`EMAIL#<normalized address>` / `DELIVERY_STATE`), holding a
two-value state machine:

| Event                                                   | Effect                                                     | Sending            |
| ------------------------------------------------------- | ---------------------------------------------------------- | ------------------ |
| **Hard bounce** (`bounceType: Permanent`)               | `suppressed`, reason `hard_bounce`, no TTL                 | Stops              |
| **Complaint**                                           | `suppressed`, reason `complaint`, no TTL                   | Stops, permanently |
| **Soft/transient bounce** (`Transient`, `Undetermined`) | `transient`, counter +1, 30-day rolling TTL                | Continues          |
| **5th soft bounce in the window**                       | `suppressed`, reason `soft_bounce_limit`                   | Stops              |
| **Delivery**                                            | clears a `transient` row; never touches a `suppressed` one | —                  |

Suppressed rows carry **no TTL**. An address that does not exist does not start
existing because a month went by, and a suppression that quietly expires is a
bounce loop with extra steps.

`Undetermined` is treated as transient. Guessing "permanent" from an
inconclusive bounce would suppress working mailboxes on ambiguous evidence; the
soft-bounce budget catches a genuinely dead one within five sends anyway.

**Un-suppression is a deliberate human act, and only the recipient's.**
`DELETE /notifications/email-suppression` takes the address from the verified
session, never from the request body, so it can only ever affect the caller's
own mailbox. There is no admin override and no automatic expiry. For a hard
bounce that is a convenience — the person who can fix the mailbox is the person
who owns it. For a complaint it is the whole point: someone who pressed "report
spam" withdrew their consent, and the only thing that can restore it is their
own action, taken deliberately, while signed in. The endpoint is rate limited
to 5/hour, because an address that bounces on every send could otherwise be
cleared and re-bounced in a loop — the exact damage the list exists to prevent.

### 4. A failed lookup is not a green light

The suppression check runs on every send. Its three outcomes are `sendable`,
`suppressed`, and `unknown` — the last meaning the store could not be read.
Per ADR 0010, `unknown` is not folded into either neighbour. The send is
declined and reported as `suppression_unknown`, so the scheduled jobs release
their marker and retry on the next run. The cost of that choice is a deferred
email during a DynamoDB incident; the cost of the alternative is mailing an
address we already know is dead.

The reminder scan additionally drops the email channel from a member's plan
_before_ reserving the daily lease when the address is already suppressed, so a
permanently dead mailbox stops churning a reserve/release pair through DynamoDB
every hour. An `unknown` lookup deliberately does not drop the channel: the send
path re-checks, and silencing a working mailbox over a transient read failure
would be the same defect pointed the other way.

### 5. Acceptance is not delivery

`sendEmail` returning `true` means SES took custody of the message. That is the
strongest thing knowable synchronously, and it is now said in those words:
`sendEmailAccepted` returns `{ accepted, reason }`, the boolean `sendEmail`
survives as a shorthand whose documentation states plainly that `true` is not
receipt, and the notifier reports a suppressed address as `undeliverable` —
a status distinct from the `suppressed` that means quiet hours, because "asleep"
and "dead mailbox" must not drive the same retry decision.

The day-marker is protected from the other side rather than by pretending the
send result is stronger than it is: an address the feedback loop has condemned
never reaches a lease at all.

### 6. Failure is visible to a person

A suppressed address surfaces in two places, at two levels of detail:

- **The household roster** carries `emailStatus` (`ok` / `undeliverable` /
  `unknown`) per member — deliverability without the address, so the Privacy
  Policy's "other members cannot see your email" still holds. It deliberately
  does not distinguish a bounce from a complaint: the household needs to know
  that a housemate is not getting reminders; that they reported us as spam is
  between them and us.
- **The owner's notification settings** show the reason and the resume button.
  The `email` toggle can read "on" while nothing is arriving, and that gap is
  precisely what the banner names.

A failed lookup renders as "we couldn't check", never as a clean bill of
health, in both places.

### 7. Cognito's un-templated paths

`verification_message_template` covers sign-up confirmation only, so
forgot-password shipped AWS's stock body from the same `From:` address as the
hand-written sign-up email — an identity break on the one message a locked-out
user has to trust, and the exact shape a phishing lookalike would imitate. A
`CustomMessage` Lambda trigger is the mechanism Cognito offers for it; it
renders forgot-password and admin-invite in the sign-up template's voice and
returns every other trigger source untouched, so the declarative templates stay
authoritative where they exist. The dormant admin-invite path additionally gets
a declarative `invite_message_template`, so flipping
`public_registration_enabled` cannot ship AWS's stock copy.

### 8. Reply-To

The app's own sends now carry `Reply-To: support@<domain>` — an address
`inbound.tf` already forwards to a human. Replies previously landed on `hello@`,
which is also forwarded, so this was a soft gap; it is closed because the
address a recipient replies to should be the one meant for replies.

## Bulk-sender obligations

The weekly digest and the January recap are not transactional mail. A reminder
about a task the user created is; a Monday summary of plants at risk, and a
year-in-review, are lifecycle mail the recipient did not individually request.
Gmail's and Yahoo's bulk-sender rules (in force since February 2024) apply to
that category, and `docs/compliance.md`'s single sentence — "Email + web push
are unaffected (transactional, lower risk)" — is thin cover for it.

Those rules require four things. This ADR delivers three:

1. **Authenticate with SPF, DKIM and DMARC, with alignment.** Now true on both
   mechanisms rather than one (§1).
2. **Keep spam complaints under 0.3%, and well under 0.1%.** Now measurable —
   the configuration set publishes per-set complaint rates to CloudWatch — and
   now actionable, because a complaint suppresses the address rather than
   inviting the next one (§3).
3. **Honour unsubscribes promptly.** A complaint is treated as a permanent
   withdrawal of consent, enforced at the send path within one event.

The fourth — **one-click unsubscribe (`List-Unsubscribe` and
`List-Unsubscribe-Post`) on non-transactional mail** — is NOT delivered here,
and this ADR records why rather than leaving it implied. `SendEmailCommand`
(SES v1) cannot set custom headers at all; the header requires `SendRawEmail`
or the v2 API, which is the same change needed to ship multipart HTML, and that
work is in flight on a separate branch. The IAM grant for the configuration-set
resource is written here so that migration does not fail with an opaque
`AccessDenied` on its first send. Until it lands, the product's own help content
continues to state the gap rather than hide it — "our emails have no
unsubscribe link today, which is a gap we'd rather name than hide" — and the
per-type preference toggles (`email`, `weeklyDigest`) remain the opt-out.

## Consequences

- **The MAIL FROM change is gated on DNS.** Terraform is written but not
  applied; the MX and TXT records must propagate before SES uses the subdomain.
  Until then `UseDefaultValue` keeps mail flowing on the old, unaligned
  Return-Path. Nothing breaks at any point in the transition.
- **A DynamoDB incident now defers email instead of sending it.** An unreadable
  suppression store stops sends rather than guessing. Reminders retry hourly and
  the digest retries within its window, so the visible effect is lateness, not
  loss. Cognito mail — sign-up codes, password resets — does not pass through
  this path and is unaffected, which is the right side of the trade for the
  messages people are actually blocked on.
- **One extra point read per outbound email.** A `GetItem` on the address's own
  partition, on the order of a hundred reads a week at present volume.
- **The roster query gained a `BatchGetItem`.** `getHouseholdMembersPublic` now
  makes two round trips instead of one; the batch is bounded by the same
  hundred-member limit the roster query already has.
- **A suppression can outlive its cause.** Someone who fixes their mailbox stays
  suppressed until they sign in and press resume. That is the deliberate cost of
  having no automatic expiry, and the settings banner exists so the state is
  discoverable rather than mysterious.
- **`ChannelDeliveryStatus` gained a member.** `undeliverable` sits alongside
  `suppressed`; any exhaustive switch on that union has to account for it.
- **The bulk-sender gap is now written down with a date and a blocker**, rather
  than being a thing everyone assumed someone else had checked.
