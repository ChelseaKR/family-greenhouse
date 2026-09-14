# Paid acquisition readiness — Google Search + Meta

**Status: planning + code-readiness only. No ad account exists, no money has been spent, nothing has been submitted to any ad platform.** This document is what needs to be true code- and content-side for Chelsea to go from "I created a Google Ads / Meta account" to "the campaign is live" with nothing left to build. Every claim below is checked against the actual code (file/line references given); nothing is invented.

Context: organic search sends Family Greenhouse almost no traffic (381 impressions over 3 months per Search Console). Paid registration is open and card payments are live (`commercial-status.json`, effective 2026-09-01), so paid acquisition is now a real lever. This is a consumer, visual, household product — a different shape than gtfs-scorecard's B2B lane — so it fits Meta (feed/story creative, family/home targeting) as well as Google Search (intent-driven, caring-adjacent terms).

---

## 1. Keyword research (Google Search)

Rule followed throughout: **no keyword targets a capability the product doesn't have.** Every row below is grounded in a real, shipped feature (file reference given) and states which plan tier it's actually on, so a click never lands on a promise the app can't keep.

### Tier 1 — best fit: specific pain point, real feature, likely affordable (long-tail, lower competition than generic "plant care app")

| Keyword                                                         | Real feature it matches                                                                                                                                                                                                       | Plan availability                                                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| "shared plant watering schedule app"                            | Per-plant reminders + shared household view, activity log (`frontend/src/features/landing/LandingPage.tsx` features: "Reminders per plant", "Shared, with names attached")                                                    | Free (Seedling) and up                                                                                                                  |
| "who watered the plants app"                                    | Household activity log settling "who did what" (same feature, `HouseholdSproutsIcon` card copy)                                                                                                                               | Free and up                                                                                                                             |
| "plant care chore chart for roommates"                          | Task assignment / claim, same activity log                                                                                                                                                                                    | Free and up                                                                                                                             |
| "app to split plant care with roommates"                        | Task assignment (`personas` array, "Sharing a place": "Assign tasks or leave them up for grabs")                                                                                                                              | Free and up                                                                                                                             |
| "vacation plant care checklist app"                             | Away Kit handoff brief, `frontend/src/features/sitter/SitBriefPage.tsx`                                                                                                                                                       | Garden ($4.99/mo)                                                                                                                       |
| "who waters my plants while I'm away app"                       | No-account sitter link, `frontend/src/features/sitter/SitPage.tsx` — sitter opens `/sit/{token}`, sees due tasks, taps Done, no signup                                                                                        | Free (1 link, 7 days) and Garden (up to 90 days, 10 concurrent — `backend/src/models/plans.ts` `sitterLinkMaxDays`/`sitterLinksActive`) |
| "house sitter plant watering instructions app"                  | Same sitter link + printable handoff brief                                                                                                                                                                                    | Garden for the brief; base link is free                                                                                                 |
| "is [plant name] toxic to cats" / "pet safe houseplant checker" | `/pet-safe` — free, no-signup, type a name, get a verdict sourced verbatim from the ASPCA (`frontend/src/features/petsafe/petSafeSpecies.ts`, `PetSafePage.tsx`'s meta description: "Based on the ASPCA's plant safety data") | Free, no account                                                                                                                        |
| "toxic houseplants for dogs list"                               | Same `/pet-safe` checker, 24 species                                                                                                                                                                                          | Free                                                                                                                                    |

### Tier 2 — real feature, somewhat broader/more competitive, still honest

| Keyword                               | Real feature                                                                                                                 | Plan                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| "plant care app for beginners"        | `/care` guide library + "New and a little nervous" onboarding persona                                                        | Free                                                                       |
| "beginner plant watering reminders"   | Per-plant schedule + species suggestion at Add Plant                                                                         | Free                                                                       |
| "import plant collection spreadsheet" | CSV/JSON bulk import, `frontend/src/features/plants/ImportPlantsPage.tsx`                                                    | Free and up (200-plant cap starts on Garden)                               |
| "plant care app multiple households"  | Cross-home Today, kiosk, caretaker seats                                                                                     | Greenhouse ($9.99/mo) only — do not target this term on a Garden-priced ad |
| "plant identification app"            | Photo ID via Plant.id integration, `$1.99` top-up pack beyond the included allowance (`backend/src/models/identifyTopUp.ts`) | Free allowance + paid top-up                                               |

### Tier 3 — narrower, likely low volume, worth a small test budget only

| Keyword                            | Real feature                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| "weather aware plant watering app" | Skips a watering when rain/cold is forecast (`differentiators` "Weather-aware nudges") |
| "leaf problem identifier app"      | Leaf-health photo check                                                                |
| "propagation tracking app"         | "Share a cutting" — cutting-share links                                                |

### Deliberately NOT targeted

- **"plant care app" / "plant app" (bare, generic)** — highest competition (Planta, Vera, Greg, Blossom all bid here), least differentiated message, most expensive CPC for the least-qualified click. The product's actual edge is coordination + sitter handoff + honest pet-safety data, not "an app that tracks plants," so bare-generic terms buy clicks the landing page then has to win cold rather than clicks that already want what's shipped.
- **Anything about a native mobile app store listing** ("plant care app iOS/Android") — the web product is what a Search/Meta click lands on; don't bid a term whose intent is "take me to the App Store" if the ad sends them to the website.
- **"caretaker seats" / "kiosk" / API-key language** — real Greenhouse features, but not language any consumer searches; internal product vocabulary, not keyword copy.

---

## 2. Meta (Facebook/Instagram) ad creative direction

Four concrete briefs. Each names the real screenshot to take, the hook, and the CTA — not final creative (an image-generation tool can't be run from here), but specific enough for Chelsea or a designer to execute in under an hour each.

### Creative 1 — "I thought you watered it." (household friction)

- **What's shown:** A screenshot (or a clean re-creation) of the household task list / activity log — the same content as `AppMockup`'s "Family activity" card in `LandingPage.tsx` (who watered/added/repotted what, with initials and timestamps).
- **Hook line:** _"I thought YOU watered it."_ — this is the app's own existing hero headline (variant A, `heroCopy.A` in `LandingPage.tsx`), already tested copy, reused here rather than inventing new language.
- **Supporting line:** "One shared schedule. Everyone sees what's due, what's done, and who did it."
- **CTA:** "Start free — no card needed"
- **Format:** Single image or 3-slide carousel (empty task list → tasks assigned → activity log at end of week).

### Creative 2 — "Send your sitter a link. Not a lecture." (vacation/away)

- **What's shown:** A phone mockup of the actual `/sit/{token}` page — the plain, no-account task list a sitter sees ("Water the Monstera," "Due today"), per `frontend/src/features/sitter/SitPage.tsx`.
- **Hook line:** _"Going away? Send your sitter a link — no app, no account, no confusion."_
- **Supporting line:** "They see exactly what's due. You see exactly what got done."
- **CTA:** "Try it free" (the base sitter link is on every plan, including free — honest, no upsell-only claim)
- **Format:** Two-panel: "You" side (setting the away dates) / "Them" side (the sitter's plain checklist).

### Creative 3 — "Is your [common houseplant] safe around your cat?" (pet safety, curiosity hook)

- **What's shown:** The `/pet-safe` search box + a real verdict card for a common, high-search-volume plant (pothos or monstera), showing the toxic/non-toxic badge exactly as `PetSafePage.tsx` renders it.
- **Hook line:** _"Is your [Pothos] safe around your cat?"_ — genuinely curiosity-driven and honest: the underlying data is real (ASPCA-sourced, verbatim from the care guide, verified in `petSafeSpecies.ts` — not a marketing invention).
- **Supporting line:** "Free checker, no signup. Sourced from the ASPCA's plant safety data."
- **CTA:** "Check your plants" → lands on `/pet-safe` directly, not the homepage (see §4 on ad-to-landing-page match).
- **Format:** Static image works well here; a short video of typing a plant name and watching the verdict appear would perform even better on Instagram/Reels.
- **Guardrail:** rotate the featured plant per audience (cat owners vs. dog owners) rather than one static claim — the checker covers both.

### Creative 4 — "Five minutes to never wonder again." (onboarding / nervous beginner)

- **What's shown:** The three-step "How It Works" sequence already on the landing page (add plants → invite household → split the work), or a simple screen-recording GIF of the Add Plant flow.
- **Hook line:** _"Add a plant. Get a schedule. Never wonder again."_
- **Supporting line:** "Free for one home, up to 3 people and 20 plants. About five minutes to set up."
- **CTA:** "Sign up free"
- **Format:** Best as a short (6–10s) screen-capture video ad; static carousel as a fallback.

---

## 3. Google Search ad copy drafts

Four variants, one per keyword theme from §1. Character-counted against Google's limits (headlines ≤ 30 chars, descriptions ≤ 90 chars) — every string below was verified with a length check before being written here, not eyeballed.

All prices are read from `backend/src/models/plans.ts` at the time of writing: Seedling is free (1 home / 3 members / 20 plants), Garden is **$4.99/mo** (annual and lifetime cadences are currently withdrawn from sale per `withdrawnIntervals` — **do not advertise an annual or lifetime price**, only the monthly figure is actually being sold today).

### Variant A — Household / shared reminders

- H1: `Shared Plant Care App` (21)
- H2: `Free, No Card Needed` (20)
- H3: `Reminders Everyone Sees` (23)
- D1: `Reminders, tasks, and a shared log for your whole household. Free to start.` (75)
- D2: `Up to 20 plants, 3 people, no card needed. Garden plan adds more for $4.99/mo.` (78)

### Variant B — Vacation / sitter coordination

- H1: `Covered While You Travel` (24)
- H2: `Vacation Plant Care` (19)
- H3: `No-App Sitter Links` (19)
- D1: `Send a sitter a link, no app or account needed. They see tasks, you see it's done.` (82)
- D2: `Plan windows up to 90 days on the Garden plan ($4.99/mo). Free plan covers a week.` (82)

### Variant C — Pet safety checker

- H1: `Is This Plant Pet-Safe?` (23)
- H2: `Free Cat & Dog Checker` (22)
- H3: `ASPCA-Sourced Data` (18)
- D1: `Type a houseplant name, see if it's toxic to cats or dogs. Free, no signup needed.` (82)
- D2: `Verdicts sourced from the ASPCA's plant safety data, plain language, 24 species.` (80)

### Variant D — Free tier / beginner onboarding

- H1: `Plant Care, Made Easy` (21)
- H2: `Free for 3 People` (17)
- H3: `Start in 5 Minutes` (18)
- D1: `Add a plant, invite your household, done in about five minutes. Free to start.` (78)
- D2: `Free for 1 home, 3 people, 20 plants. Garden plan unlocks more for $4.99/mo.` (76)

**Ad-to-landing-page match** (Quality Score, and honesty): Variant C should route to `/pet-safe`, not the homepage — that page already exists, is free, no-signup, and answers the ad's promise in one screen. Variants A, B, D route to `/` (the homepage carries the signup CTA and full pricing). See §4.

---

## 4. Landing page review — cold paid-traffic pass

Reviewed `frontend/src/features/landing/LandingPage.tsx` as a first-time visitor from an ad, not a returning/organic one.

### What's already good

- Price and free-tier limits are accurate and match `plans.ts` exactly (checked the "product facts" band, the `SoftwareApplication` JSON-LD `offers`, and the meta description against the catalog — no drift).
- No fabricated numbers — the file's own comment notes a prior "50,000+ Happy Plants" claim was removed as fabricated; nothing similar has crept back in.
- Full pricing is visible on the same page (`#pricing` anchor renders `PricingGrid`, which fails closed to a status notice rather than ever showing a stale/wrong price) — a cold visitor doesn't have to hunt for cost.
- Free vs. paid is represented honestly: the product facts band, the JSON-LD offer, and the plan grid all agree on "free for 1 home, 3 people, 20 plants," and nothing implies the paid tiers unlock something they don't.

### Fixed in this pass

- **Production showed a "Beta" badge next to the logo.** `frontend/src/lib/betaMode.ts` defaults `IS_BETA` to `true` when `VITE_BETA_MODE` is unset, and the web production build (`.github/workflows/cd-production.yml`) never set it — confirmed live via `curl https://familygreenhouse.net/` before this change. The mobile production build already pins `VITE_BETA_MODE=false`; the web build had no equivalent. For cold paid traffic landing on a product that has had public registration and real card payments since 2026-09-01, a "Beta" badge undersells trust for no honest reason — it's presentation-only (`betaMode.ts`'s own comment: "cannot enable pricing, Checkout or billing controls"), so removing it touches no commercial gate. Fixed by adding `VITE_BETA_MODE: 'false'` to the production frontend build env. **This requires a normal deploy to take effect** — it's a build-time env var, not a runtime flag.

### Noted for Chelsea (bigger, not changed here)

1. **Signup has real friction for cold traffic.** Full name + email + a 12-character password (upper/lower/number) + an emailed confirmation code, all before the app is usable (`RegisterPage.tsx`, `ConfirmEmailPage.tsx`). No social/OAuth login exists. This is a bigger lift (Cognito federation) than this pass should take on, but it's the most likely place a paid-traffic visitor abandons — worth prioritizing if paid conversion rate comes in low.
2. **The Away Kit / sitter feature isn't named on the page a "vacation" ad would land on.** The "Away a lot" persona card (in the "Who it's for" band) links to `#features`, but the Features grid itself (6 cards) never mentions sitters, handoff, or vacation coverage by name — that's only in the one persona-card sentence. A Meta or Search visitor clicking Creative 2 / Variant B lands on a page that doesn't reinforce the exact thing they clicked for. Small, deliberately **not** changed here since the features grid is mid-experiment (hero A/B test) and content changes there deserve their own review, not a drive-by edit.
3. **Match ad to landing target.** Route the pet-safety ad/creative straight to `/pet-safe` (it already exists, is free, and directly answers the ad) rather than the homepage. Noted in §3; not a code change, a campaign-setup step.
4. **"No credit card" is one scroll below the fold**, in the product-facts band right after the hero — true and close, but not literally next to the primary CTA button. Cosmetic; not fixed here to avoid touching the hero mid-experiment.

---

## 5. Conversion tracking — server-side, code-side only

### The two trusted seams

Per the task brief, conversion tracking should fire from server-side events, not a client pixel — consistent with the cookieless posture already adopted for PostHog (`docs/analytics.md`). Two seams already exist and are exactly right for this:

1. **Signup** — `POST /auth/confirm` (`backend/src/handlers/auth/handler.ts`). Once `ConfirmSignUpCommand` succeeds, the browser still holds no JWT, so this has always been a trusted backend event rather than a client one — the existing code already logs `productEvent: 'signup_completed'` here for exactly that reason (see the comment at that call site).
2. **First paid conversion** — the Stripe webhook (`backend/src/services/billing.ts`, `applyStripeEvent`). `subscription_paid` fires once a subscription transitions to Stripe status `active` from a non-active status — "the money-moved signal," per the extensive comment already in that file — gated on the same `isNew` dedupe ledger that prevents a webhook redelivery from double-counting.

Both event names are pulled **verbatim** from the existing `EventName` union (`frontend/src/services/analytics.ts`) / `ServerEventName` (`backend/src/utils/serverAnalytics.ts`) rather than invented — `signup_completed` and `subscription_paid` are already the product's own vocabulary for these two moments.

### What was built: `backend/src/utils/adConversions.ts`

A new, small, additive module — `reportAdConversion(event, props)` — called once at each of the two seams above, right next to the existing `capture()` analytics call (same guard, same fire-and-forget, never-throws contract). **It is a complete no-op today**: `GOOGLE_ADS_CONVERSION_ID` and `META_CAPI_PIXEL_ID`/`META_CAPI_ACCESS_TOKEN` are unset in every environment, and the function returns immediately — confirmed by a negative-control test (`backend/tests/unit/utils/adConversions.test.ts`) that asserts zero network calls happen with the env unset.

- **Meta Conversions API is a real, working implementation** once real values are set — it's a plain authenticated REST POST to `graph.facebook.com/v21.0/{pixel}/events`, no SDK, no OAuth dance. Sends `CompleteRegistration` for signup and `Subscribe` for the paid conversion, with a SHA-256-hashed email (`hashEmail()`) as the only identifier — the raw email is never received by, logged by, or forwarded through this module (test-asserted).
- **Google Ads Enhanced Conversions is a documented stub, not a working call.** Google's conversion-upload path needs OAuth2 (client id/secret + refresh token from the ad account owner) and a developer token that requires Google's own manual approval — none of which can exist before Chelsea creates the ad account. Shipping a guessed implementation of that request shape, untestable without real credentials, seemed worse than an honest stub with the exact next steps written down. See `docs/external-services-setup.md`'s new "Google Ads & Meta Conversions API" section for the activation steps once she has them.
- **No real ID is wired anywhere** — every env var this reads is absent from every `.env*`, every GitHub Actions workflow, and every Terraform var file (checked).

### The known gap: no click-id capture (Phase 2, not built)

Neither platform can actually **attribute** a conversion to a specific ad without a click identifier — Google needs `gclid` (or `gbraid`/`wbraid`), Meta ideally has `fbclid`/`fbc`. This app captures none of these today (confirmed: no reference to `gclid`, `fbclid`, `utm_source`, or any query-param capture anywhere in `frontend/src`). A hashed email alone lets Meta attempt probabilistic/reduced-quality matching; it gives Google Ads nothing to attribute to at all.

**Deliberately not built in this pass.** The full shape it would take:

1. On landing (`LandingPage.tsx`), read `gclid`/`gbraid`/`wbraid`/`fbclid` from the URL query string if present. Store it in `sessionStorage` (or a short-lived, first-party-only cookie set solely when a click id is present) — never a persistent third-party tracking cookie, keeping the existing cookieless posture.
2. Thread it through `authService.register()`'s payload as an optional field, alongside name/email/password.
3. Persist it briefly against the pending signup record (`backend/src/services/signupConfirmRecord.ts` already writes one row per signup — a natural place to also carry an optional click id) or the household row.
4. At the `subscription_paid` seam, read it back and pass it into `reportAdConversion`.

This is a real feature (new payload field, new storage, new read-through) rather than a one-line hook, and there are zero real ad campaigns yet to validate it against — building it now risks exactly the "gate that measures nothing" failure mode this portfolio has hit before (an attribution pipe that looks wired but never carries a real click id because nothing upstream ever populates it). Recommended as the first follow-up once Search/Meta campaigns are actually running and the basic event pipe (this pass) is confirmed working end-to-end in each platform's test-events view.

### Activation steps (owner-only, see §6/owner steps below)

Full setup instructions (where to get each credential, exactly which env vars to set, how to verify) are now in `docs/external-services-setup.md` under "Google Ads & Meta Conversions API," matching the existing pattern used for Perenual/Plant.id/Stripe/GTM in that file.

---

## 6. Budget / economics sanity check

**Everything in this section is a general-knowledge estimate for a small consumer subscription app, not a measurement of Family Greenhouse's actual performance** — this task explicitly does not read FG's real metrics, and there is no ad spend history to draw from. Treat every number as a rough planning range to replace with real numbers after the first 1–2 weeks of live spend.

### What a weekly budget plausibly buys (rough, industry-typical ranges)

| Weekly budget | Google Search (long-tail, Tier 1 terms)                  | Meta (feed/story, family/home targeting)                                             |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| $50/wk        | ~40–100 clicks (est. $0.50–$1.25 CPC on long-tail terms) | ~$8–$14 CPM → roughly 3,500–6,000 impressions; ~35–90 clicks at a typical 1–1.5% CTR |
| $100/wk       | ~80–200 clicks                                           | ~7,000–12,000 impressions; ~70–180 clicks                                            |
| $200/wk       | ~160–400 clicks                                          | ~14,000–25,000 impressions; ~140–360 clicks                                          |

Long-tail Tier 1 terms (§1) should sit toward the cheaper end of typical plant/lifestyle-app CPC ranges precisely because they're specific rather than generic — bidding the bare term "plant care app" would land at the expensive end instead, which is the main reason §1 avoids it.

### What conversion rate would need to hold to break even

Two-step funnel, since almost every signup lands on the free Seedling tier first:

1. **Click → free signup.** A clean, accurate landing page (§4) for a warm-intent long-tail click reasonably converts somewhere in a wide 2–8% range for a consumer freemium app; treat 3–5% as a planning midpoint until real data replaces it.
2. **Free signup → Garden ($4.99/mo).** Freemium consumer apps commonly convert free→paid somewhere in a 2–5% range over the first couple of months, highly dependent on how compelling the paid features are (Away Kit, plant tags, chat) — again, no FG-specific number exists yet.

Chained, a $0.75 average CPC with a 4% signup rate and a 3% paid rate implies a rough **CAC per paid subscriber around $0.75 ÷ 0.04 ÷ 0.03 ≈ $625** — which is not a typo, it's the arithmetic of small percentages compounding, and it is why the breakeven question has to be answered with a payback-period framing rather than a single-month-margin one:

- Garden nets roughly **$4.54/mo** after Stripe's ~2.9% + $0.30 (≈$0.45 on a $4.99 charge).
- A CAC of $625 would need over **11 years** of retention to pay back at $4.54/mo net — clearly not viable at these placeholder conversion rates.
- For a CAC to pay back within a defensible **3–6 month** horizon (typical target for small consumer SaaS), CAC needs to land in the **~$14–$27** range.
- Working backward: at a $0.75 CPC, that means click→signup×signup→paid needs to multiply out to roughly **2.8–5.4%** combined (e.g., 15% signup rate × ~25% eventual paid rate is one combination that clears it; so is 5% × 70%, which is unrealistic — the realistic lever is mostly the SIGNUP rate, since landing-page and offer quality move that number far more than ad copy alone).

**The actionable takeaway, not just the math:** the free tier's job in this funnel is to make the SIGNUP step cheap and high-converting (it already asks for no card and states its limits honestly, per §4) — the paid conversion then has to be earned inside the product (Away Kit, reminders that actually work) rather than bought at the ad level. A campaign that only optimizes for cheap clicks without a credible plan for free→paid conversion will not break even at these placeholder rates. **Start with a small test budget ($50–$100/wk on the Tier 1 long-tail terms), measure the real click→signup and signup→paid rates for 2–4 weeks, then redo this section's math with real numbers before scaling spend.**

---

## Owner steps (Chelsea, in order)

Nothing in this list was done by this pass — no account was created, nothing was submitted, no money was spent.

1. **Review this document.** Adjust keyword priorities (§1), creative briefs (§2), ad copy (§3), and the landing-page notes (§4) — all of it is a draft for your judgment, not a final campaign.
2. **Deploy the one code fix already merged-ready** (Beta badge off in production, §4) — a normal `main` deploy picks it up; it needs no further action beyond the usual release process.
3. **Create the ad account(s):**
   - Google Ads: https://ads.google.com — new account, link to a payment method, set a daily budget cap matching the weekly test budget in §6.
   - Meta: https://business.facebook.com — Business Manager, ad account, Page (or use the existing Family Greenhouse presence if one exists), payment method.
4. **Set a starting budget.** §6 suggests $50–$100/week per channel as a test size — small enough to read real numbers in 2–4 weeks without material risk.
5. **Get conversion tracking IDs** and follow `docs/external-services-setup.md`'s new "Google Ads & Meta Conversions API" section to wire them as backend secrets (Meta's Conversions API will work immediately once set; Google Ads Enhanced Conversions needs the additional OAuth/developer-token setup documented there before `adConversions.ts`'s stub can be completed).
6. **Review and adjust the ad copy and creative briefs** (§2, §3) — swap in real screenshots, adjust tone, and have each platform's ad review pass before launch (both platforms review ad content before it goes live; this document does not submit anything).
7. **Decide whether to build click-id capture (§5's Phase 2)** before or shortly after launch — without it, Google Ads specifically has no way to attribute a conversion to a click at all, so this is the one piece worth prioritizing early rather than deferring indefinitely.
8. **Launch**, at the small test budget, and revisit §6's math with real click→signup and signup→paid numbers after 2–4 weeks before scaling spend.
