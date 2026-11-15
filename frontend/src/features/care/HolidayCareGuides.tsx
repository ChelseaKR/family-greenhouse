import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { HOLIDAY_CARE_GUIDES, HOLIDAY_CARE_GUIDES_ON } from './holidayGuideList';

/**
 * The "Holiday plants" care-guide list. Renders nothing while
 * `HOLIDAY_CARE_GUIDES_ON` is false; see holidayGuideList.ts.
 */
export function HolidayCareGuides({
  id,
  as: Heading = 'h2',
  className = 'mt-10',
  on = HOLIDAY_CARE_GUIDES_ON,
}: {
  /** The heading's id, which also labels the section. Unique per page. */
  id: string;
  as?: 'h2' | 'h3';
  className?: string;
  /** For tests; pages leave it to the switch. */
  on?: boolean;
}) {
  const { t } = useTranslation();
  if (!on) return null;

  return (
    <section aria-labelledby={id} className={className}>
      <Heading id={id} className="font-serif text-xl tracking-tight text-ink">
        {t('petSafeSpecies.holidayHeading')}
      </Heading>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        {HOLIDAY_CARE_GUIDES.map((guide) => (
          <li key={guide.slug}>
            <Link
              to={`/care/${guide.slug}`}
              className="text-primary-700 underline hover:text-primary-800"
            >
              {t(guide.nameKey)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
