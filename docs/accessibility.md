# Accessibility (WCAG 2.2 AA, AAA where feasible)

We commit to WCAG 2.2 **AA** as the conformance bar, and push to **AAA on the
criteria that are codeable and machine-checkable** — notably 1.4.6 Contrast
(Enhanced, 7:1), 2.5.5 Target Size (Enhanced, 44px), and 2.3.3 Animation from
Interactions. Full Level-AAA conformance is **not** claimed: several AAA
criteria (e.g. 1.4.8 visual presentation, 2.4.10 section headings, 3.1.5
reading level) are content/design judgments that can't be mechanically
guaranteed, and WCAG itself advises against requiring AAA site-wide. This
document maps criteria to where they're enforced or to a deliberate choice.

## Automated enforcement

Four layers, all gating:

1. **Lighthouse CI** runs the `accessibility` category against `/` and `/login` on every PR — both desktop and mobile. The mobile config is the tighter target. Threshold: 0.95 minimum (currently 1.00 on every page tested).
2. **Playwright + `@axe-core/playwright`** scans every public + authenticated route. Enforced tags now include the **AAA** slice axe can evaluate (`wcag2aaa`/`wcag21aaa`) — chiefly `color-contrast-enhanced` (1.4.6, 7:1) — on top of A/AA. Zero violations required. (`tests/e2e/a11y.spec.ts`, `a11y-authenticated.spec.ts`)
3. **`eslint-plugin-jsx-a11y` at `strict`** (not just `recommended`) — static analysis at lint time catches missing alt text, invalid ARIA, unlabeled controls, etc., and fails the build.
4. **`jest-axe`** structural checks on shared primitives in the unit suite (`tests/unit/a11y/components.a11y.test.tsx`) — fast feedback in jsdom (contrast, which needs layout, is left to layer 2).

**Target size (2.5.5 AAA):** the shared `Button` enforces a 44×44 CSS-px floor (`min-h-touch`/`min-w-touch`, the `touch` = 44px token in `tailwind.config`); raw interactive controls (view toggles, snooze menu items, the household-switcher add button) carry the same floor. axe does not mechanically check target size, so this is maintained by convention + review.

**Contrast (1.4.6 AAA):** body/helper text uses `gray-600`+ (≥7:1 on white), status/type badges use `text-*-900` on `*-100` tints (≥7:1), placeholders are `gray-500` (AA — placeholders are never the only label, so AAA is not required of them). The AAA axe gate (layer 2) flags any regression on real pages.

Authenticated routes are covered too. `tests/e2e/a11y-authenticated.spec.ts` logs in via the local-server seed account (`test@example.com`) before scanning `/dashboard`, `/plants`, `/plants/:id`, `/tasks`, `/household`, `/settings`, `/analytics`, and `/help`. This suite runs against the local-server (Cognito mock); production a11y is verified on every deploy by Lighthouse + manual axe DevTools spot-checks.

## Per-criterion status

### 1.1 — Text Alternatives

- **1.1.1 Non-text Content (A)** — All `<img>` tags have descriptive `alt`. Decorative SVG icons use `aria-hidden="true"`. Brand mark in the footer has an `<svg>` with no aria attribute since the surrounding text already names the company. Empty-state illustration is `aria-hidden`. ✅

### 1.2 — Time-based Media

- We don't ship audio or video content. All criteria N/A. ✅

### 1.3 — Adaptable

- **1.3.1 Info and Relationships (A)** — Semantic HTML throughout. Forms use `<label>` (via the `Input` component); lists are `<ul>` with `<li>`; landmarks use `<nav>` / `<main>` / `<footer>`. Headings are `<h1>` → `<h2>` → `<h3>` without skipping levels. ✅
- **1.3.2 Meaningful Sequence (A)** — DOM order matches visual reading order; CSS uses flex/grid but no `order` overrides. ✅
- **1.3.3 Sensory Characteristics (A)** — Form errors carry text, not color alone. ✅
- **1.3.4 Orientation (AA)** — Layout works in both portrait and landscape; no `viewport` lock. ✅
- **1.3.5 Identify Input Purpose (AA)** — Email fields have `autoComplete="email"`, password fields `autoComplete="current-password"`, phone field `autoComplete="tel"`. ✅

### 1.4 — Distinguishable

- **1.4.1 Use of Color (A)** — Color never the sole carrier of meaning. Form errors have icons + text. ✅
- **1.4.3 Contrast (Minimum) (AA)** — Every text/background pair clears 4.5:1. Brand was originally Tailwind green-600 (#16a34a) which gave 3.29:1 with white — failed. Swapped to emerald-600/700 family; primary buttons use primary-700 (5:1). All gray text on white uses `gray-600` or darker. ✅
- **1.4.4 Resize Text (AA)** — Layout reflows correctly at 200% zoom. ✅
- **1.4.5 Images of Text (AA)** — All textual content is real text. ✅
- **1.4.10 Reflow (AA)** — Content reflows at 320 CSS px without 2D scrolling. ✅
- **1.4.11 Non-text Contrast (AA)** — Form input borders ≥3:1 against background. Focus rings 3.5:1. ✅
- **1.4.12 Text Spacing (AA)** — Tailwind defaults give comfortable line-height (1.5). No pixel-locked text. ✅
- **1.4.13 Content on Hover or Focus (AA)** — Tooltips on icon-only buttons use `aria-label`, not hover state. ✅

### 2.1 — Keyboard Accessible

- **2.1.1 Keyboard (A)** — Every interactive element reachable via Tab. ✅
- **2.1.2 No Keyboard Trap (A)** — All modals allow Esc to close, Tab to cycle. ✅
- **2.1.4 Character Key Shortcuts (A)** — No single-character shortcuts. ✅

### 2.2 — Enough Time

- **2.2.1 Timing Adjustable (A)** — No timed content. JWT refresh is invisible. ✅
- **2.2.2 Pause, Stop, Hide (A)** — No autoplaying content. ✅

### 2.3 — Seizures

- **2.3.1 Three Flashes (A)** — No flashing. `prefers-reduced-motion` disables transitions. ✅

### 2.4 — Navigable

- **2.4.1 Bypass Blocks (A)** — Skip-link is the first focusable element on every page; target wrapper exists on both authenticated and public routes. ✅
- **2.4.2 Page Titled (A)** — `<title>` set in `index.html`. Per-route titles deferred (would require setting `document.title` in each lazy route). ⚠️ See gaps below.
- **2.4.3 Focus Order (A)** — Tab order matches visual order. Mobile sidebar dialog traps focus while open (HeadlessUI). ✅
- **2.4.4 Link Purpose (A)** — Link text describes destination. ✅
- **2.4.5 Multiple Ways (AA)** — Sidebar nav + breadcrumb anchors on detail pages. ✅
- **2.4.6 Headings and Labels (AA)** — Headings descriptive ("Add a new plant"). Labels match data ("Plant name"). ✅
- **2.4.7 Focus Visible (AA)** — `:focus-visible` shows 2px primary-500 ring with offset. ✅
- **2.4.11 Focus Not Obscured (Minimum) (AA)** — _WCAG 2.2 new_. Focused elements aren't obscured by sticky chrome. The mobile sticky header is a fixed height and never overlaps interactive content. ✅

### 2.5 — Input Modalities

- **2.5.1 Pointer Gestures (A)** — All interactions single-pointer. ✅
- **2.5.2 Pointer Cancellation (A)** — Buttons fire on click (mouseup), never mousedown alone. ✅
- **2.5.3 Label in Name (A)** — Visible label and accessible name match. Icon-only buttons have `aria-label`. ✅
- **2.5.4 Motion Actuation (A)** — N/A. ✅
- **2.5.7 Dragging Movements (AA)** — _WCAG 2.2 new_. No drag interactions. ✅
- **2.5.8 Target Size (Minimum) (AA)** — _WCAG 2.2 new_. All tap targets ≥24×24 CSS px. Button has `min-h-touch` (44px) baked in. The "Sign up free" header link previously failed Lighthouse mobile (Button size="sm" was 32px); bumped to size="md". ✅

### 3.1 — Readable

- **3.1.1 Language of Page (A)** — `<html lang>` set per user's chosen language. ✅
- **3.1.2 Language of Parts (AA)** — Spanish content lives in its own translation file. ✅

### 3.2 — Predictable

- **3.2.1 On Focus (A)** — No focus-triggered navigation. ✅
- **3.2.2 On Input (A)** — No input-triggered submission. ✅
- **3.2.3 Consistent Navigation (AA)** — Sidebar identical across all authenticated pages. ✅
- **3.2.4 Consistent Identification (AA)** — Same purpose, same label across the app. ✅
- **3.2.6 Consistent Help (A)** — _WCAG 2.2 new_. Help link in the sidebar at the same position on every authenticated page; contact email consistent everywhere. ✅

### 3.3 — Input Assistance

- **3.3.1 Error Identification (A)** — Inline form errors via `Input` component's `error` prop, announced via `aria-invalid` + `aria-describedby`. ✅
- **3.3.2 Labels or Instructions (A)** — Every input has a visible label; helper text via `helperText` prop. ✅
- **3.3.3 Error Suggestion (AA)** — Errors tell the user what to do ("Use the format +15551234567"). ✅
- **3.3.4 Error Prevention (AA)** — Plant deletion + account deletion show `ConfirmDialog`. Stripe billing through its own confirm UI. ✅
- **3.3.7 Redundant Entry (A)** — _WCAG 2.2 new_. Onboarding doesn't re-ask for email after signup. ✅
- **3.3.8 Accessible Authentication (Minimum) (AA)** — _WCAG 2.2 new_. Email + password only — no captcha, no cognitive test. Standard `autoComplete` attributes let password managers fill. ✅

### 4.1 — Compatible

- **4.1.1 Parsing** — Removed in WCAG 2.2. ✅
- **4.1.2 Name, Role, Value (A)** — ARIA used correctly throughout. Settings tabs have `aria-current` on active. ✅
- **4.1.3 Status Messages (AA)** — Alert components have `role="alert"`. ✅

## Known gaps

| Criterion        | Gap | Status                                 |
| ---------------- | --- | -------------------------------------- |
| (none currently) | —   | All previously documented gaps closed. |

Closed:

- **2.4.2 Page Titled** — `useDocumentTitle()` hook called from every route page; `<title>` reflects the current page plus a "• Family Greenhouse" suffix.
- **Authenticated route a11y in CI** — `tests/e2e/a11y-authenticated.spec.ts` covers it.

## Manual checks before each public release

- [ ] Run VoiceOver / NVDA through the signup → first plant flow once
- [ ] Tab through every modal — Esc closes, Tab cycles, Shift+Tab walks back
- [ ] Render at 200% browser zoom; nothing overflows
- [ ] Render at 400% zoom on a 320px viewport (Reflow); no 2D scrolling
- [ ] Windows High Contrast Mode check for missing borders / color-conveyed info
- [ ] axe DevTools on at least the dashboard and plant-detail page (authenticated routes the e2e suite skips)
