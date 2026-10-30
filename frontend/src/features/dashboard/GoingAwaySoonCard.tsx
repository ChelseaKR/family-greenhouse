import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PaperAirplaneIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { Card } from '@/components/Card';
import { buttonStyles } from '@/components/buttonStyles';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { usePrefsStore } from '@/store/prefsStore';
import { householdService } from '@/services/householdService';
import { plantService } from '@/services/plantService';
import { groupSitterLinks } from '@/features/household/sitterLinkState';

const DISMISSAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Where the card leads: the sitter-link form, opened for a trip. */
export const GOING_AWAY_ROUTE = '/household?away=1#sitter-links';

/**
 * "Going away soon?": a quiet dashboard entry into the sitter-link flow
 * (2026-10-23).
 *
 * Sitter links are free and are the product's answer to the question every
 * plant owner has before a trip, but the only way to them was the Household
 * page. This card says they exist, on every plan, and opens the form. What
 * Garden adds for a trip is said there, by GoingAwayOffer, and only to a free
 * household; this card names no plan and no price.
 *
 * It shows only when it can be useful and true: the household has at least
 * one plant (a sitter link to nothing helps nobody) and a SETTLED sitter-link
 * read found none live. A failed or pending read hides it rather than
 * guessing. "Not now" hides it on this device for 30 days, like the
 * shared-care prompt, and changes nothing for anyone else.
 */
export function GoingAwaySoonCard() {
  const { t } = useTranslation();
  const { householdId, householdQuery } = useActiveHousehold();
  const dismissedUntil = usePrefsStore((state) =>
    householdId ? state.goingAwayDismissedUntil[householdId] : undefined
  );
  const dismiss = usePrefsStore((state) => state.dismissGoingAway);

  // Same keys the dashboard and SitterLinksCard use, so this adds at most the
  // one sitter-link read.
  const plantsQuery = useQuery(
    householdQuery(
      (hh) => ['plants', hh],
      () => plantService.getPlants()
    )
  );
  const linksQuery = useQuery({
    queryKey: ['sitter-links', householdId],
    queryFn: () => householdService.listSitterLinks(householdId!),
    enabled: Boolean(householdId),
  });

  const isDismissed = dismissedUntil ? Date.parse(dismissedUntil) > Date.now() : false;
  if (!householdId || isDismissed) return null;
  if (!plantsQuery.isSuccess || plantsQuery.data.length === 0) return null;
  if (!linksQuery.isSuccess || groupSitterLinks(linksQuery.data).current.length > 0) return null;

  return (
    <Card variant="paper" className="border-primary-200/70">
      <section aria-labelledby="going-away-soon-title" className="flex items-start gap-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 ring-1 ring-primary-200/60"
          aria-hidden="true"
        >
          <PaperAirplaneIcon className="h-5 w-5 text-primary-800" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h2 id="going-away-soon-title" className="font-serif text-lg text-ink">
              {t('goingAwaySoon.title')}
            </h2>
            <button
              type="button"
              onClick={() =>
                dismiss(householdId, new Date(Date.now() + DISMISSAL_WINDOW_MS).toISOString())
              }
              className="inline-flex min-h-touch shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-gray-600 transition-colors hover:bg-paper/80 hover:text-ink focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500"
              aria-label={t('goingAwaySoon.dismissAria')}
            >
              <XMarkIcon className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t('goingAwaySoon.notNow')}</span>
            </button>
          </div>
          <p className="mt-1 text-sm text-gray-700">{t('goingAwaySoon.body')}</p>
          <p className="mt-3">
            <Link to={GOING_AWAY_ROUTE} className={buttonStyles({ size: 'sm' })}>
              {t('goingAwaySoon.action')}
            </Link>
          </p>
        </div>
      </section>
    </Card>
  );
}
