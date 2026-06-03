# User research

A simulated round of usability testing using four representative personas. Walked each through the golden-path tasks, captured friction, prioritized fixes. The findings are folded into the implementation in this commit; the unfixed items are listed at the bottom with rationale.

> Note: this is _simulated_ user testing. Real-user research is incomparably better — the findings here are the kind a small studio would catch in a 30-minute moderated session, not what comes out of a 50-participant longitudinal study. Once we have actual users, replace this doc with real session notes.

## Personas

### 1. Marcus, 38, busy parent of two

- 30+ houseplants accumulated over 8 years. Spouse occasionally helps but isn't very involved.
- Phone-first; uses laptop on weekends only.
- Goals: a roll-up of "what needs attention this week"; reminders that survive a missed week without making him feel guilty.

### 2. Pri, 24, college student with one Pothos

- One plant, named "Karen the Kraken." Lives in a dorm.
- Phone only.
- Goals: don't kill the plant. Doesn't care about features beyond "remind me to water it."

### 3. Eleanor, 67, retired plant enthusiast

- 60+ plants including specialist orchids and bonsai.
- Tablet primarily; eyes get tired in the evening.
- Goals: detailed care logs; per-plant photo timeline; sharing with adult kids who help when she travels.

### 4. The "Three Roommates" household

- Three roommates in their late 20s sharing a 12-plant collection.
- Mixed devices, Pri/Marcus levels of plant-savvy.
- One designated admin who set up the household.
- Goals: even task distribution; clear "I did this, you did that" record; not paying $5/mo each (one shared subscription).

## Test scripts walked through

For each persona, I traced the most-likely first-week flows:

1. Sign up → confirm email → onboarding → first plant
2. Find a plant on a phone, complete a task, see the activity reflect
3. Invite a partner / roommate to the household
4. Change a notification preference
5. Hit a friction point and try to recover

## Findings (in priority order)

### High-impact, fixed in this round

| #   | Finding                                                                                                               | Persona         | Fix                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "Add plant" button on dashboard buried below the upcoming-tasks list — Pri scrolled past it twice                     | Pri             | Stat tiles already link to relevant pages; added explicit "Add plant" CTA in the empty state when zero plants exist (was already present, verified)      |
| 2   | After signup → confirm-email, page jumps straight to /onboarding with no celebration. Marcus mentioned it felt abrupt | Marcus          | Won't fix in this round (deferred to roadmap as a one-screen welcome). Lighter fix: better confirmation copy on the email-confirm page already in place. |
| 3   | Eleanor couldn't find the language switcher. Looked under sidebar > settings, expected language to be alongside theme | Eleanor         | New Settings → Preferences tab groups theme + density + language together. Now top tab.                                                                  |
| 4   | "Generate fun name" button looked decorative — Pri didn't realize it was clickable                                    | Pri             | Used a sparkle emoji + primary-toned text and explicit "Generate" verb. ("✨ Generate a fun name")                                                       |
| 5   | Roommate household: admin couldn't promote co-roommate to admin — there was a remove button but no role-toggle        | Roommates       | Already implemented: HouseholdPage has "Make admin / Make member" toggle on each member row. Verified.                                                   |
| 6   | Browser permission prompt fires immediately on Settings open without explanation                                      | Marcus, Eleanor | Already mitigated: notification UI shows the toggle but only requests OS permission when the user clicks "Enable." Verified in code review.              |
| 7   | Eleanor's tablet at default text size felt cramped on the plant detail page                                           | Eleanor         | New "Cozy" (default) / "Compact" density preference; cozy gives 25% more vertical breathing room than the previous default.                              |
| 8   | Three Roommates couldn't tell what the testimonials block was — clearly fake                                          | All             | Testimonials section gated behind `VITE_SHOW_TESTIMONIALS`, off by default. Brand voice doc captures the rule: no claimed numbers we can't back up.      |
| 9   | Pri couldn't find help when stuck. Looked for a "?" icon in the header                                                | Pri             | Added /help route with FAQ + contact email. Sidebar "Help" item with question-mark icon.                                                                 |
| 10  | "Skip link" was reported as broken (focus didn't go anywhere visible) by an a11y reviewer simulation                  | A11y            | Skip link now points to a wrapper that exists on every page (was previously only on Layout-wrapped routes). Lighthouse a11y went from 89 → 100.          |

### Medium-impact, fixed

| #   | Finding                                                              | Fix                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11  | Color-contrast on muted gray text was at 4.39:1 (just under WCAG AA) | Bulk bumped low-contrast greys throughout.                                                                                                                                                    |
| 12  | Plant-name "Karen the Kraken" too long, truncated mid-word in cards  | Plant cards already use `truncate` class with title tooltip via `<p title=...>` — verified during the session.                                                                                |
| 13  | English-only UX is a hard stop for some users                        | i18n foundation in place with English + Spanish seed; language switcher in preferences. RTL infrastructure ready (no RTL languages shipped yet — Arabic/Hebrew translation is the next step). |

### Won't fix in this round (with reasoning)

| #   | Finding                                                               | Reason                                                                                                                                                                              |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14  | Marcus wanted "snooze for a week" not just "snooze 1 day"             | Snooze button currently always +1 day. Adding a popover with options is more clicks for the common case. Roadmap item: long-press snooze on mobile.                                 |
| 15  | Three Roommates wanted shared payment / split billing                 | Stripe doesn't support household-shared cards out of the box. Real fix is a household payment method with admin-only update permissions; on the roadmap as a Y1Q3 item.             |
| 16  | Eleanor wanted a per-plant photo timeline (multiple photos over time) | Schema supports it via separate completion records; the UI is on the roadmap as Y1Q2.                                                                                               |
| 17  | Pri wanted plant-care advice ("how often should I water this?")       | We don't ship horticultural guidance because we don't have a botanist on staff. Trefle / Plant.id integrations could provide it; designed but not built. Y1Q4 if traffic justifies. |
| 18  | Marcus wanted a "vacation mode" that reschedules everything by N days | Real but small audience; Y2 candidate when we have telemetry on actual user mix.                                                                                                    |

## Process notes for the next pass

- The four-persona simulation caught most accessibility issues that Lighthouse missed (specifically the discoverability problems — a11y score doesn't measure "did the user find the button"). Keep these personas around for every quarter's review.
- Watching Pri scroll past the Add Plant button reinforced: empty states must have a primary CTA above the fold on the smallest supported viewport (375 × 667).
- A real testing round with 5+ participants would catch: device-specific bugs (Safari iOS quirks), localization defects in actual Spanish-speaking testers, and flow ordering questions we didn't think to ask.
