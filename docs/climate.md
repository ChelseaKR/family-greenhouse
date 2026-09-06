# Local climate awareness

External weather enrichment via the [OpenWeatherMap API](https://openweathermap.org/api). Powers humidity warnings, freeze alerts, "skip watering today" hints, and a per-household climate card on the dashboard.

The integration is **feature-gated by `OPENWEATHER_API_KEY`**. With no key, climate endpoints return `{ configured: false, weather: null, tips: [] }` and the UI either suppresses climate cards (no location set) or surfaces a small "off" hint (location set but key missing).

## Goals and non-goals

**Goals**

- Move from "you told us 7 days" to "outdoor humidity is 28% today, so your fiddle leaf needs misting" without the user having to think about it.
- Per-household location storage that the user can set or clear at any time.
- Same degradation discipline as Perenual: every code path must work with the integration off.

**Non-goals**

- We are not a weather app. We don't show temperature graphs, radar, or hourly forecasts. We expose just enough to drive care advice.
- We do not store user GPS coordinates without an explicit "save location" action by an admin. No silent geolocation.

## Architecture

Same shape as the Perenual integration — the layering is intentional so swapping providers (or adding a second weather source) is one file:

```
┌───────────────────────────────────────────────────────────┐
│ Frontend                                                   │
│  ├── ClimateCard           (dashboard)                     │
│  └── HouseholdPage         (location editor, admin-only)   │
└──────────────────────────┬────────────────────────────────┘
                           │ JSON
                           ▼
┌───────────────────────────────────────────────────────────┐
│ handlers/climate/handler.ts                                │
│   GET /households/:id/climate                              │
│   PUT /households/:id/location                             │
└──────────────────────────┬────────────────────────────────┘
                           ▼
┌───────────────────────────────────────────────────────────┐
│ services/climate.ts  (cache + budget + tip derivation)     │
│   ├─ DDB read  (PK=WEATHER#CACHE, SK=…)                    │
│   ├─ Daily-budget UpdateCommand                            │
│   └─ deriveClimateTips(snapshot)                           │
└──────────────────────────┬────────────────────────────────┘
                           ▼
┌───────────────────────────────────────────────────────────┐
│ services/weather.ts  (raw HTTP, returns null on failure)   │
│   ├─ geocode(query)                                        │
│   └─ getWeather(lat, lon)                                  │
└───────────────────────────────────────────────────────────┘
```

### Caching

Single DynamoDB partition under `PK = WEATHER#CACHE`:

| SK                                        | Payload           | TTL     |
| ----------------------------------------- | ----------------- | ------- |
| `GEOCODE#<lowercased query>`              | `GeocodeResult`   | 30 days |
| `WEATHER#<quantized lat>,<quantized lon>` | `WeatherSnapshot` | 1 hour  |

Coordinates are quantized to 3 decimals (~110m) so two households on the same block share one weather row instead of refetching for a 50m diff. The 30-day geocode TTL is generous because cities don't move; weather caches at 1 hour because conditions change within a day.

### Budget gate

```
PK = WEATHER#BUDGET
SK = DAY#YYYY-MM-DD
attrs: { used, ttl }
```

Defaults to 800 calls/day (configurable via `OPENWEATHER_DAILY_BUDGET`). The free tier is 60/min × 86,400/day so 800 leaves a comfortable ceiling against runaway loops. Same circuit-breaker semantics as Perenual: when used > limit, calls return `null` and the integration looks "disabled" to the client.

## Endpoints

### `GET /households/:id/climate`

Auth required. Returns:

```json
{
  "configured": true,
  "weather": {
    "observedAt": "2026-04-25T14:00:00Z",
    "tempC": 22,
    "humidity": 28,
    "condition": "Clear",
    "description": "clear sky",
    "forecast": [{ "date": "2026-04-25", "minC": 14, "maxC": 25, "humidity": 30 }]
  },
  "tips": [
    {
      "level": "warning",
      "appliesTo": ["tropical"],
      "message": "Outdoor humidity is around 28%. Indoor air is usually drier still, so tropical plants benefit from a humidifier or weekly misting."
    }
  ]
}
```

`weather` is `null` when no location is set, the integration is disabled, or budget is exhausted — the client treats those identically (suppress climate UI). `tips` is always an array; empty when nothing notable is happening.

Cache profile: `Cache-Control: private, max-age=1800` so the browser/CDN absorbs repeat dashboard views without burning the daily budget.

### `PUT /households/:id/location`

Admin-only. Body shape:

```json
{ "city": "Austin, US" }
```

…or `null` to clear the location. The server geocodes the free-text city; the client never sets lat/lon directly. Returns the updated `Household` (with normalized `city` from the geocode result).

## Tip derivation

`deriveClimateTips(snapshot)` is a pure function (`backend/src/services/climate.ts`). Adding/tuning advice means editing one file. Current rules:

| Condition                     | Severity | Targeted at        | Action                |
| ----------------------------- | -------- | ------------------ | --------------------- |
| Outdoor humidity < 30%        | warning  | tropical           | mist / humidifier     |
| Outdoor humidity > 70%        | info     | succulent          | airflow               |
| Forecast low < 5°C            | warning  | outdoor + tropical | bring indoors         |
| Condition contains rain/storm | info     | outdoor            | skip watering         |
| Temp > 32°C                   | warning  | (all)              | check soil more often |

Test coverage in `tests/unit/services/climate.test.ts`. The mapping is intentional and small; we'd rather miss an edge case than spam users with five tips when one would do.

**Every number in a tip is an outdoor reading.** OpenWeatherMap reports conditions at the geocoded city centroid; this product has no indoor sensor and no way to infer one. A tip may reason about indoor conditions ("indoor air is usually drier still") but must never print a snapshot value as if it were measured inside the home. `deriveClimateTips` used to open with "Indoor humidity is around 28%" against the outdoor reading — a wrong label that changes what a user does, since 28% outdoors on a rainy 5°C day is a very different room than 28% outdoors in August. A regression test in `tests/unit/services/climate.test.ts` asserts no tip claims an indoor measurement.

## Seasonal cadences (calendar, not weather)

Everything above reacts to a _reading_: today's humidity, tonight's low, the
rain that means skip this cycle. A **seasonal cadence** is the other half —
the part of a plant's year that needs no API call at all. Most houseplants slow
down in the dormant months, and a task carrying a single `frequency` is
therefore wrong for half the year in a way no weather event can correct.

`backend/src/services/seasonalCadence.ts` is the whole rule, and it is pure:

- A task may carry up to four `seasonalCadences`, at most one per season.
  Each overrides the task's base `frequency` while its season is in force.
- Seasons are **meteorological** — whole calendar months, Mar–May spring
  through Dec–Feb winter in the north — so a cadence changes on a date the
  household can read off a calendar, and the boundary is the same every year.
- The **hemisphere** comes from the household's stored location (the same
  `lat` this document's `PUT /households/:id/location` writes) and is the only
  thing it changes: the southern table is the northern one read six months out
  of phase. Because a cadence names a _season_ and not a month range, a
  household that moves across the equator keeps every profile it had, with no
  row rewritten.
- Latitude exactly `0` reads as northern, matching the already-shipped
  `frontend/src/features/plants/seasonalHomes.ts`. Two helpers disagreeing
  about the equator would be worse than either answer.

### What it never does

Nothing here changes a schedule on its own. Applying a profile is a person's
edit, exactly as `frequency` is; the cadence then decides how far
`completeTask` advances `nextDue`, and nothing else.

And it never renders absence as a value. `resolveCadence` always returns a real
number of days — a completion has to advance the schedule — but every fall back
to the base `frequency` carries a `reason` saying which of these happened, and
`season` stays `null` rather than being guessed:

| `reason`                | What it means                                                       |
| ----------------------- | ------------------------------------------------------------------- |
| `no_profile`            | The task has no seasonal cadences. Every task today.                |
| `no_location`           | The household has no location, so no hemisphere. A settled fact.    |
| `household_unavailable` | The household row could not be READ. **Not** the same as the above. |
| `season_unset`          | Hemisphere known; this season simply has no cadence set.            |

The `no_location` / `household_unavailable` split is load-bearing rather than
decorative. The UI offers "add a household location" for the first and must not
for the second, and a transient DynamoDB failure must never be recorded as a
settled fact about where the household is. Same rule as
[ADR 0010](adr/0010-settled-read-states.md), applied to a write path.

### Where the cadence in force is read

| Surface                                             | Why it has to agree                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `taskService.completeTask`                          | The schedule itself: `nextDue = now + cadence`.                                               |
| `doubleCare.getScheduleDriftForPlant`               | Drift against the base interval reports a _correct_ winter rhythm as a mistake.               |
| `POST /tasks/{id}/match-schedule`                   | Writes the new interval into the season in force, or the household taps it and nothing moves. |
| `icsExport.buildIcs`                                | A calendar saying "every 7 days" all winter contradicts the app it mirrors.                   |
| `digestReport` at-risk drift                        | Same reading as the app, or the weekly email argues with the product.                         |
| `features/tasks/taskRowExtras.SeasonalCadenceBadge` | The row's headline interval is the base one; the chip names what is actually in force.        |

The household row is read **only** when a task actually carries a profile.
Without that guard every completion in the product — including the kiosk,
sitter-link and plant-tag paths — would pay a `GetItem` to be told a hemisphere
nothing would consult.

### Known limit

Drift compares one median interval against the cadence in force _now_. A
completion history that spans a cadence change is still measured against a
single interval, so a household that switched to its winter cadence last month
can show drift for a few weeks until the considered window catches up.
Seasoning each interval individually would change what `medianIntervalDays` and
`driftPct` mean on an already-published payload, which is a separate decision.

### Tests

`backend/tests/unit/services/seasonalCadence.test.ts` sweeps every month in
both hemispheres rather than sampling — the only interesting months are the
boundaries, and a spot check in mid-season cannot see an off-by-one. It also
reads `frontend/src/features/tasks/seasonalCadence.ts` and re-derives its table,
so the client mirror and the server cannot drift apart: the server decides what
the schedule does, the client decides what the household is told it does, and a
row reading "summer cadence" against a winter advance is worse than either side
being wrong alone.

## Frontend integration points

| File                                   | Responsibility                                          |
| -------------------------------------- | ------------------------------------------------------- |
| `services/climateService.ts`           | Typed wrapper around `/climate` and `/location`.        |
| `features/dashboard/ClimateCard.tsx`   | Dashboard card; suppresses when no location AND no key. |
| `features/household/HouseholdPage.tsx` | Admin-only location editor (saved or cleared).          |

## Operational concerns

### Configuration

| Variable                   | Required | Default | Notes                                                 |
| -------------------------- | -------- | ------- | ----------------------------------------------------- |
| `OPENWEATHER_API_KEY`      | No       | unset   | When unset, every climate code path returns disabled. |
| `OPENWEATHER_DAILY_BUDGET` | No       | `800`   | Daily call ceiling before the breaker trips.          |

### Monitoring

Structured log events:

- `weather.fetch_failed` — network failure or thrown fetch
- `weather.non_2xx` — OpenWeatherMap returned a non-2xx
- `weather.cache_read_failed` / `weather.cache_write_failed` — DDB hiccup
- `weather.budget_exhausted` — breaker tripped
- `weather.budget_check_failed` — DDB error during the budget update

The CloudWatch dashboard (`infrastructure/modules/monitoring/main.tf`) can be extended with a Logs Insights panel for `weather.budget_exhausted` mirroring the Perenual one.

### Privacy

We send a free-text city string to OpenWeatherMap. We never send userId, householdId, plant names, or any user-identifying data. The lat/lon we cache is the city centroid OpenWeatherMap returned, not the user's actual address.

## Failure modes

| Scenario                      | Behavior                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENWEATHER_API_KEY` unset   | Endpoints return `{ configured: false, weather: null, tips: [] }`. ClimateCard suppresses (no location) or shows a small "off" hint (location saved). |
| Geocode returns no candidates | `PUT /location` returns 400 with a hint to add a country.                                                                                             |
| Network timeout (>5s)         | Service returns `null`; user sees the saved location with `weather: null`.                                                                            |
| Budget exhausted              | Same as integration disabled — `null` everywhere until UTC midnight rollover.                                                                         |
| User clears location          | Card disappears from the dashboard; no weather calls made for that household.                                                                         |

## Future work

- **Per-plant species cross-reference**: today the tip's `appliesTo` array is informational. The `CareGuideCard` could filter tips by the plant's category (tropical / succulent / outdoor) so users see only the relevant ones.
- **Notification integration**: a freeze warning could fire a one-shot notification (gated like pest alerts) for households with outdoor plants.
- **Translation**: tips are English-only; same AWS Translate seam as the Perenual care guide.
