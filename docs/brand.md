# Brand

Short reference for tone, voice, palette, and the visual marks. Lives next to the product so design and copy decisions don't drift.

## Voice

> Warm, practical, never preachy.

We are the friend who reminds you the plant on the kitchen counter is wilting, not the one who lectures you about chlorophyll. Specifically:

- **Use "you" and "your"** — direct, second-person. "Your plants" not "the user's plants."
- **Action verbs over abstractions** — "water Monstera" beats "task assignment." Buttons say what happens: "Add task", "Remind me", "Skip this week."
- **Brief without being curt** — confirm dialog: "Remove Bob from this household? Plants stay; Bob loses access." Not "Are you sure you want to remove member from household? Plants will be retained."
- **Light humor at the edges** — empty states, plant-name generator. Never in error messages or confirmations. ("Sir Reginald von Verdant" is fine on the AddPlant page; an error toast that says "Whoopsie!" is not.)
- **Plain words first, jargon second** — "schedule" not "cron", "due date" not "next-due timestamp." Internal docs can be technical; user-facing copy stays plain.

## Tone in error states

| Don't say                | Do say                                      |
| ------------------------ | ------------------------------------------- |
| "An error has occurred." | "We couldn't save that — please try again." |
| "Invalid input."         | "Email must include an @."                  |
| "Operation forbidden."   | "Only household admins can do that."        |

## Palette

Source of truth: `frontend/tailwind.config.js`. Do not rebuild this list elsewhere — reference the Tailwind classes.

- **Primary** (emerald, the plant green)
  - `primary-700` `#047857` — primary buttons, headings on light surface (passes WCAG AA against white at 5:1)
  - `primary-50`–`primary-100` — subtle backgrounds, hover tints
  - Default Tailwind green-600 (#16a34a) was 3.29:1 against white — disqualified.
- **Accent** (terracotta, the pot)
  - `accent-600` `#c8541a` — used sparingly for the brand mark and small visual flourishes; never as a CTA color.
- **Secondary** (warm yellow)
  - `secondary-500` `#eab308` — celebratory states (task completed, achievement unlocked)
- **Surface neutrals** — Tailwind defaults `gray-50`/`gray-900`. Body text on white is `gray-900`. Decorative gray for descriptions is `gray-600` (4.5:1 vs white). Avoid `gray-400` and `gray-500` on white — they fail contrast.

## Mark

The single PNG/SVG asset is `frontend/public/plant.svg` — a potted plant with two intertwined leaves and a small heart accent at the rim. The two leaves represent the two halves of a household sharing care; the heart is the family bit. The pot is terracotta `accent-600` to differentiate from generic green-leaf icons.

When using the mark:

- Always with at least 8px clear-space around it.
- On dark surfaces, no inversion — the colors are saturated enough to read at small sizes against gray-900.
- Don't recolor. The leaves are emerald, the pot is terracotta. That's the whole identity.

## Iconography

Heroicons (outline) for in-app UI. Custom illustrations live in `frontend/src/components/illustrations/` — each is an inline SVG component, not an `<img>`, so it inherits theme colors and ships zero extra requests.

When you need a new illustration:

1. Use the same emerald/terracotta palette.
2. Keep stroke weights consistent (2-3px depending on viewbox).
3. Add subtle yellow accents (`secondary-500`) for "moments" — sun rays, sparkles, etc.
4. Test in dark mode before merging.

## Typography

System font stack with **Inter** as the preferred web font (configured in `tailwind.config.js`). Inter has both warmth and neutrality at small sizes. We do not currently load Inter from a CDN — it falls back to whatever system stack the browser provides. If we add a webfont in the future:

- Load via `font-display: swap`
- Subset to Latin + Latin-Ext to keep file size under 30 KB
- Preload via `<link rel="preload">` so the LCP doesn't block on it

## Naming

- **App name**: "Family Greenhouse" (two words, both capitalized, no hyphen)
- **Plans**: Seedling / Garden / Greenhouse — botanical progression, no superlatives ("Pro" / "Enterprise" feel corporate)
- **In-app objects**: lowercase in copy. "Add a plant" not "Add a Plant"; "complete this task" not "Complete this Task."

## What we don't do

- We don't say "amazing" or "incredible" or "powerful." Those are filler words.
- We don't use stock photography of beaming families. Illustrations only.
- We don't claim numbers we can't back up. The `12,000+ families` line on the marketing page is currently fake — the testimonials section is hidden behind `VITE_SHOW_TESTIMONIALS` and the stat will move there too once it's real.
- We don't use a custom font in the logo lockup. The wordmark is set in Inter Bold so we can render it in any context without licensing concerns.
