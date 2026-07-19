# Family Greenhouse brand

This is the source of truth for voice and visual decisions. Export dimensions and file names live in [brand-kit.md](brand-kit.md).

## The idea

Family Greenhouse helps people care for plants together. The identity is built around one literal image: **two different plants sharing one greenhouse**. It communicates the product name, household collaboration, and steady growth without relying on a generic single leaf.

The visual character is a **sunlit greenhouse journal**: calm, practical, lightly handmade, and structured by panes rather than decorative card grids.

## Voice

> Warm, practical, never preachy.

- Use “you” and “your.” Say “Your plants,” not “the user's plants.”
- Prefer actions to abstractions. “Water Monstera” beats “task assignment.”
- Be brief without becoming curt. Explain consequences in plain language.
- Use light humor at the edges—empty states and name ideas—not in errors or confirmations.
- Use product words people recognize: “schedule,” “due date,” “quiet hours.”

Errors say what happened and what to do next:

| Avoid                    | Use                                       |
| ------------------------ | ----------------------------------------- |
| “An error has occurred.” | “We couldn't save that—please try again.” |
| “Invalid input.”         | “Email must include an @.”                |
| “Operation forbidden.”   | “Only household admins can do that.”      |

## Palette

The implementation source is `frontend/tailwind.config.js`.

| Token      | Hex       | Role                                                   |
| ---------- | --------- | ------------------------------------------------------ |
| Forest     | `#173404` | Native chrome, sidebars, launch screens, deep surfaces |
| Canopy     | `#27500A` | Display text, frames, high-contrast ink                |
| Leaf dark  | `#3B6D11` | Strokes and secondary brand text                       |
| Leaf mid   | `#639922` | Plant fills and selected states                        |
| Leaf light | `#97C459` | Highlights and growth moments                          |
| Glass      | `#DDEEE7` | Greenhouse panes and illustrated surfaces              |
| Dew        | `#B7D9D1` | Quiet borders and structural lines                     |
| Paper      | `#F7F8F2` | Main daylight surface                                  |
| Parchment  | `#EEF1E6` | Secondary surface                                      |
| Terracotta | `#DC6C1F` | Pots, thresholds, and one small warm accent            |

Terracotta is not a second primary color. Use it to direct attention once, not on every card.

## Typography

- **Display and wordmark:** Bitter Variable, usually 400–600.
- **Body and interface:** Instrument Sans Variable, usually 400–600.
- **Utility labels:** Instrument Sans, small uppercase with deliberate tracking.

Use Bitter's variable weight range deliberately: keep the wordmark and editorial headings at 400, and reserve heavier weights for hierarchy rather than decoration.

## Mark system

The greenhouse is the single master mark across the web app, PWA, social cards, iOS, and Android.

- `icon.svg`: pale daylight plate for light surfaces and browser favicons.
- `icon-on-green.svg`: forest plate for maskable, app-store, and native launcher contexts.
- `logo.svg`: stacked mark and wordmark on a transparent/light context.
- `logo-dark.svg`: stacked mark and wordmark on forest.

The icon must retain the greenhouse frame, shared threshold, and two plants. At small sizes, remove secondary pane detail before removing the two-plant silhouette.

## Layout signature

Greenhouse panes are structural, not confetti. Use diagonal rooflines and vertical mullions to frame a hero, launch screen, navigation rail, or empty state. Do not put the grid behind dense text at full contrast.

One composition should carry the personality of a page. Everything around it stays quiet.

## Illustration and imagery

- Custom UI icons use `currentColor`, round caps, and a 1.4–1.5 unit stroke on 24/32-unit grids.
- Empty-state art uses the forest/leaf/glass/terracotta palette and a common 240×180 greenhouse frame.
- Real user plant photos are the best imagery when available.
- When a photo is absent, use the shared greenhouse specimen placeholder—not an emoji or faint gray outline.
- Do not use stock photos of smiling families. The product and plants are the protagonists.
- Never place decorative patterns across social-card copy.

## Asset generation

Vector sources are authoritative. Regenerate all raster derivatives with:

```sh
cd frontend
./scripts/render-brand-assets.sh
```

The script requires `rsvg-convert` and `ffmpeg`, and updates web/PWA exports plus iOS and Android launcher/splash art.

## Accessibility

- Maintain WCAG AA contrast for all copy and controls.
- Keep controls at least 44×44 CSS pixels.
- Decorative SVGs are `aria-hidden`; meaningful marks have a concise accessible name.
- Respect reduced motion.
- Never encode care status with color alone.

## Naming

- App: “Family Greenhouse”
- Tagline: “Grow together”
- Plans: Seedling / Garden / Greenhouse
- Interface labels use sentence case: “Add plant,” not “Add Plant.”

## What we do not do

- No fabricated testimonials or adoption numbers.
- No filler claims such as “amazing,” “powerful,” or “revolutionary.”
- No alternate leaf, heart, or third-party placeholder marks.
- No synthetic serif styles; use Bitter Variable's loaded weights and true italic.
- No busy pattern behind copy.
