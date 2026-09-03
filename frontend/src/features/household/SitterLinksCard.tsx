import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardDocumentIcon, KeyIcon, TrashIcon } from '@heroicons/react/24/outline';
import { householdService, type CreatedSitterLink } from '@/services/householdService';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';
import { formatDate } from '@/i18n/format';
import { groupSitterLinks, sitterLinkState } from './sitterLinkState';
import { toStartOfDayIso, todayLocalDateValue } from './localDates';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Admin-only UI to create, copy, and revoke no-account plant-sitter links.
 * Mirrors the invite-link pattern: the secret token/URL is shown exactly once
 * (right after creation) and never again — the list only shows the link's
 * window + status, so a leaked screenshot of the management page can't be used
 * to access the household. Revoking flips a link to inactive immediately.
 *
 * The window is the whole security model of a sitter link, so this screen
 * treats it as first-class: a link can be scheduled to open on the day the
 * trip starts (the API has always accepted `startsAt`; nothing used to send
 * it, so every link went live the moment it was created), and the list
 * reports each link's real state rather than its revocation flag — see
 * ./sitterLinkState.
 */
export function SitterLinksCard({ householdId }: { householdId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<CreatedSitterLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  // Default the window to two weeks out — a typical trip length.
  const [days, setDays] = useState('14');
  const [startDate, setStartDate] = useState('');
  const [label, setLabel] = useState('');

  const linksQuery = useQuery({
    queryKey: ['sitter-links', householdId],
    queryFn: () => householdService.listSitterLinks(householdId),
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const n = Math.max(1, Math.min(60, parseInt(days, 10) || 14));
      // The length is counted from the day the sitter takes over, not from
      // "now" — otherwise scheduling a link a week ahead of the trip silently
      // spends a week of its own window before anyone needs it.
      const startsAt = startDate ? toStartOfDayIso(startDate) : undefined;
      const from = startsAt ? Date.parse(startsAt) : Date.now();
      const expiresAt = new Date(from + n * DAY_MS).toISOString();
      return householdService.createSitterLink(householdId, {
        expiresAt,
        startsAt,
        label: label.trim() || undefined,
      });
    },
    onSuccess: (link) => {
      setCreated(link);
      setCopied(false);
      setCopyError(false);
      setLabel('');
      setStartDate('');
      queryClient.invalidateQueries({ queryKey: ['sitter-links', householdId] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (linkId: string) => householdService.revokeSitterLink(householdId, linkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sitter-links', householdId] });
    },
  });

  const handleCopy = async () => {
    if (created) {
      setCopyError(false);
      try {
        await navigator.clipboard.writeText(created.url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        setCopyError(true);
      }
    }
  };

  // Real state, not the revocation flag: a row stays `status: 'active'` for
  // days after its window closes (the DynamoDB TTL keeps a three-day buffer
  // and the sweeper lags), and listing those as active told the household a
  // neighbour still had access when they did not.
  const { current: currentLinks, ended: endedLinks } = groupSitterLinks(linksQuery.data ?? []);

  return (
    <Card>
      <CardHeader
        title="Plant-sitter links"
        description="Going away? Share a temporary link so a neighbour or friend can see due care, plant names, current spaces, and placement notes — never your saved city, private notes, or member details. The link expires on its own, and you can revoke it any time."
      />

      {created ? (
        <div className="space-y-3">
          <Alert variant="success" title="Your sitter link is ready">
            Copy it now — for security, we won’t show the full link again. You can always create a
            new one.
          </Alert>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="text"
              readOnly
              value={created.url}
              className="input flex-1 bg-gray-50"
              aria-label="Plant-sitter link"
            />
            <Button
              variant="secondary"
              onClick={handleCopy}
              leftIcon={<ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          {copyError && (
            <p className="text-sm text-red-700" role="alert">
              Could not copy automatically. Select the link and copy it manually.
            </p>
          )}
          <p className="text-xs text-gray-600">
            {sitterLinkState(created) === 'scheduled'
              ? t('household.sitterLinks.windowScheduled', {
                  start: formatDate(created.startsAt),
                  end: formatDate(created.expiresAt),
                })
              : t('household.sitterLinks.windowActive', { end: formatDate(created.expiresAt) })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setCreated(null);
              setCopyError(false);
            }}
          >
            Done
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={t('household.sitterLinks.startsLabel')}
              type="date"
              min={todayLocalDateValue()}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              helperText={t('household.sitterLinks.startsHelp')}
            />
            <Input
              label={t('household.sitterLinks.lengthLabel')}
              type="number"
              min={1}
              max={60}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              helperText={t('household.sitterLinks.lengthHelp')}
            />
            <Input
              className="sm:col-span-2"
              label={t('household.sitterLinks.labelLabel')}
              placeholder="e.g. The Smiths’ plants"
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
              helperText={t('household.sitterLinks.labelHelp')}
            />
          </div>
          <Button
            type="submit"
            isLoading={createMutation.isPending}
            leftIcon={<KeyIcon className="h-4 w-4" aria-hidden="true" />}
          >
            Create sitter link
          </Button>
        </form>
      )}

      {createMutation.isError && (
        <Alert variant="error" className="mt-4">
          {getErrorMessage(createMutation.error)}
        </Alert>
      )}

      {linksQuery.isError && (
        // A failed read is not "no outstanding links". Rendering nothing here
        // looked like "you have no live sitter links" while links that still
        // grant access to the household's task list went un-revokable.
        <Alert variant="error" className="mt-6">
          {t('household.sitterLinksLoadFailed')} {getErrorMessage(linksQuery.error)}
        </Alert>
      )}

      {currentLinks.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-900">
            {t('household.sitterLinks.currentHeading')}
          </h3>
          <ul className="mt-2 divide-y divide-primary-100/60 rounded-lg border border-primary-100/70">
            {currentLinks.map((link) => {
              const scheduled = sitterLinkState(link) === 'scheduled';
              return (
                <li key={link.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-900">
                      {link.label || t('household.sitterLinks.untitled')}
                    </p>
                    <p className="text-xs text-gray-600">
                      {scheduled
                        ? t('household.sitterLinks.windowScheduled', {
                            start: formatDate(link.startsAt),
                            end: formatDate(link.expiresAt),
                          })
                        : t('household.sitterLinks.windowActive', {
                            end: formatDate(link.expiresAt),
                          })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                    {/* State, not status: a scheduled link grants nothing yet,
                        and saying so is the difference between "a neighbour
                        can see our plants" and "they will be able to". */}
                    <span
                      className={
                        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ' +
                        (scheduled
                          ? 'bg-parchment text-gray-700 ring-1 ring-primary-200/50'
                          : 'bg-primary-100 text-primary-900')
                      }
                    >
                      {scheduled
                        ? t('household.sitterLinks.badgeScheduled')
                        : t('household.sitterLinks.badgeActive')}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      isLoading={revokeMutation.isPending && revokeMutation.variables === link.id}
                      onClick={() => revokeMutation.mutate(link.id)}
                      leftIcon={<TrashIcon className="h-4 w-4 text-red-500" aria-hidden="true" />}
                      aria-label={`Revoke sitter link ${link.label || ''}`.trim()}
                    >
                      Revoke
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {endedLinks.length > 0 && (
        // Reassurance, not an action list: these windows closed on their own,
        // so there is nothing left to revoke. Before this, they were listed as
        // "active" with a live-looking Revoke button beside them.
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-900">
            {t('household.sitterLinks.endedHeading')}
          </h3>
          <p className="mt-1 text-xs text-gray-600">{t('household.sitterLinks.endedBody')}</p>
          <ul className="mt-2 space-y-1">
            {endedLinks.slice(0, 3).map((link) => (
              <li key={link.id} className="truncate text-xs text-gray-600">
                {t('household.sitterLinks.endedOn', {
                  label: link.label || t('household.sitterLinks.untitled'),
                  date: formatDate(link.expiresAt),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
