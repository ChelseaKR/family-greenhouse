/**
 * The seasonal-cadence editor's form ⇄ wire conversion.
 *
 * A separate module from `EditTaskModal` because a file that exports both a
 * component and plain functions loses React Fast Refresh — and because these
 * two are the whole contract worth testing about the editor, without mounting
 * a dialog to reach them.
 */
import { SEASONS, type Season, type SeasonalCadence } from './seasonalCadence';

/** What a season's box can hold: a number, or one of the ways of being empty. */
export type SeasonBoxValue = number | '' | null | undefined;

/**
 * Form boxes → the wire shape. All four empty sends `null`, which CLEARS the
 * profile rather than leaving a stale one behind.
 *
 * An empty box means "this season has no cadence", not zero and not the base
 * frequency. That distinction is the reason the boxes are not pre-filled: a
 * pre-filled spring box would turn "I have not decided about spring" into
 * "spring is exactly the base interval" — a claim the household never made,
 * and one that would then stop tracking the base frequency if it changed.
 *
 * Emptiness is checked HERE, not left to the zod resolver that also strips it.
 * An uncontrolled number input hands back `''`, and `'' === undefined` is
 * false, so a version of this that only tested for `undefined` shipped
 * `{ season: 'spring', frequency: '' }` to the server whenever it was called
 * with raw box values — a blank box travelling as if it were a cadence.
 */
export function cadencesFromForm(
  values: Partial<Record<Season, SeasonBoxValue>>
): SeasonalCadence[] | null {
  const cadences = SEASONS.flatMap((season) => {
    const raw = values[season];
    if (raw === undefined || raw === null || raw === '') return [];
    const frequency = Number(raw);
    return Number.isFinite(frequency) ? [{ season, frequency }] : [];
  });
  return cadences.length > 0 ? cadences : null;
}

/** Wire shape → form boxes; a season with no cadence stays empty. */
export function formFromCadences(
  cadences: SeasonalCadence[] | null | undefined
): Record<Season, number | ''> {
  const boxes = Object.fromEntries(SEASONS.map((s) => [s, '' as number | ''])) as Record<
    Season,
    number | ''
  >;
  for (const cadence of cadences ?? []) boxes[cadence.season] = cadence.frequency;
  return boxes;
}
