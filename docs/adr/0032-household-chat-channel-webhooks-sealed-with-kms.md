# 0032 — A household chat-channel webhook is the first replayed secret, so it is sealed with KMS

**Status:** Proposed

**Date:** 2026-09-18

**Deciders:** Chelsea Kelly-Reif

**Related:** [#674](https://github.com/ChelseaKR/family-greenhouse/issues/674);
[ADR 0010](0010-settled-read-states.md) (a failed read is not an empty one);
`backend/src/services/channelSecret.ts`, `channelSsrfGuard.ts`,
`channelWebhookTransport.ts`, `householdChannel.ts`, `householdChannelRun.ts`;
`docs/notifications.md` § Household chat channel.

## Context

#674 adds a household-level notification channel: an admin pastes a Discord,
Slack or Matrix incoming-webhook URL and the household's plant care is posted
into the chat the family already uses.

Every credential this product stored before this one is something the server
only has to **recognise** — sitter, kiosk, caretaker, plant-tag and calendar
tokens, API keys. They are scrypt-hashed, so a database leak yields nothing a
caller could present. A webhook URL is different in kind: the server has to
**replay** it on every post. It cannot be hashed. The #674 triage recorded that
there was no KMS usage in `backend/src`, no envelope helper and no data key, and
that sealing it with an application-held key would be worse than not shipping.

The feature also makes the server POST to an address an admin chose. For
Discord and Slack the host is fixed; for Matrix it is the admin's own
homeserver, which makes it a server-side request forgery primitive aimed at
whatever a Lambda can reach — the metadata service first of all.

## Decision

1. **Seal with a dedicated customer-managed KMS key, directly.** `Encrypt` /
   `Decrypt` on the address itself (≈120 bytes, far under KMS's 4 KB limit), so
   the application never holds key material and there is no data key to cache
   or leak. The ciphertext is bound to its household and to a fixed `purpose` by
   **encryption context**; `Decrypt` names the expected key. The shared Lambda
   role's grant is conditioned on that `purpose`, so it can open nothing else.
   No key configured means no feature (503), never a plaintext fallback.
2. **The address never comes back out.** Responses carry `maskedUrl` (host +
   last four characters); the audit line carries the platform only; the logger
   redacts `webhookUrl` / `sealedUrl` as a backstop.
3. **Allow-list the shape, and guard the socket.** `https:` only, default port,
   no user-info, query or fragment; Discord only at `discord.com/api/webhooks`,
   Slack only at `hooks.slack.com/services`, Matrix at a public DNS name ending
   `/webhook/{id}` (matrix-hookshot's generic webhook). The SSRF guard is the
   `lookup` function handed to `https.request`, so the address checked is the
   address connected to — a separate pre-flight lookup would lose to DNS
   rebinding. Any private, loopback, link-local, CGNAT, ULA, NAT64 or
   v4-mapped answer refuses the whole name. Redirects are never followed.
4. **Posts carry plant names, task names and due dates — nothing else.** No
   notes (not even the `careRule` a sitter may see), no people, no links. The
   composer's row type has no field that could hold any of them.
5. **Fail slowly and then stop.** One attempt per channel per hourly run,
   exponential backoff to 24 hours, and the channel disables itself — with a
   reason the admin sees in settings — after three consecutive 4xx/3xx, on any
   answer from a non-public address, or after ten failures of any kind.
6. **Ride the existing schedule and timing.** The hourly reminder Lambda runs a
   fourth pass; the morning post goes out at the end of the channel's quiet
   hours or 08:00 local (`deliveryTime.ts`, the #343 rule), nothing is posted
   inside quiet hours (#809), and each post is reserved and finalized with the
   reminder markers' lease so it goes out once.

## Consequences

- One KMS key per environment ($1/month + $0.03 per 10k requests) and an IAM
  statement on the shared Lambda role. Both are Terraform and take effect on the
  next `v*` tag deploy. The environment variable reaches only the `households`
  and `reminders` Lambdas; the IAM grant, because the role is shared, reaches
  all of them — the encryption-context condition is what scopes it.
- Deleting the key (30-day window) makes every stored webhook undecryptable;
  households would have to reconnect.
- A Matrix homeserver without hookshot, or one on a non-default port, cannot be
  used. That is the price of an allow-list the Lambda can trust.
- The member-named household events the issue listed ("Sam completed 4 tasks",
  "Ana is covering") are not posted: they name people, and a family chat can
  include people the household would not hand that to. The channel carries the
  morning list and the weekly up-for-grabs post only.
- #665 (outbound signed webhooks) can reuse the transport and the SSRF guard;
  its secret is verify-only and does not need this key.
