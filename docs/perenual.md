# Perenual integration

External plant-data enrichment via the [Perenual API](https://perenual.com/). Powers smarter species autocomplete, suggested watering schedules, long-form care guides, image fallbacks, and seasonal pest alerts.

The integration is **feature-gated by the presence of `PERENUAL_API_KEY`**. With no key, every Perenual code path returns `null` and the app falls back to its 245-entry static species catalog. There is no separate "enabled" flag — configure the secret to turn it on.

## Goals and non-goals

**Goals**

- Make species autocomplete cover the long tail (10K+ plants) without us curating it.
- Seed sensible default care schedules so new users don't start from a blank task list.
- Surface care guides, toxicity warnings, and pest pressure for plants we recognize.
- Degrade gracefully when Perenual is unconfigured, rate-limited, slow, or returns garbage. Users should never see a hard error from this integration.

**Non-goals**

- We are not building our own plant database. If Perenual data is wrong, we don't correct it inline; we add it to the static fallback for our most common species and call it a day.
- We do not depend on Perenual being up for any core flow. Adding plants, completing tasks, sharing households, billing — all work with the integration off.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│ Frontend                                                   │
│  ├── SpeciesCombobox  (debounced async)                    │
│  ├── SuggestedCareCard  (auto-watering on save)            │
│  ├── CareGuideCard      (long-form drill-in)               │
│  └── PlantImage         (thumbnail fallback)               │
└──────────────────────────┬────────────────────────────────┘
                           │ JSON
                           ▼
┌───────────────────────────────────────────────────────────┐
│ Backend handlers/species/handler.ts                        │
│   GET /species/search?q=                                   │
│   GET /species/:id                                         │
│   GET /species/:id/thumbnail   (302 redirect)              │
│   GET /species/:id/care-suggestions                        │
│   GET /species/:id/guide?locale=                           │
└──────────────────────────┬────────────────────────────────┘
                           ▼
┌───────────────────────────────────────────────────────────┐
│ services/enrichment.ts  (cache + budget gate)              │
│   ├─ DDB read (PK=PERENUAL#CACHE, SK=…)                    │
│   ├─ Daily-budget UpdateCommand                            │
│   └─ Falls back to services/perenual.ts on cache miss      │
└──────────────────────────┬────────────────────────────────┘
                           ▼
┌───────────────────────────────────────────────────────────┐
│ services/perenual.ts  (raw HTTP, returns null on failure)  │
│   ├─ searchSpecies(q)                                      │
│   ├─ getSpecies(id)                                        │
│   ├─ getCareGuide(speciesId)                               │
│   └─ listPestsForSpecies(scientificName)                   │
└───────────────────────────────────────────────────────────┘
```

### Layering rules

- **`perenual.ts`** is intentionally dumb: no caching, no retries, no rate-limit accounting. Every method returns `null` on any failure (network error, non-2xx, missing key, malformed JSON, timeout). Never throws.
- **`enrichment.ts`** is the only module the rest of the codebase imports for Perenual data. It enforces the cache + the daily budget. Adding a new Perenual-backed feature means adding a function here, never reaching past it.
- **Handlers** translate from the cached domain types to API responses. They don't know about Perenual's request shape.

## Caching

DynamoDB single-table, partitioned under `PK = PERENUAL#CACHE`:

| SK                                   | Payload                           | TTL       |
| ------------------------------------ | --------------------------------- | --------- |
| `SEARCH#<lowercased query>`          | array of `PerenualSpeciesSummary` | 5 minutes |
| `SPECIES#<id>`                       | `PerenualSpeciesDetail`           | 90 days   |
| `GUIDE#<speciesId>`                  | `PerenualCareGuide`               | 90 days   |
| `PESTS#<lowercased scientific name>` | array of `PerenualPestSummary`    | 90 days   |

Search caches short to coalesce typeahead spam without staling. Detail/guide/pest caches long because the underlying data changes rarely.

Pest-alert dedupe lives in a separate partition keyed by plant + pest:

| PK                | SK                    | Payload              |
| ----------------- | --------------------- | -------------------- |
| `PLANT#<plantId>` | `PEST_ALERT#<pestId>` | `{ alertedAt, ttl }` |

The 1-year TTL sweeps stale rows we don't care about anymore.

## Daily budget

```
PK = PERENUAL#BUDGET
SK = DAY#YYYY-MM-DD     (UTC date)
attrs: { used: number, ttl: epoch+7d }
```

Every uncached call to `enrichment.*` increments `used` via `UpdateCommand` (`ADD :one`). When `used > limit` (default 80, configurable via `PERENUAL_DAILY_BUDGET`), the breaker trips and that request returns `null` — same as if Perenual were unconfigured. The frontend handles this transparently because every code path already needs to handle a `null`/`disabled` response for the unconfigured case.

The free tier is 100/day. Defaulting to 80 leaves headroom for retries and clock-skew between when the counter increments and when the user-visible request resolves. The breaker resets at UTC midnight per Perenual's documented quota.

If the budget check itself fails (DDB hiccup), we log and proceed — failing closed would brick the feature on transient errors.

## Endpoint reference

### `GET /species/search?q=<text>`

Auth required. Returns:

```json
{
  "source": "perenual" | "disabled",
  "results": [
    { "id": 7, "commonName": "Monstera", "scientificName": "Monstera deliciosa", "thumbnailUrl": "https://…" }
  ]
}
```

`source: "disabled"` means the integration is off (no key) or the budget is exhausted. Frontend falls back to the static catalog. Empty `q` or `q.length < 2` returns an empty list without spending budget.

### `GET /species/:id`

Auth required. Returns `{ result: PerenualSpeciesDetail | null }`.

### `GET /species/:id/thumbnail`

Auth required. Issues a 302 to the cached Perenual thumbnail URL with `Cache-Control: public, max-age=86400`. Returns 404 if the species is unknown or has no image.

### `GET /species/:id/care-suggestions`

Auth required. Returns the derived care suggestion used by the AddPlant flow:

```json
{
  "result": {
    "wateringDays": 7,
    "sunlight": ["part shade"],
    "summary": "Water about every 7 days. Light: part shade."
  }
}
```

Watering bands are mapped via `services/careRecommendations.ts`:

| Perenual band | Days              |
| ------------- | ----------------- |
| `frequent`    | 3                 |
| `average`     | 7                 |
| `minimum`     | 14                |
| `none` / null | no task suggested |

The mapping lives in code so we can tune from telemetry. If users override the suggestion >40% of the time on a band, that band is wrong.

### `GET /species/:id/guide?locale=<xx>`

Auth required. Returns long-form care guide:

```json
{
  "result": {
    "commonName": "Monstera",
    "scientificName": "Monstera deliciosa",
    "family": "Araceae",
    "cycle": "Perennial",
    "hardinessZone": "10-12",
    "indoor": true,
    "poisonousToPets": true,
    "sunlight": ["part shade"],
    "sections": [
      { "type": "watering", "description": "…" },
      { "type": "sunlight", "description": "…" },
      { "type": "pruning", "description": "…" }
    ],
    "locale": "en",
    "translated": false
  }
}
```

`locale` is forward-compat. Today it's a no-op — Perenual returns English. When AWS Translate is wired up, the guide service will translate `sections` per-locale, cache the translation alongside the source row, and set `translated: true`.

## Frontend integration points

| File                                         | Responsibility                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `services/speciesService.ts`                 | Typed wrapper around the species endpoints.                                                                              |
| `components/SpeciesCombobox.tsx`             | Async-augmented typeahead (300ms debounce, dedupes Perenual + static catalog). Empty input shows the full local catalog. |
| `components/PlantImage.tsx`                  | User photo → Perenual thumbnail → SVG placeholder cascade.                                                               |
| `features/plants/SuggestedCareCard.tsx`      | Inline preview of derived care suggestion.                                                                               |
| `features/plants/AddPlantPage.tsx`           | Captures `perenualSpeciesId` on species pick or AI identification, seeds a watering task post-save.                      |
| `features/plants/CareGuideCard.tsx`          | Long-form care guide with prominent toxicity callout.                                                                    |
| `features/settings/NotificationSettings.tsx` | Pest-alerts opt-in toggle (off by default).                                                                              |

## Operational concerns

### Configuration

| Variable                | Required | Default | Notes                                          |
| ----------------------- | -------- | ------- | ---------------------------------------------- |
| `PERENUAL_API_KEY`      | No       | unset   | When unset, the integration is fully disabled. |
| `PERENUAL_DAILY_BUDGET` | No       | `80`    | Per-day call ceiling before the breaker trips. |

### Rotating the API key

1. Generate a new key in the Perenual dashboard.
2. Update SSM Parameter Store / Lambda env.
3. The old key keeps working until Perenual revokes it. There's no app-side reload — Lambdas read on cold start. Force a deploy if you need an immediate cutover.

### Monitoring

CloudWatch logs surface these structured events:

- `perenual.fetch_failed` — network failure or thrown fetch
- `perenual.non_2xx` — Perenual returned a non-2xx status
- `perenual.cache_read_failed` / `perenual.cache_write_failed` — DDB hiccup; the request still proceeds
- `perenual.budget_exhausted` — breaker tripped; consider raising `PERENUAL_DAILY_BUDGET` or the paid tier
- `perenual.budget_check_failed` — DDB error during the budget update; we fail open

A dashboard surfacing call rate, cache hit %, daily budget consumed, and error rate is a Phase-7 nice-to-have — not blocking.

### Cost ceiling

- Free tier (100/day): fine for a beta with <50 active households if cache is warm.
- $5/mo (10K/day): comfortable through ~1K households.
- $10/mo unlimited: budget breaker can be raised generously; the cache still keeps real costs low.

## Failure modes and tested behaviors

| Scenario                                   | Behavior                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `PERENUAL_API_KEY` unset                   | All endpoints return `null`/`disabled`; static catalog drives the picker.  |
| Network timeout (>5s)                      | Client returns `null`; cache untouched; user sees static-only suggestions. |
| Perenual returns 429 (rate limited)        | Treated as failure; `null` returned; budget gauge unaffected.              |
| Perenual returns malformed JSON            | Caught; `null` returned; logged.                                           |
| DDB cache write fails                      | Logged; user request still succeeds; next request will retry the API.      |
| Daily budget exhausted                     | Subsequent requests return `null` until UTC midnight rollover.             |
| User has no `perenualSpeciesId` on a plant | All Perenual-driven UI suppresses itself.                                  |

Unit-test coverage lives in `tests/unit/services/perenual.test.ts` and `tests/unit/services/careRecommendations.test.ts`.

## Pest alerts

Driven by `services/pestAlerts.ts:evaluatePestAlerts(householdId)`. To wire the weekly cadence:

1. EventBridge rule, weekly schedule, payload `{ householdId }` per household.
2. New Lambda invokes `evaluatePestAlerts`, then dispatches each alert through the existing `notificationService` fanout (email/SMS/push).
3. Per-user opt-in lives on `NotificationPreferences.pestAlerts` (default false). Users without the toggle on are skipped before notification dispatch.

The dedupe write happens **inside** `evaluatePestAlerts`, before any notification is sent. If the notification fanout fails after that, the user just doesn't get a duplicate next week — better than risking spam.

## Future work

- **Phase 7 (post-roadmap)**: build the CloudWatch dashboard for ongoing observability.
- **AWS Translate** for non-English care guides. Wire into `handlers/species/handler.ts:guide`. Cost: ~$15/M chars; cache aggressively per `(speciesId, locale)`.
- **Image licensing audit**: only ~half of Perenual's images are CC-licensed. Filter by license at ingestion and only proxy permissively-licensed ones.
- **Trefle migration plan**: keep the `enrichment.ts` interface stable so swapping the upstream provider is one file. The raw client (`perenual.ts`) is the only thing that knows about the wire format.
