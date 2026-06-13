# Frontend audit — readability, formatting, alignment, and voice (2026-06-12)

Five-track audit (mobile-first code review, desktop/tablet code review, visual-identity
review, copy inventory against the humanize-prose guide, and a live screenshot pass at
390/820/1440px across all public routes). This file records the findings, what shipped
in the same PR, and what remains as a ranked backlog.

## Shipped in this PR

**Mobile (highest severity first)**

- Landing nav: "Sign up free" wrapped onto three lines at 390px. Fixed with
  `whitespace-nowrap` (now global on `Button`), tighter mobile gaps, `shrink-0`.
- Chat page used `100vh` math, which breaks under mobile browser chrome and the soft
  keyboard. Now `100dvh` with a `vh` fallback; chat textarea raised to a 44px target
  and 16px font (stops iOS auto-zoom).
- `.input` and the command palette input had no base font size (<16px on mobile =
  iOS zoom on focus). Both now `text-base sm:text-sm`.
- BrandMark taglines were 9–10px; raised to 11–12px.
- Settings tabs overflowed at 360px; now scrollable with tighter gaps.
- Action-row wrapping fixed on plant detail header, dashboard task rows, household
  member rows; snooze dropdown can no longer overflow the viewport.

**Tablet (768–1024px dead zone)**

- Five grids jumped 1-col → 3-col with no intermediate step: landing features
  (also off-center at tablet — missing `mx-auto`), billing plans, pricing cards,
  analytics KPI tiles, quiet-hours inputs. All now have `md:` steps.
- Landing facts band moved 4-up from `md:` to `lg:` (labels wrapped raggedly at 820px).
- Section padding tightened (`py-24 sm:py-32` → `py-20 sm:py-28`) to cut the ~550px
  dead gaps the screenshot pass measured.

**Bugs found by the live pass**

- Legal pages and help page linked dead `…@family-greenhouse.example` addresses.
  Now `hello@`/`support@familygreenhouse.net` (privacy@ is not a forwarded mailbox,
  so privacy contact routes to support@).
- 404 page was off-brand (gray, system sans, no illustration). Rebuilt on paper
  background with the `EmptySearch` illustration and serif heading.

**Copy (per the humanize-prose guide)**

- Deleted the fabricated testimonials and the "Trusted by 12,000+ families" badge
  outright (they were env-gated, but invented praise shouldn't exist in the repo).
- Landing rewritten: hero is now the household argument the product actually solves
  ("I thought _you_ watered it."); feature blurbs swapped from SaaS-speak ("Never
  miss…", "at a glance", "from anywhere") to concrete behavior; "Everything you
  need / Plant care made simple" → "One schedule the whole house can see";
  how-it-works steps grounded in the real flow; CTA and footer de-clichéd
  ("Grow together" ×4 reduced to the BrandMark tagline only).
- Onboarding: removed the vague "30 seconds" promise and "Most people"; pricing
  copy concretized ("Smart scheduling" → "Suggested care schedules", honest free-plan
  description). Blog posts, care guides, and help page were audited and left alone —
  they are already in a strong specific voice and are the register the rest of the
  site should match.
- Footer rebalanced: Product / Learn (care guides, blog, changelog) / Company
  (about, contact via hello@, status) / Legal.

**De-generic foundation**

- `body` default `bg-gray-50` → `bg-paper`; `.card` and `.input` borders brand-tinted;
  secondary buttons warm (`bg-paper`/`border-primary-300`) instead of stock white/gray.

## Backlog (ranked)

1. **Asymmetric hero** — left-align headline, mockup right (`lg:grid-cols-2`).
   The centered hero is the strongest remaining template tell. ~2–3h.
2. **Custom botanical feature icons** — the six landing features still use stock
   Heroicons while bespoke task icons exist. Six new SVGs in the existing style. ~3–4h.
3. **Feature-card variation** — alternate card layouts/backgrounds so the grid stops
   reading as a template block. ~4h.
4. **Subtle motion** — `sway`/`float` keyframes on hero sprigs (reduced-motion safe). ~30m.
5. **SprigDivider deployment** — between remaining landing sections. ~30m.
6. **Dark mode is half-baked** — only the body inverts; components have no dark
   variants. Either finish it or remove the toggle.
7. **`text-xs` contrast sweep** — gray-500/600 small text is at the AA edge in places.
8. **Blog dates** — all four posts show April 24, 2026; reads bulk-generated. Stagger
   to the real authorship dates if known.
9. **Status page copy** — "API Down" can render next to "No incidents in the last
   90 days"; add a degraded-data state.
10. **i18n for hardcoded surfaces** — landing/help/care/blog are English-only;
    needed before the language picker un-gates Spanish.
11. **Care-page orphan card** — 3 guides in a 2-col grid leaves an orphan; fine once
    a 4th guide ships.

## Voice note

No voice sample was provided, so the rewrite matches the repo's own best copy
(blog posts and care guides: specific, contrarian, plain words, no inflation).
Spots that still need a real fact only the maintainer can supply: an About page
(/coming-soon), and real testimonials if any ever arrive.
