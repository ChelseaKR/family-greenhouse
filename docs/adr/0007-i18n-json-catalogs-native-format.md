# 0007 — i18n: per-locale JSON catalogs, i18next-native message format

**Status:** Accepted (2026-07-10)

## Context

The portfolio Tier-2 audit flagged this repo's i18n as bespoke: translations lived as inline TypeScript objects (`frontend/src/i18n/locales/{en,es}.ts`) compiled into the bundle, with key parity enforced only by a TS type and a unit test — no catalog files a translator or TMS could round-trip, no mechanical CI gates. `STANDARDS/INTERNATIONALIZATION-STANDARD.md` (§2, §4) prescribes real catalogs with extraction/parity tooling for TS/React frontends, and for _new_ TS work prefers MF2 (ICU MessageFormat 2) via FormatJS-style tooling; it explicitly rejects ICU MF1 for new work ("superseded") and bespoke dicts ("no extraction/plural/parity tooling").

This repo is already on i18next (`i18next` + `react-i18next` + `i18next-browser-languagedetector`), with i18next's own conventions throughout: `{{var}}` interpolation and JSON-v4 CLDR plural suffixes (`_one`/`_other`), resolved at runtime by `Intl.PluralRules`.

Options considered for the message format:

1. **Keep i18next's native format** (JSON v4 plural suffixes + `{{var}}`) — zero new dependencies, zero string rewrites, plural selection already CLDR-correct via `Intl.PluralRules`.
2. **`i18next-icu`** — adds a runtime dependency _and_ rewrites every plural/interpolated string into ICU MF1, the exact syntax the standard rejects for new work (§2: "New code MUST NOT introduce ICU MF1 resources", §9 requires a `MIGRATION_MF2.md` from any MF1 repo).
3. **Migrate to FormatJS/react-intl + MF2** — the standard's target for greenfield TS, but a full framework swap touching all 40 `useTranslation` call sites, out of scope for a catalog-migration PR and premature while MF2 runtime tooling in the i18next ecosystem is still settling.

## Decision

- **Catalog files are the single source of truth:** i18next-standard per-locale namespace files at `frontend/src/i18n/locales/<lng>/translation.json`, loaded by the bootstrap (`src/i18n/index.ts`) instead of inline TS objects. (Vite still inlines them into the bundle at build time — two locales are small; lazy `i18next-http-backend` loading is a later, orthogonal step.)
- **Message format stays i18next-native** (option 1): `{{var}}` interpolation, JSON-v4 plural suffixes covering each locale's full CLDR category set (es now carries `_many`, which the old catalog silently lacked). This is the minimal-dependency option and — unlike `i18next-icu` — does not introduce MF1, so no `MIGRATION_MF2.md` obligation is triggered (§9). If/when the app needs MF2 features (rich `.match` selectors, number skeletons), the move is to MF2 proper, not to MF1 as an intermediate.
- **Parity is enforced mechanically, not by types:** the old `Translation` TS type is replaced by `frontend/scripts/check-i18n-catalogs.mjs` (key parity, placeholder parity, CLDR plural-category completeness, BCP-47 validity, UTF-8) plus `frontend/scripts/check-hardcoded-strings.mjs` (ratchet on hardcoded JSX text). Both run in the CI `i18n` job and in `npm run verify` — local == CI.
- **Untranslated strings are declared, never silent:** a non-English value identical to the English source must be listed in `<lng>/translation.todo.json` (`todo` = pending human translation; `intentionallyEqual` = the correct translation happens to match English). The gate fails on undeclared English values and on stale markers. No machine translation is introduced by tooling or migration. Conventions: `docs/i18n.md`.

## Consequences

- Translators/TMS tooling get plain JSON catalogs; adding a locale is a directory with `translation.json` (+ sidecar) and the gates enforce completeness from day one.
- Compile-time key-shape checking is gone; the merge-blocking gate replaces it (and also catches what the type never could: placeholder renames, missing plural categories, undeclared English fallbacks).
- Six es plural forms (`*_many`) currently ship the English `_other` text, visibly tracked in `translation.todo.json` — they only render for counts ≥ 1,000,000 and are pending human translation. Spanish remains behind the `VITE_ENABLE_NON_ENGLISH_LOCALES` shipping gate regardless.
- The standard's remaining frontend gates (G9 pseudolocale overflow, G10 RTL logical-properties lint) are not in this PR; they need Playwright fixtures and stylelint wiring and are tracked as follow-ups in `docs/i18n.md`.
