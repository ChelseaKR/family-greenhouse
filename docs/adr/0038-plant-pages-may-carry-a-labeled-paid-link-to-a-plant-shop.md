# 0038 — The public plant pages may carry one labeled paid link to a plant shop, off by default

**Status:** Proposed

**Date:** 2026-10-12

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0011](0011-categorical-pet-safety-claims-block.md) (pet-safety
claims come only from the cited table); `frontend/src/features/plantShop/`, `frontend/src/config/affiliateLinks.json`,
`frontend/scripts/check-plant-safety-pages.mjs`.

## Context

The owner, 2026-10-12, approved trying an affiliate program with The Sill or Bloomscape (both on
Impact) for the public plant pages: the 24 `/care/<slug>` guides and the 28 `/pet-safe/<slug>`
pages. She applies to the programs herself. At today's traffic this earns close to nothing; it is
worth doing only if it costs the site nothing it already promises.

Constraints that shaped the decision:

- No script, no cookie on our domain, no tracking pixel, and no value that varies by reader. A
  plain link only; the merchant or Impact sets its own cookie after the reader leaves.
- The FTC's endorsement guidance says a disclosure belongs at the link: "Paid link" beside it is
  adequate; a footer note alone is not.
- The pet-safety verdicts are the reason people trust `/pet-safe`. A shop link must never read as
  part of a verdict, and the build gate that holds those pages to the cited table must keep holding.
- The iOS and Android apps show the same pages. Their privacy labels and review notes say nothing
  about affiliate links, so the apps must not carry them.
- Until a program approves the account, nothing may change on the site.

## Decision

1. **Two files, kept apart.** `plantShopLinks.json` is data: one hand-checked product page per
   plant and merchant, with the botanical name that page showed and the date it was read. An entry
   exists only for an exact species match (or, for a genus-level guide, a plant in that genus) on a
   live page that was not sold out; no entry means no link, and a near match is never listed. The
   rejected candidates are named in the file. `config/affiliateLinks.json` is configuration: the
   Impact tracking link base per merchant, committed **empty**.

2. **A link exists only when both are present.** The href is the tracking link followed by
   `?u=<the product page>`. Merchants are tried in a fixed order (The Sill, then Bloomscape), so a
   plant listed at both goes to whichever program is active. A config value that is not of the
   Impact form (`https://<host>/c/<n>/<n>/<n>`, no query or fragment) counts as unset, and a test
   fails the build if the committed value is neither empty nor of that form.

3. **Every link is labeled where it is.** The anchor reads "Buy this plant at <shop>", carries
   `rel="sponsored noopener"`, and has a visible "Paid link" label on the same line, with one
   sentence under it: Family Greenhouse earns a commission, and it changes nothing on the page.
   English and Spanish strings live in the catalog.

4. **Placement keeps it apart from the verdicts.** On a care guide it sits after the page dates,
   away from the toxicity section. On a `/pet-safe` page it appears only when every verdict on the
   page is a cited "non-toxic": a page telling a reader a plant is toxic to their pet, or that it
   cannot say, never also offers to sell it to them.

5. **The build gate checks it.** `check-plant-safety-pages.mjs` allows exactly one off-site link
   beyond the ASPCA listings: inside the shop block, pointing exactly where the two files say, with
   the rel and the label, on an all-non-toxic page. Anything else fails the build, and the unit
   tests include negative controls for each of those.

6. **Website only.** The component renders nothing inside the Capacitor shells (`isNativeApp()`,
   the same check `PublicShell` uses to hide pricing), so the app binaries and their privacy labels
   are unchanged.

## Consequences

- With the config empty, as committed, every page renders exactly as before. A unit test renders
  every care and pet-safe page with and without a configured id and asserts the only difference is
  the shop block; with no id there is none.
- Turning a program on is a one-line config change and a deploy. Turning it off is the reverse.
- The product pages go stale: merchants rename, sell out, or drop plants. Each entry carries the
  date it was checked; recheck them before turning a program on and whenever a link is reported
  broken. A dead entry should be deleted, not pointed at a near match.
- If both programs decline, the files stay empty and the feature costs only its code.
- No new third-party code ships. GA4, already on the site, is unaffected; no per-reader parameter
  is ever added to the link.
