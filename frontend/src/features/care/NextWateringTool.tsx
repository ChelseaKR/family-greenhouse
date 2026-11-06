import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { buttonStyles } from '@/components/buttonStyles';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { buildRecurringAllDayIcs } from '@/lib/ics';
import { registerHrefForPlant } from '@/features/onboarding/guidePlantHandoff';
import { trackGoogleConversion } from '@/services/googleAnalytics';
import { nameInSentence, sentenceName, sentenceStartName } from './plantNames';
import {
  LAST_WATERED_BUCKETS,
  LAST_WATERED_LABELS,
  formatCheckDay,
  isLastWateredBucket,
  nextCheck,
  statedInterval,
  type LastWateredBucket,
} from './nextWatering';

const LINK_CLASS =
  'inline-flex min-h-touch items-center font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-800';

/** Hand a file made on this device to the browser's download. */
function saveFile(filename: string, text: string): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the download a moment to start before the address is released.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/**
 * The care guide's "your next watering" tool, in the "At a glance" water
 * row, in place of the reminder link that row used to hold alone.
 *
 * As served (the prerendered HTML, and the first render in the browser) the
 * row holds exactly what it did before: the reminder link, counted as
 * `glance`. The tool replaces it only once the page has loaded, so the page
 * search engines read, and anyone without JavaScript sees, is unchanged.
 *
 * Then, for a guide whose water line states a number of days
 * (`STATED_INTERVALS`), it asks "When did you last water it?" and answers
 * with a day to check the soil, counted from that stated number. "Not sure"
 * is "Check the soil today", never a guessed date. The answer offers a
 * recurring calendar event made in the browser (nothing is sent anywhere but
 * the visitor's own download; GA gets `care_calendar_add` with the slug), and
 * the reminder link, kept first in the row, carries the answer to sign-up.
 *
 * For every other guide the tool says, in words, that the guide gives no
 * number of days, and offers only the reminder link.
 */
export function NextWateringTool({
  slug,
  commonName,
  guideUrl,
}: {
  slug: string;
  commonName: string;
  /** The guide's own https address, linked from the calendar event. */
  guideUrl: string;
}) {
  const [enhanced, setEnhanced] = useState(false);
  const [last, setLast] = useState<LastWateredBucket | undefined>(undefined);
  const [saved, setSaved] = useState<'idle' | 'saved' | 'failed'>('idle');
  // A fixed id, not useId(): one tool per page, and the markup stays the same
  // from one render to the next (PlantShopLink.test compares two renders).
  const selectId = `next-watering-last-${slug}`;
  useEffect(() => setEnhanced(true), []);

  const name = sentenceName(commonName);
  const interval = statedInterval(slug);

  const reminderLink = PUBLIC_REGISTRATION_AVAILABLE && (
    <Link
      to={registerHrefForPlant(slug, enhanced ? last : undefined)}
      data-testid="care-glance-cta"
      className={LINK_CLASS}
      onClick={() =>
        trackGoogleConversion({
          name: 'landing_cta_click',
          source: 'care_guide',
          placement: enhanced ? 'tool' : 'glance',
          plant: slug,
        })
      }
    >
      Remind me to water my {name} →
    </Link>
  );

  if (!enhanced) {
    return reminderLink ? <dd className="mt-1 text-sm">{reminderLink}</dd> : null;
  }

  if (!interval) {
    return (
      <dd className="mt-1 text-sm" data-testid="next-watering-tool" data-state="no-days">
        {reminderLink}
        <p className="mt-1 text-gray-700" data-testid="next-watering-no-days">
          This guide gives no set number of days for {nameInSentence(commonName)}: its sources go by
          how dry the soil is, not by the calendar, so we don’t give a date.
        </p>
      </dd>
    );
  }

  const check = last ? nextCheck(interval.days, last, new Date()) : undefined;

  const addToCalendar = () => {
    if (!check) return;
    const plant = sentenceStartName(commonName);
    const ics = buildRecurringAllDayIcs({
      uid: `care-${slug}@familygreenhouse.net`,
      start: check.date,
      intervalDays: interval.days,
      summary: `Check the soil: ${plant}`,
      description:
        `Check the soil of your ${name}. If it’s as dry as the care guide says, water. ` +
        `The guide says “${interval.stated}”, so this repeats every ${interval.days} days. ` +
        guideUrl,
      url: guideUrl,
      now: new Date(),
    });
    const ok = saveFile(`${slug}-watering.ics`, ics);
    setSaved(ok ? 'saved' : 'failed');
    if (ok) trackGoogleConversion({ name: 'care_calendar_add', plant: slug });
  };

  return (
    <dd className="mt-1 text-sm" data-testid="next-watering-tool" data-state="days">
      {/* The link stays first, where the row has always held it: with the
          question above it, the ZZ plant's link ended 69px under the
          smallest phone screen (care-cta-above-fold.spec.ts). */}
      {reminderLink}
      <label htmlFor={selectId} className="mt-1 block font-semibold text-gray-900">
        When did you last water it?
      </label>
      <select
        id={selectId}
        data-testid="next-watering-last"
        className="mt-1 min-h-touch w-full max-w-xs rounded-md border border-primary-300 bg-white px-3 text-sm text-gray-900"
        value={last ?? ''}
        onChange={(event) => {
          const value = event.target.value;
          setLast(isLastWateredBucket(value) ? value : undefined);
          setSaved('idle');
        }}
      >
        <option value="">Choose an answer</option>
        {LAST_WATERED_BUCKETS.map((bucket) => (
          <option key={bucket} value={bucket}>
            {LAST_WATERED_LABELS[bucket]}
          </option>
        ))}
      </select>
      <div aria-live="polite">
        {check && (
          <div data-testid="next-watering-result" className="mt-2 text-gray-900">
            <p className="font-semibold">
              {check.today
                ? 'Check the soil today.'
                : `Check the soil around ${formatCheckDay(check.date)}.`}{' '}
              If it’s as dry as this guide says, water.
            </p>
            <p className="mt-1 text-gray-700">
              {last === 'unsure'
                ? 'Since you’re not sure, start with a look today.'
                : `Counted from this guide’s “${interval.stated}”.`}{' '}
              It’s a day to check, not a day to water.
            </p>
            <button
              type="button"
              data-testid="next-watering-calendar"
              className={`${buttonStyles({ variant: 'secondary', size: 'sm' })} mt-2`}
              onClick={addToCalendar}
            >
              Add to my calendar
            </button>
            {saved === 'saved' && (
              <p className="mt-1 text-gray-700">
                Saved a repeating “check the soil” event, every {interval.days} days. Open the file
                to add it to your calendar.
              </p>
            )}
            {saved === 'failed' && (
              <p className="mt-1 text-gray-700">This browser couldn’t save the calendar file.</p>
            )}
          </div>
        )}
      </div>
    </dd>
  );
}
