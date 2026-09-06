import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ClipboardDocumentIcon,
  DocumentTextIcon,
  TrashIcon,
  UserPlusIcon,
} from '@heroicons/react/24/outline';
import {
  caretakerSeatsService,
  type CaretakerSummary,
  type CreatedCaretaker,
} from '@/services/caretakerSeatsService';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { billingService } from '@/services/billingService';
import { getErrorMessage } from '@/services/api';
import { formatDate } from '@/i18n/format';
import { sitterLinkState } from './sitterLinkState';
import { toStartOfDayIso, todayLocalDateValue } from './localDates';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mirrors caretakerService.MAX_CARETAKER_DAYS on the server. */
const MAX_DAYS = 180;

/**
 * Admin-only UI for caretaker seats: a NAMED, revocable, time-boxed identity
 * for someone who looks after the plants — usually someone being paid or
 * thanked for it.
 *
 * Two things distinguish it from the sitter-link card next to it, and both are
 * on screen deliberately:
 *
 *   - The seat has a name, and the card says out loud that every action is
 *     logged under it. That is the whole basis of the visit report.
 *   - The permission surface is printed in full, including what a caretaker
 *     *cannot* do. A credential whose limits are only in the code is a
 *     credential the household has to take on faith.
 *
 * The token is shown exactly once, right after creation, exactly like an
 * invite or a sitter link — so a screenshot of this page later grants nothing.
 *
 * Whether the tier includes seats is read from the plan catalog
 * (`features.caretakerSeats`), three-state per ADR 0010, exactly like
 * AutoHandoffCard. Listing and revoking are never gated: the server gates only
 * creation, so a household that stops paying can still stop a live seat.
 */
export function CaretakerSeatsCard({ householdId }: { householdId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<CreatedCaretaker | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [name, setName] = useState('');
  const [days, setDays] = useState('30');
  const [startDate, setStartDate] = useState('');

  // Listing and revoking are deliberately NOT plan-gated on the server
  // (handlers/caretakers/management.ts gates only `createCaretaker`), because
  // trapping a live credential behind a paywall would be a security bug. So
  // this read runs whatever the plan says.
  const seatsQuery = useQuery({
    queryKey: ['caretaker-seats', householdId],
    queryFn: () => caretakerSeatsService.list(householdId),
  });

  // Whether the tier includes seats is a SERVER fact: the catalog publishes
  // `features.caretakerSeats`, so read it rather than comparing a tier name —
  // a hardcoded `planId === 'greenhouse'` would silently keep the card locked
  // the day the feature is included somewhere else.
  //
  // Three-state (ADR 0010): in flight, known, or unknown. An unknown read —
  // catalog fetch failed, or a rolling deploy whose catalog predates the flag
  // — is rendered as "we couldn't check", never as "your plan doesn't have
  // this". The list below is unaffected either way.
  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });
  const subscriptionQuery = useQuery({
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    staleTime: 60_000,
  });
  const checkingPlan = plansQuery.isLoading || subscriptionQuery.isLoading;
  const plan =
    plansQuery.data && subscriptionQuery.data
      ? plansQuery.data.plans.find((p) => p.id === subscriptionQuery.data.planId)
      : undefined;
  const entitled: boolean | undefined = plan?.features?.caretakerSeats;

  const createMutation = useMutation({
    mutationFn: () => {
      const n = Math.max(1, Math.min(MAX_DAYS, parseInt(days, 10) || 30));
      // The length is counted from the day the caretaker takes over, not from
      // "now" — scheduling ahead should not spend the window before it opens.
      const startsAt = startDate ? toStartOfDayIso(startDate) : undefined;
      const from = startsAt ? Date.parse(startsAt) : Date.now();
      return caretakerSeatsService.create(householdId, {
        name: name.trim(),
        startsAt,
        expiresAt: new Date(from + n * DAY_MS).toISOString(),
      });
    },
    onSuccess: (seat) => {
      setCreated(seat);
      setCopied(false);
      setCopyError(false);
      setName('');
      setStartDate('');
      queryClient.invalidateQueries({ queryKey: ['caretaker-seats', householdId] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (caretakerId: string) => caretakerSeatsService.revoke(householdId, caretakerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['caretaker-seats', householdId] });
    },
  });

  const handleCopy = async () => {
    if (!created) return;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  };

  // Real state, not the revocation flag — a row stays `status: 'active'` for
  // days past its window while the TTL buffer runs out.
  const seats = seatsQuery.data ?? [];
  const live = seats.filter((seat) => {
    const state = sitterLinkState(seat);
    return state === 'active' || state === 'scheduled';
  });
  const ended = seats.filter((seat) => sitterLinkState(seat) === 'expired');

  const windowLabel = (seat: Pick<CaretakerSummary, 'startsAt' | 'expiresAt' | 'status'>) =>
    sitterLinkState(seat) === 'scheduled'
      ? t('caretaker.seats.windowScheduled', {
          start: formatDate(seat.startsAt),
          end: formatDate(seat.expiresAt),
        })
      : t('caretaker.seats.windowActive', { end: formatDate(seat.expiresAt) });

  return (
    <Card>
      <CardHeader
        title={t('caretaker.seats.title')}
        description={t('caretaker.seats.description')}
      />

      <div className="rounded-lg border border-primary-100/70 bg-parchment/60 p-4">
        <h3 className="text-sm font-medium text-gray-900">{t('caretaker.seats.canDoTitle')}</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
          <li>{t('caretaker.seats.canComplete')}</li>
          <li>{t('caretaker.seats.canPhoto')}</li>
          <li>{t('caretaker.seats.canNote')}</li>
        </ul>
        <p className="mt-2 text-xs text-gray-600">{t('caretaker.seats.cannotDo')}</p>
      </div>

      {checkingPlan ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-600" role="status">
          <LoadingSpinner size="sm" />
          {t('caretaker.seats.checking')}
        </div>
      ) : entitled === undefined ? (
        // Could not read the catalog. That is not "your plan doesn't include
        // seats" — say which one it is, and do not offer the create form on a
        // guess either way.
        <Alert variant="warning" className="mt-4">
          {t('caretaker.seats.checkFailed')}
        </Alert>
      ) : !entitled ? (
        <Alert variant="info" className="mt-4" title={t('caretaker.seats.lockedTitle')}>
          {t('caretaker.seats.lockedBody')}
        </Alert>
      ) : null}

      {created ? (
        <div className="mt-4 space-y-3">
          <Alert
            variant="success"
            title={t('caretaker.seats.createdTitle', { name: created.name })}
          >
            {t('caretaker.seats.createdBody')}
          </Alert>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="text"
              readOnly
              value={created.url}
              className="input flex-1 bg-gray-50"
              aria-label={t('caretaker.seats.createdTitle', { name: created.name })}
            />
            <Button
              variant="secondary"
              onClick={handleCopy}
              leftIcon={<ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />}
            >
              {copied ? t('caretaker.seats.copied') : t('caretaker.seats.copy')}
            </Button>
          </div>
          {copyError && (
            <p className="text-sm text-red-700" role="alert">
              {t('caretaker.seats.copyFailed')}
            </p>
          )}
          <p className="text-xs text-gray-600">{windowLabel(created)}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setCreated(null);
              setCopyError(false);
            }}
          >
            {t('common.done')}
          </Button>
        </div>
      ) : (
        entitled === true && (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                className="sm:col-span-2"
                label={t('caretaker.seats.nameLabel')}
                value={name}
                maxLength={60}
                required
                onChange={(e) => setName(e.target.value)}
                helperText={t('caretaker.seats.nameHelp')}
              />
              <Input
                label={t('caretaker.seats.startsLabel')}
                type="date"
                min={todayLocalDateValue()}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                helperText={t('caretaker.seats.startsHelp')}
              />
              <Input
                label={t('caretaker.seats.lengthLabel')}
                type="number"
                min={1}
                max={MAX_DAYS}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                helperText={t('caretaker.seats.lengthHelp')}
              />
            </div>
            <Button
              type="submit"
              isLoading={createMutation.isPending}
              disabled={name.trim().length === 0}
              leftIcon={<UserPlusIcon className="h-4 w-4" aria-hidden="true" />}
            >
              {t('caretaker.seats.create')}
            </Button>
          </form>
        )
      )}

      {createMutation.isError && (
        <Alert variant="error" className="mt-4">
          {t('caretaker.seats.createFailed')} {getErrorMessage(createMutation.error)}
        </Alert>
      )}

      {seatsQuery.isError && (
        // A failed read is not "you have no caretakers". Rendering an empty
        // list here would tell the household nobody holds a live credential
        // while someone still does, and hide the only control that stops it.
        <Alert variant="error" className="mt-6">
          {t('caretaker.seats.loadFailed')} {getErrorMessage(seatsQuery.error)}
        </Alert>
      )}

      {seatsQuery.isSuccess && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-900">
            {t('caretaker.seats.currentHeading')}
          </h3>
          {live.length === 0 ? (
            <p className="mt-1 text-sm text-gray-600">{t('caretaker.seats.none')}</p>
          ) : (
            <ul className="mt-2 divide-y divide-primary-100/60 rounded-lg border border-primary-100/70">
              {live.map((seat) => {
                const scheduled = sitterLinkState(seat) === 'scheduled';
                return (
                  <li key={seat.id} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900">{seat.name}</p>
                      <p className="text-xs text-gray-600">{windowLabel(seat)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                      <span
                        className={
                          'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ' +
                          (scheduled
                            ? 'bg-parchment text-gray-700 ring-1 ring-primary-200/50'
                            : 'bg-primary-100 text-primary-900')
                        }
                      >
                        {scheduled
                          ? t('caretaker.seats.badgeScheduled')
                          : t('caretaker.seats.badgeActive')}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={revokeMutation.isPending && revokeMutation.variables === seat.id}
                        onClick={() => revokeMutation.mutate(seat.id)}
                        leftIcon={<TrashIcon className="h-4 w-4 text-red-500" aria-hidden="true" />}
                        aria-label={`${t('caretaker.seats.revoke')} — ${seat.name}`}
                      >
                        {t('caretaker.seats.revoke')}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-gray-600">{t('caretaker.seats.revokeHint')}</p>

          {ended.length > 0 && (
            <ul className="mt-3 space-y-1">
              {ended.slice(0, 3).map((seat) => (
                <li key={seat.id} className="truncate text-xs text-gray-600">
                  {seat.name} — {t('caretaker.seats.badgeEnded')} {formatDate(seat.expiresAt)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="mt-6">
        <Link
          to="/household/caretaker-report"
          className="inline-flex items-center gap-1.5 text-sm text-primary-700 underline hover:text-primary-800"
        >
          <DocumentTextIcon className="h-4 w-4" aria-hidden="true" />
          {t('caretaker.seats.reportLink')}
        </Link>
      </p>
    </Card>
  );
}
