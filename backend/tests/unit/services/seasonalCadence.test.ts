import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_SEASONAL_CADENCES,
  SEASONS,
  duplicateSeasons,
  hemisphereForLocation,
  nextCadenceChange,
  resolveCadence,
  seasonForMonth,
  type Season,
  type SeasonalCadence,
} from '../../../src/services/seasonalCadence.js';

/**
 * The profile from the issue's worked example, expressed the way the model
 * stores it: a growing-season cadence and a dormant-season one.
 */
const SEVEN_FOURTEEN: SeasonalCadence[] = [
  { season: 'spring', frequency: 7 },
  { season: 'summer', frequency: 7 },
  { season: 'autumn', frequency: 14 },
  { season: 'winter', frequency: 14 },
];

/** Local-zone midday on a date. Midday, so no fixture sits on a day boundary. */
const at = (year: number, monthIndex: number, day: number) =>
  new Date(year, monthIndex, day, 12, 0, 0, 0);

describe('seasonForMonth', () => {
  // The whole table, both hemispheres, because the only interesting months are
  // the boundaries and a spot check would sit in the middle of a season where
  // an off-by-one cannot show up.
  const northern: Season[] = [
    'winter', // Jan
    'winter', // Feb
    'spring', // Mar
    'spring', // Apr
    'spring', // May
    'summer', // Jun
    'summer', // Jul
    'summer', // Aug
    'autumn', // Sep
    'autumn', // Oct
    'autumn', // Nov
    'winter', // Dec
  ];

  it.each(northern.map((season, monthIndex) => ({ monthIndex, season })))(
    'month $monthIndex is $season in the north',
    ({ monthIndex, season }) => {
      expect(seasonForMonth('north', monthIndex)).toBe(season);
    }
  );

  it('reads the same table six months out of phase in the south', () => {
    for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
      expect(seasonForMonth('south', monthIndex)).toBe(northern[(monthIndex + 6) % 12]);
    }
  });

  it('puts every month in exactly one season, and uses all four', () => {
    for (const hemisphere of ['north', 'south'] as const) {
      const seen = new Set(
        Array.from({ length: 12 }, (_, monthIndex) => seasonForMonth(hemisphere, monthIndex))
      );
      expect([...seen].sort()).toEqual([...SEASONS].sort());
    }
  });

  it('normalises out-of-range and negative month indices', () => {
    // Date arithmetic overflows months freely (`new Date(y, 13, 1)`), so the
    // helper must not depend on its caller having normalised first.
    expect(seasonForMonth('north', 12)).toBe(seasonForMonth('north', 0));
    expect(seasonForMonth('north', -1)).toBe(seasonForMonth('north', 11));
    expect(seasonForMonth('south', 25)).toBe(seasonForMonth('south', 1));
  });
});

describe('hemisphereForLocation', () => {
  it('reads a positive latitude as north and a negative one as south', () => {
    expect(hemisphereForLocation({ lat: 52.52 })).toBe('north'); // Berlin
    expect(hemisphereForLocation({ lat: -37.81 })).toBe('south'); // Melbourne
  });

  it('reads the equator as north, matching the shipped seasonalHomes helper', () => {
    expect(hemisphereForLocation({ lat: 0 })).toBe('north');
  });

  it('reads a missing, malformed or non-finite location as no hemisphere', () => {
    expect(hemisphereForLocation(null)).toBeNull();
    expect(hemisphereForLocation(undefined)).toBeNull();
    expect(hemisphereForLocation({})).toBeNull();
    expect(hemisphereForLocation({ lat: '52.52' as unknown as number })).toBeNull();
    expect(hemisphereForLocation({ lat: Number.NaN })).toBeNull();
    expect(hemisphereForLocation({ lat: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('resolveCadence', () => {
  // The issue's acceptance criterion, verbatim. 15 Nov and 15 May are the two
  // dates it names; both are mid-month, so this pair alone cannot catch a
  // boundary error — the boundary sweep below is what does that.
  it('uses the dormant cadence on 15 Nov and the growing one on 15 May, in the north', () => {
    expect(resolveCadence(9, SEVEN_FOURTEEN, 'north', at(2026, 10, 15))).toEqual({
      frequency: 14,
      source: 'seasonal',
      season: 'autumn',
      reason: null,
    });
    expect(resolveCadence(9, SEVEN_FOURTEEN, 'north', at(2026, 4, 15))).toEqual({
      frequency: 7,
      source: 'seasonal',
      season: 'spring',
      reason: null,
    });
  });

  it('reverses both answers for a southern-hemisphere household', () => {
    expect(resolveCadence(9, SEVEN_FOURTEEN, 'south', at(2026, 10, 15)).frequency).toBe(7);
    expect(resolveCadence(9, SEVEN_FOURTEEN, 'south', at(2026, 4, 15)).frequency).toBe(14);
  });

  it('gives the two hemispheres opposite cadences in every month of the year', () => {
    // The strong form of "a southern household gets the reverse": not two
    // sampled dates, every month. It holds because the profile is symmetric
    // (spring/summer share one number, autumn/winter the other) and the
    // hemispheres are exactly six months apart.
    for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
      const north = resolveCadence(9, SEVEN_FOURTEEN, 'north', at(2026, monthIndex, 15));
      const south = resolveCadence(9, SEVEN_FOURTEEN, 'south', at(2026, monthIndex, 15));
      expect(north.frequency).not.toBe(south.frequency);
    }
  });

  it('changes cadence on the first of the month, not part-way through it', () => {
    // The northern autumn→winter boundary. `at()` uses local midday because
    // the suite pins TZ=UTC to the deployed Lambdas' zone; a fixture at
    // midnight would be the one instant a zone slip could hide behind.
    const lastOfAutumn = resolveCadence(9, SEVEN_FOURTEEN, 'north', at(2026, 10, 30));
    const firstOfWinter = resolveCadence(9, SEVEN_FOURTEEN, 'north', at(2026, 11, 1));
    expect(lastOfAutumn.season).toBe('autumn');
    expect(firstOfWinter.season).toBe('winter');
  });

  it('sweeps every season boundary in both hemispheres', () => {
    for (const hemisphere of ['north', 'south'] as const) {
      for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
        const firstOfMonth = resolveCadence(9, SEVEN_FOURTEEN, hemisphere, at(2026, monthIndex, 1));
        const lastOfMonth = resolveCadence(9, SEVEN_FOURTEEN, hemisphere, at(2026, monthIndex, 28));
        expect(firstOfMonth.season).toBe(lastOfMonth.season);
        expect(firstOfMonth.season).toBe(seasonForMonth(hemisphere, monthIndex));
      }
    }
  });

  it('falls back to the base frequency with no_profile when there is no profile', () => {
    for (const empty of [null, undefined, [] as SeasonalCadence[]]) {
      expect(resolveCadence(9, empty, 'north', at(2026, 10, 15))).toEqual({
        frequency: 9,
        source: 'base',
        season: null,
        reason: 'no_profile',
      });
    }
  });

  it('distinguishes "no location" from "the household read failed"', () => {
    // The distinction is the point: one is a settled fact the UI can act on
    // ("set a location"), the other is a transient failure it must not
    // present as one. Both keep today's schedule behaviour.
    const noLocation = resolveCadence(9, SEVEN_FOURTEEN, null, at(2026, 10, 15));
    expect(noLocation).toEqual({
      frequency: 9,
      source: 'base',
      season: null,
      reason: 'no_location',
    });

    const readFailed = resolveCadence(
      9,
      SEVEN_FOURTEEN,
      null,
      at(2026, 10, 15),
      'household_unavailable'
    );
    expect(readFailed.reason).toBe('household_unavailable');
    expect(readFailed.frequency).toBe(9);
    expect(readFailed.season).toBeNull();
  });

  it('names the season it knows even when that season has no cadence set', () => {
    const winterOnly: SeasonalCadence[] = [{ season: 'winter', frequency: 21 }];
    const inAutumn = resolveCadence(9, winterOnly, 'north', at(2026, 10, 15));
    expect(inAutumn).toEqual({
      frequency: 9,
      source: 'base',
      season: 'autumn',
      reason: 'season_unset',
    });
    // …and still uses the cadence in the season it does cover.
    expect(resolveCadence(9, winterOnly, 'north', at(2026, 0, 15)).frequency).toBe(21);
  });

  it('never returns a null or zero frequency, whatever the inputs', () => {
    // A completion must always advance the schedule. "Absence rendered as a
    // value" is the defect this guards from the other side: the number is
    // always real, and `reason` carries the absence instead.
    const cases: (readonly [SeasonalCadence[] | null, 'north' | 'south' | null])[] = [
      [SEVEN_FOURTEEN, 'north'],
      [SEVEN_FOURTEEN, 'south'],
      [SEVEN_FOURTEEN, null],
      [null, 'north'],
      [[{ season: 'winter', frequency: 3 }], 'north'],
    ];
    for (const [cadences, hemisphere] of cases) {
      for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
        const resolved = resolveCadence(9, cadences, hemisphere, at(2026, monthIndex, 15));
        expect(resolved.frequency).toBeGreaterThan(0);
        expect(Number.isInteger(resolved.frequency)).toBe(true);
        // `reason` is null exactly when a seasonal cadence was used.
        expect(resolved.reason === null).toBe(resolved.source === 'seasonal');
      }
    }
  });
});

describe('nextCadenceChange', () => {
  it('counts down to the next change in the number, not the next season', () => {
    // 7/7/14/14 changes twice a year. From mid-November (northern autumn, 14
    // days) the next different number is the spring 7, on 1 March.
    const change = nextCadenceChange(9, SEVEN_FOURTEEN, 'north', at(2026, 10, 15));
    expect(change).toEqual(new Date(2027, 2, 1, 0, 0, 0, 0));

    // From mid-May (spring, 7 days) the next different number is 1 September,
    // when autumn's 14 starts — NOT 1 June, when summer starts at the same 7.
    const fromSpring = nextCadenceChange(9, SEVEN_FOURTEEN, 'north', at(2026, 4, 15));
    expect(fromSpring).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
  });

  it('returns null when the cadence never changes', () => {
    const flat: SeasonalCadence[] = SEASONS.map((season) => ({ season, frequency: 10 }));
    expect(nextCadenceChange(9, flat, 'north', at(2026, 4, 15))).toBeNull();
  });

  it('returns null when there is no profile or no hemisphere', () => {
    expect(nextCadenceChange(9, null, 'north', at(2026, 4, 15))).toBeNull();
    expect(nextCadenceChange(9, [], 'north', at(2026, 4, 15))).toBeNull();
    expect(nextCadenceChange(9, SEVEN_FOURTEEN, null, at(2026, 4, 15))).toBeNull();
  });

  it('finds the change even when the base frequency is the one in force', () => {
    // A partial profile: autumn unset, so the current number is the task's own
    // 9, and the change is the start of winter's 21.
    const winterOnly: SeasonalCadence[] = [{ season: 'winter', frequency: 21 }];
    expect(nextCadenceChange(9, winterOnly, 'north', at(2026, 10, 15))).toEqual(
      new Date(2026, 11, 1, 0, 0, 0, 0)
    );
  });

  it('returns a date the resolver agrees has the new cadence', () => {
    // Guards the walk itself: whatever date it reports, resolving AT that date
    // must give a different number, and the day before must still give the old
    // one. A loop that stepped a month too far would pass the first assertion
    // and fail the second.
    const from = at(2026, 10, 15);
    const current = resolveCadence(9, SEVEN_FOURTEEN, 'north', from);
    const change = nextCadenceChange(9, SEVEN_FOURTEEN, 'north', from);
    expect(change).not.toBeNull();
    const onChange = resolveCadence(9, SEVEN_FOURTEEN, 'north', change as Date);
    const dayBefore = new Date((change as Date).getTime() - 24 * 60 * 60 * 1000);
    expect(onChange.frequency).not.toBe(current.frequency);
    expect(resolveCadence(9, SEVEN_FOURTEEN, 'north', dayBefore).frequency).toBe(current.frequency);
  });
});

describe('duplicateSeasons', () => {
  it('accepts one cadence per season and rejects a repeat', () => {
    expect(duplicateSeasons(SEVEN_FOURTEEN)).toEqual([]);
    expect(
      duplicateSeasons([
        { season: 'winter', frequency: 14 },
        { season: 'winter', frequency: 21 },
      ])
    ).toEqual(['winter']);
  });

  it('caps the profile at one entry per season', () => {
    expect(MAX_SEASONAL_CADENCES).toBe(SEASONS.length);
    expect(SEVEN_FOURTEEN).toHaveLength(MAX_SEASONAL_CADENCES);
  });
});

/**
 * The server's month table and the client's mirror must not drift.
 *
 * The server decides what the schedule DOES; the client
 * (`frontend/src/features/tasks/seasonalCadence.ts`) decides what the
 * household is TOLD it does. A household reading "summer cadence · every 7
 * days" on a task the server is advancing by 14 is a worse bug than either
 * table being wrong on its own, because nothing in the product disagrees with
 * itself loudly enough for anyone to notice.
 *
 * This reads the client's source and re-derives its table, so a change to
 * either side reddens here. It deliberately does NOT skip when the file cannot
 * be read: a drift gate that quietly passes when it cannot see its subject
 * cannot fail on the very thing it exists for. A monorepo checkout always has
 * both workspaces, so an unreadable file is a real failure.
 */
describe('agreement with the frontend mirror', () => {
  const mirrorPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../frontend/src/features/tasks/seasonalCadence.ts'
  );

  const mirrorSource = () => readFileSync(mirrorPath, 'utf8');

  it('carries the same northern month table', () => {
    const table = mirrorSource().match(
      /const NORTHERN_SEASON_BY_MONTH: readonly Season\[] = \[([\s\S]*?)\];/
    );
    expect(table, `frontend NORTHERN_SEASON_BY_MONTH not found in ${mirrorPath}`).not.toBeNull();
    const mirrorTable = [...(table as RegExpMatchArray)[1].matchAll(/'(\w+)'/g)].map(
      (m) => m[1] as Season
    );
    expect(mirrorTable).toHaveLength(12);
    for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
      expect(seasonForMonth('north', monthIndex)).toBe(mirrorTable[monthIndex]);
    }
  });

  it('carries the same hemisphere offset and the same four seasons', () => {
    const source = mirrorSource();
    const offset = source.match(/const HEMISPHERE_MONTH_OFFSET = (\d+);/);
    expect(offset, 'frontend HEMISPHERE_MONTH_OFFSET not found').not.toBeNull();
    expect(Number((offset as RegExpMatchArray)[1])).toBe(6);
    expect(source).toContain("export const SEASONS = ['spring', 'summer', 'autumn', 'winter']");
    expect([...SEASONS]).toEqual(['spring', 'summer', 'autumn', 'winter']);
  });

  it('agrees on the equator and on a missing latitude', () => {
    // Both sides must read lat 0 as north and a missing latitude as unknown;
    // a client that guessed north for "no location" would render a cadence the
    // server is not using.
    const source = mirrorSource();
    expect(source).toContain('return latitude < 0 ? ');
    expect(hemisphereForLocation({ lat: 0 })).toBe('north');
    expect(hemisphereForLocation(null)).toBeNull();
  });
});
