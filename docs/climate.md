# Local climate awareness

External weather enrichment via the [OpenWeatherMap API](https://openweathermap.org/api). Powers humidity warnings, freeze alerts, "skip watering today" hints, and a per-household climate card on the dashboard.

The integration is **feature-gated by `OPENWEATHER_API_KEY`**. With no key, climate endpoints return `{ configured: false, weather: null, tips: [] }` and the UI either suppresses climate cards (no location set) or surfaces a small "off" hint (location set but key missing).

## Goals and non-goals

**Goals**

- Move from "you told us 7 days" to "given today's 28% humidity, your fiddle leaf needs misting" without the user having to think about it.
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
      "message": "Indoor humidity is around 28%. Tropical plants benefit from a humidifier or weekly misting."
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
| Humidity < 30%                | warning  | tropical           | mist / humidifier     |
| Humidity > 70%                | info     | succulent          | airflow               |
| Forecast low < 5°C            | warning  | outdoor + tropical | bring indoors         |
| Condition contains rain/storm | info     | outdoor            | skip watering         |
| Temp > 32°C                   | warning  | (all)              | check soil more often |

Test coverage in `tests/unit/services/climate.test.ts`. The mapping is intentional and small; we'd rather miss an edge case than spam users with five tips when one would do.

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
