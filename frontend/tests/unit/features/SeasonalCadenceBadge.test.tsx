import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeasonalCadenceBadge } from '@/features/tasks/taskRowExtras';
import { cadencesFromForm, formFromCadences } from '@/features/tasks/cadenceForm';
import type { SeasonalCadence } from '@/features/tasks/seasonalCadence';

const SEVEN_FOURTEEN: SeasonalCadence[] = [
  { season: 'spring', frequency: 7 },
  { season: 'summer', frequency: 7 },
  { season: 'autumn', frequency: 14 },
  { season: 'winter', frequency: 14 },
];

const task = (seasonalCadences: SeasonalCadence[] | null) => ({
  frequency: 9,
  seasonalCadences,
});

/** Berlin and Melbourne — one either side of the equator. */
const BERLIN = 52.52;
const MELBOURNE = -37.81;

afterEach(() => {
  vi.useRealTimers();
});

describe('SeasonalCadenceBadge', () => {
  it('names the cadence in force and when it changes', () => {
    // Mid-November in the north: the dormant 14, changing to spring's 7 on
    // 1 March. The base frequency is 9 and must appear nowhere.
    render(
      <SeasonalCadenceBadge
        task={task(SEVEN_FOURTEEN)}
        latitude={BERLIN}
        now={new Date(2026, 10, 15, 12)}
      />
    );
    expect(screen.getByText(/every 14 days/)).toBeInTheDocument();
    expect(screen.getByText(/autumn cadence/)).toBeInTheDocument();
    expect(screen.queryByText(/9 days/)).not.toBeInTheDocument();
  });

  it('gives a southern-hemisphere household the opposite cadence on the same date', () => {
    render(
      <SeasonalCadenceBadge
        task={task(SEVEN_FOURTEEN)}
        latitude={MELBOURNE}
        now={new Date(2026, 10, 15, 12)}
      />
    );
    expect(screen.getByText(/every 7 days/)).toBeInTheDocument();
    expect(screen.getByText(/spring cadence/)).toBeInTheDocument();
  });

  it('says seasons are unavailable rather than assuming a hemisphere', () => {
    // The household asked for seasonal scheduling and is not getting it. The
    // failure mode this guards is the badge quietly rendering "autumn cadence"
    // — a season nobody's location supports — which would be a number the
    // schedule is not actually using.
    for (const latitude of [null, undefined, Number.NaN]) {
      const { unmount } = render(
        <SeasonalCadenceBadge
          task={task(SEVEN_FOURTEEN)}
          latitude={latitude}
          now={new Date(2026, 10, 15, 12)}
        />
      );
      expect(screen.getByText(/Seasons unavailable/)).toBeInTheDocument();
      expect(screen.queryByText(/cadence/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('renders nothing at all for a task with no seasonal profile', () => {
    // Every task in production. The row's own interval line is the whole
    // answer there, and a badge repeating it would be noise.
    const { container } = render(
      <SeasonalCadenceBadge task={task(null)} latitude={BERLIN} now={new Date(2026, 10, 15, 12)} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to the base interval, named by season, when that season is unset', () => {
    render(
      <SeasonalCadenceBadge
        task={task([{ season: 'winter', frequency: 21 }])}
        latitude={BERLIN}
        now={new Date(2026, 10, 15, 12)}
      />
    );
    // November is autumn, which this profile does not cover, so the base 9 is
    // what the schedule uses — and the badge says 9, not 21.
    expect(screen.getByText(/every 9 days/)).toBeInTheDocument();
    expect(screen.getByText(/autumn cadence/)).toBeInTheDocument();
  });

  it('drops the "until" clause when the cadence never changes', () => {
    render(
      <SeasonalCadenceBadge
        task={task([
          { season: 'spring', frequency: 10 },
          { season: 'summer', frequency: 10 },
          { season: 'autumn', frequency: 10 },
          { season: 'winter', frequency: 10 },
        ])}
        latitude={BERLIN}
        now={new Date(2026, 10, 15, 12)}
      />
    );
    expect(screen.getByText(/every 10 days/)).toBeInTheDocument();
    expect(screen.queryByText(/until/)).not.toBeInTheDocument();
  });
});

describe('the editor’s form ⇄ wire conversion', () => {
  it('round-trips a profile without inventing or dropping a season', () => {
    expect(cadencesFromForm(formFromCadences(SEVEN_FOURTEEN))).toEqual(SEVEN_FOURTEEN);
  });

  it('leaves an unset season empty rather than pre-filling the base frequency', () => {
    // Pre-filling would silently convert "undecided" into "same as the base",
    // and that claim would then stop tracking the base if it ever changed.
    const boxes = formFromCadences([{ season: 'winter', frequency: 21 }]);
    expect(boxes).toEqual({ spring: '', summer: '', autumn: '', winter: 21 });
    expect(cadencesFromForm(boxes)).toEqual([{ season: 'winter', frequency: 21 }]);
  });

  it('sends null when every box is empty, so the profile is cleared not stranded', () => {
    expect(cadencesFromForm(formFromCadences(null))).toBeNull();
    expect(cadencesFromForm({})).toBeNull();
  });

  it('emits seasons in a stable order regardless of the stored order', () => {
    const scrambled: SeasonalCadence[] = [
      { season: 'winter', frequency: 14 },
      { season: 'spring', frequency: 7 },
    ];
    expect(cadencesFromForm(formFromCadences(scrambled))).toEqual([
      { season: 'spring', frequency: 7 },
      { season: 'winter', frequency: 14 },
    ]);
  });
});
