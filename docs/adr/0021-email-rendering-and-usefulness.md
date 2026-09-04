# 0021. HTML email, localized, with one-click unsubscribe

**Status:** Accepted (2026-09-03)

## Context

Every email this product sends is plain text with no HTML alternative, no
links to the thing it is about, and no unsubscribe. `services/emailNotifier.ts`
said why, and the reason was a real one:

> Plain-text body. We deliberately don't ship HTML email yet — keeps the
> templating story simple and avoids a whole class of phishing spoof.

`docs/notifications.md` added two more: templating overhead is not worth it for
a household app, and email clients render plain text fine.

Three years of that decision produced this. The weekly digest — the email with
the most product surface — is, verbatim:

```
Your weekly Family Greenhouse check-in.

7 plants could use some catch-up care. Here are the 5 waiting longest:

1. Monstera — water waiting 6 days for some care
...
A few minutes of care goes a long way. Your plants thank you!
```

**There is not one URL in it.** `plantId` is on every row of the data
structure that produced those lines and is never turned into a link. The
annual recap is the same. The recipient must remember the app exists, find it,
log in, and re-locate five plants by name. Meanwhile:

- **Deliverability.** `SendEmailCommand`'s API surface is `Source` /
  `Destination` / `Message`. It cannot set a single custom header, so
  `List-Unsubscribe` was not merely absent — it was unreachable. Gmail's and
  Yahoo's bulk-sender rules make RFC 8058 one-click unsubscribe effectively
  mandatory for exactly the mail we send weekly, and the product's own help
  copy admits the gap: _"our emails have no unsubscribe link today, which is a
  gap we'd rather name than hide."_
- **Localization.** There was no locale field anywhere the backend could read.
  `NotificationPreferences` had no language; Cognito's schema adds only
  `household_id` and `household_role`; the i18n catalogs are frontend-only. A
  Spanish speaker could run the entire UI in Spanish and receive every email in
  English. English grammar was baked into the _logic_, not just the strings
  (`total === 1 ? 'plant' : 'plants'`), which Spanish's `_many` category cannot
  express.

## Decision

### 1. Multipart HTML + plain text, via `SendRawEmailCommand`

Every email may now carry both parts. The text part is generated from the same
block list as the HTML by its own rules — underlined headings, indented detail,
each row's URL on its own line — so it is a genuinely readable document, not
HTML with the tags removed. A message with no HTML part is still valid and
still sends; adopters convert one at a time.

**Why `SendRawEmailCommand` and not SESv2.** Both were viable. SESv2's
`Content.Simple.Headers` accepts custom headers and assembles the MIME for you,
which is the one thing raw MIME costs us. Against that: it means adding
`@aws-sdk/client-sesv2` to a Lambda bundle whose environment is deliberately
minimal, while `ses:SendRawEmail` is _already_ in the IAM policy
(`infrastructure/modules/api/main.tf`) so raw needs no infrastructure change at
all. The MIME we actually need is 80 lines with three rules — base64 both
bodies so nothing is 8-bit or over-long, RFC 2047 the Subject, CRLF everywhere
— each with a unit test. We took the zero-dependency path.

We would revisit if we needed SES's newer per-message features (v2-only
tenancy, list management, message insights) or if the MIME builder started
growing attachments or `multipart/related` inline images. It should not: we do
not attach files and we do not inline images.

### 2. The phishing rationale, answered rather than dismissed

The old comment was right that HTML email opens a class of spoof risk. It is
being reversed, so each part of it gets a specific mitigation, not a wave:

| Risk                                                               | Mitigation                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User-supplied content interpreted as markup                        | `renderEmail` escapes **every** interpolated value — element content and attribute alike — through one `escapeHtml`. There is no "trusted HTML" parameter anywhere in the module; a caller cannot opt out. Plant names, notes, member names and space names are all user-supplied and all go through it. Tested with a `<script>`-shaped plant name. |
| Remote image loads (tracking pixels, spoofed logos, IP disclosure) | The only `<img>` we ever emit is a plant photo, and only after `isOwnAssetUrl` confirms it is on our own asset origin under our own path prefix. Anything else is dropped, not fetched. There are no tracking pixels, no external CSS, and no web fonts.                                                                                             |
| A template that trains people to enter credentials                 | No email asks for a password, a payment detail, or any credential; every email carries a standing footer line saying we never will. No template imitates a login screen, contains a password field, or renders a form of any kind.                                                                                                                   |
| A link that goes somewhere unexpected                              | Every URL is built by `services/email/links.ts` from `FRONTEND_URL` / `PUBLIC_API_URL`. `safeLinkUrl` allows only http, https and mailto; anything else degrades to unlinked text rather than rendering an anchor.                                                                                                                                   |
| Look-alike mail from a third party                                 | Unchanged and already good: SES domain identity, DKIM on three CNAMEs, SPF, and `p=quarantine` DMARC with relaxed alignment carried by DKIM.                                                                                                                                                                                                         |
| Credential-shaped links                                            | The one no-login URL we send is a capability token that can turn **one** email category off for **one** user and do nothing else. It cannot read, cannot re-enable, cannot reach another endpoint, and is revocable per user.                                                                                                                        |

The residual risk we accept: HTML mail is a richer canvas for a _future_
template to misuse. The mitigation is structural — composers choose words and
blocks, never markup — so misusing it means changing `template.ts`, which is
the file this ADR is attached to.

### 3. A small hand-rolled template kit

Header, row, button, notice, divider, footer. No template dependency: email
HTML is a 1999 subset that libraries re-learn badly, and the surface we need is
five blocks wide. Table-based layout, inline styles for everything that
matters, a `<style>` block only for what inline cannot express (the dark-mode
swap and the narrow-screen overrides), no external CSS, no web fonts, a
600px cap with a fluid fallback under 620px, and a preheader line. Every colour
is stated on both the light and dark paths, because the clients that
force-invert only invert colours you did not state.

### 4. Localization, with an explicit fallback

`emailLocale` is a new field on the preferences row: `'en'`, `'es'`, or `''`
for **never chosen**. That empty sentinel is deliberate. `timezone` has no such
state — it reads `'UTC'` both for a row nobody wrote and for a user who chose
UTC, which is the documented sharp edge behind quiet hours silently being
evaluated in the wrong zone. We did not repeat it: the settings page shows the
control _and_ back-fills the detected language on load rather than waiting for
a Save the user may never press.

`services/email/locale.ts` is the accessor every composer calls. The chain is
recipient → household (the most common language its members chose, ties broken
by earliest joiner) → English, and every resolution carries the **source** that
produced it, so `source: 'default'` is a countable signal that English was a
guess rather than a choice.

The catalog lives in `backend/src/services/email/catalog.ts`, not in the
frontend i18next catalogs, because a Lambda cannot reach across the workspace
boundary without shipping the whole app catalog into every email function. ADR
0007 still governs the frontend catalogs. **The consequence must be stated
plainly: every i18n CI gate scans `frontend/` only, so no CI gate sees this
file.** Its guard is `backend/tests/unit/services/email/catalog.test.ts`, which
enforces the same three rules — key parity, placeholder parity, and exactly the
CLDR plural categories each locale requires — and runs inside `npm run verify`.
Plurals go through `Intl.PluralRules` and numbers and dates through
`Intl.NumberFormat` / `Intl.RelativeTimeFormat`, so no template hard-codes a
grammar rule.

### 5. `List-Unsubscribe` + `List-Unsubscribe-Post` on non-transactional mail

Every recurring email carries both headers, pointing at a revocable capability
URL that switches off that one category with no login. Transactional mail
(welcome, and any future password or billing message) keeps its own path and
carries neither.

The capability secret is random, per user, and stored on its own row
(`USER#{id} / EMAILCAP`) — **not** as an attribute on `PREFS`, because
`getPreferences` treats a present row as authoritative and coerces missing
attributes with `Boolean(item.email)`; an upsert that created that row to hold
a secret would hand the user a preferences record with email **off**, silently
unsubscribing them from everything. Revocation is one write.

**Why this is not one of the credentials the repo already has.** By the time
this landed the codebase carried three: `fg_` API keys, sitter links, and (from
#399) calendar-feed tokens. All three are _stored_ — a row per token, hashed at
rest with `scryptSync` and a fixed salt, looked up by hash, revoked by deleting
or overwriting the row. That shape is right for a credential a person mints
once, keeps, and may want to see the status of. It is the wrong shape here:
this token is minted per message, for mail that may sit unread for months, and
a stored row per email sent is a write and a row we would never read again for
the overwhelming majority of messages. So the token is stateless — an HMAC over
(user, category, expiry) — and revocation is rotating the one per-user secret,
which is the same _effect_ as deleting rows without the per-message cost. It
opens nothing the stored credentials open: not the calendar feed, not the
sitter view, nothing under `/api/v1`, and it cannot even read the preference it
turns off.

`GET` renders a confirm form and mutates nothing — mail clients and corporate
link scanners fetch every URL in a message, and a mutating GET would
unsubscribe people who never clicked. `POST` performs it, and is also what a
provider's automated one-click hits.

The landing page is deliberately **unstyled semantic HTML**. The API stamps
`Content-Security-Policy: default-src 'none'` on every response, so `style-src`
falls back to none and an inline style attribute is dropped. Loosening a
security header so an unsubscribe confirmation could have rounded corners is a
bad trade; the page is legible as it is.

### 6. Deep links everywhere, through one builder

`services/email/links.ts` is the only place an email builds a URL. A plant
links to that plant. The one thing it cannot go deeper than is an individual
task: the SPA has no `/tasks/:id` route, so `taskUrl` resolves to the task's
own plant and carries `?task=` as a forward hook the plant page can honour
later without any email changing.

**Explicitly out of scope: one-click "mark done" from the email.** It needs a
capability token scoped to a single task, and the `plant-tags` work (#424) is
building exactly that primitive right now. The natural follow-up is to reuse
the tag token and add a `complete` verb to the capability module rather than
stand up another credential beside it — the repo is already at four, which is
where that stops being free.

## Consequences

- Email is 8–15 kB per message instead of 1–2 kB. At SES's $0.12/GB that is
  fractions of a cent per household per year; the $0.10 per thousand messages
  dominates and is unchanged.
- Two bodies to keep honest. The text part is generated from the same blocks,
  so they cannot drift in content — only in layout, which is the point.
- The backend now has a string catalog. It is small and guarded by its own
  test, but it is a second place translations live, and a native-Spanish review
  of email copy is now owed alongside the UI's.
- `emailLocale` is a new preference field. Clients that predate it omit it, and
  the writer preserves the stored value rather than wiping it.
- The unsubscribe endpoint is public. It is IP rate-limited, the token is
  bounded to one category for one user, and a failed capability read returns
  503 with "nothing has been changed" rather than telling a recipient their
  link is bad — reporting a failed read as a fact is this repo's named defect
  class (ADR 0010) and the unsubscribe promise is the worst place to break it.
- Still text-only, pending adoption: the pest-alert payload, which flows
  through `notifier.sendToUser`'s generic `{title, body, url}` shape rather
  than a composer. It sends valid mail unchanged; converting it means giving
  the notifier a structured payload, which belongs with whoever next touches
  that path. (#427 rewrote the reminder path in parallel and owns it.)
- PR #418's `recipientLocale` returns English unconditionally and says so in
  ADR 0018's Consequences. That is now a one-line change to
  `resolveEmailLocaleForUser` once both land.
