# 0031 — A reminder can be answered by mail, through a hashed per-email reply address that reaches only the tasks that email listed

**Status:** Proposed

**Date:** 2026-09-17

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0016](0016-plant-tags-account-free-care-actions.md) (account-free care
actions and the hashed-token family this joins); [ADR 0021](0021-email-rendering-and-usefulness.md)
and [ADR 0022](0022-email-deliverability-and-bounce-handling.md) (the reminder this answers, and
the sender path the replies use); issue #667; `infrastructure/modules/email/inbound.tf` (the
existing SES receiving path).

## Context

The daily reminder is the household's most-read surface, and the member who reads mail but will
not open the app is the one ADR 0016 names as the product's bottleneck. Issue #667 asks that
replying `done` or `snooze 2 days` to the reminder act on it.

The receiving half already existed: the apex MX routes the domain to SES, an active receipt rule
set stores raw mail in S3, and a forwarder Lambda relays `support@`/`security@`/`hello@`/`dmarc@`
to the maintainer. What did not exist was any way to tie an inbound message to a member and a
task, and any code allowed to change state because of one.

That is a new attack surface on the one input channel anybody on the internet can write to, so
the design question is less "how do we parse `done`" than "what, exactly, can a message cause".

## Decision

1. **One reply address per reminder email: `care+<token>@<domain>`.** The token is 160 CSPRNG
   bits as 40 lowercase hex characters (hex because mail systems case-fold local parts). SES
   matches a receipt-rule recipient of `care@<domain>` against every `care+<label>@<domain>`, so
   one rule serves every token, with no new MX record and no subdomain. `care` is not a forwarded
   mailbox, so no reply can reach the maintainer's inbox and no forwarded mail can reach this
   path.

2. **The token is stored only as its digest**, keyed `EMAILREPLY#<digest>` through the shared
   at-rest helper (`utils/tokenHash.ts`, surface `emailReply`, its own salt and a pinned golden
   digest). There is no plaintext generation of this surface, so a digest lifted from a table
   export does not work as an address.

3. **A token grants what its email showed and nothing more**: one member, one household, and the
   exact rows the email numbered — each pinned to the occurrence (`expectedNextDue`) it described.
   A reply names positions in that list (`done 2`), never task ids, and can only complete or
   snooze, through the same `taskService` calls the app's own routes make
   (`completeTaskWithOutcome` / `snoozeTaskWithOutcome`), with the same side effects (the covered
   member's credit email; the snooze activity row). Nothing is created, deleted or edited.

4. **Single use per task, by construction.** Every action passes the pinned occurrence, and every
   action moves `nextDue`, so the second action on a task through the same token — a replay, a
   second reply, a snooze after a done — can never match. A replay of the same SES message is also
   claimed and dropped (a leased claim, the `emailEvents` shape).

5. **Checks, in order, each ending the message with no state change when it fails:** SES spam and
   virus both `PASS`; exactly one well-formed reply recipient; the digest names a row; that row's
   member is still in that household; the one From mailbox is exactly the member's stored
   address; SES's DMARC verdict is `PASS` (so the From is authenticated, not typed); the token has
   not expired (3 days); the first line above the quoted text parses; every number is one the
   email listed.

6. **A closed grammar, first line only.** `done` / `complete` (ES `hecho`, `listo`, `completado`
   …) with optional numbers; `snooze` / `postpone` (ES `posponer`, `aplazar`) with optional
   numbers and a duration that always carries a unit (`3 days`, `2d`, `1 week`, `por 3 días`).
   `snooze 2` — task 2, or two days? — is refused rather than guessed. Quoted text, signatures and
   everything under the first line are ignored.

7. **Replies are bounded and never backscatter.** An unknown token, a mismatched sender or a
   failed scan gets silence. Everything else is answered at most as follows, always to the
   member's STORED address with our own subject and body: one confirmation per acted-on reply,
   and at most once per token each a help note (unrecognized command), an expired note and an
   unverified-sender note; a hard cap of 13 replies per token overall. The only inbound value
   copied into an outbound header is a Message-ID proved to be printable ASCII in angle brackets,
   for threading.

8. **Inert until the owner switches it on.** Everything that makes SES deliver replies — the
   `reply-to-act` receipt rule, the SES invoke permission and the `replies/*` S3 grant — is
   counted on `email_reply_actions_enabled` (default `false`), and the reminders Lambda mints
   reply addresses only when the same variable is on. The `emailReplies` function is deployed
   either way and receives nothing, like `emailEvents` without a topic.

## Consequences

- Turning it on is one tfvars line (`email_reply_actions_enabled = true`) and a `v*` tag. No DNS
  change is needed: the apex MX and the active rule set already receive for the domain. Stored
  replies are deleted as soon as they are read, with a 3-day lifecycle backstop on `replies/`.
- A member whose mail provider does not publish DMARC (GRAY) or fails it cannot act by reply; they
  get one note saying nothing changed. Gmail, Outlook, Yahoo and iCloud all pass DMARC for their
  own users. Relaxing this to DKIM-or-SPF would authenticate a domain, not the From address.
- A reply that arrives after someone else handled the task says so ("already taken care of …
  nothing changed"), never "done".
- A retry after a partial failure re-runs every step; nothing applies twice, and the confirmation
  then reports the first attempt's work as already taken care of — true, if less satisfying.
- Replacing the reminder's `Reply-To: support@` means a real question typed into a reply now reaches
  a computer. The help note says so and names `support@`.
- Token rows are keyed by digest, so account deletion cannot find them by user; they carry a user
  id, a household id and task ids, and DynamoDB TTL removes them at most 10 days after minting
  (3 valid + 7 kept to answer "expired"). A deleted or departed member's token is inert before
  then, because every reply re-reads the membership row.
- The privacy policy does not yet say that replies to a reminder are read by a machine and kept
  for up to 3 days. It should, before the switch is turned on.

## Not decided here

- Whether reply-to-act is on for every household, opt-in per household, or tier-gated. Built as
  one global switch; a per-household toggle needs settings UI and a default.
- `skip` (snooze by one cycle, the app's "Skip cycle"), natural-language parsing, SMS replies,
  attachments.
