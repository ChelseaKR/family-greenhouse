import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardDocumentIcon, TvIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import {
  kioskLinkService,
  KIOSK_POLL_CHOICES,
  type IssuedKioskLink,
} from '@/services/kioskLinkService';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { getErrorMessage } from '@/services/api';
import { formatDate } from '@/i18n/format';

/**
 * Set up, revoke, and re-issue the household's kiosk (wall display) link.
 *
 * Two things this screen is deliberately blunt about, because the feature's
 * whole risk profile depends on the household understanding them:
 *
 *   1. The address on the wall screen IS the password. Anyone who photographs
 *      it can see the task list. Re-issuing is one click and kills the old
 *      one, so the copy tells you to do exactly that if the screen was
 *      photographed.
 *   2. The refresh rate costs money in proportion to how often it runs, not
 *      how much anyone uses it. Each choice shows its own monthly figure.
 *
 * The token is shown exactly once, right after issuing. A failed read of the
 * current link renders an error, never "no display is running" — telling an
 * admin nothing is watching their task list when we could not check is the
 * defect this repo names "absence rendered as a value" (ADR 0010).
 */
export function KioskSettings() {
  const { t } = useTranslation();
  const isAdmin = useIsHouseholdAdmin();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<IssuedKioskLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [pollSeconds, setPollSeconds] = useState<number>(300);

  const linkQuery = useQuery({
    queryKey: ['kiosk-link', householdId],
    queryFn: () => kioskLinkService.get(householdId as string),
    enabled: !!householdId,
    staleTime: 60_000,
  });

  const issueMutation = useMutation({
    mutationFn: () => kioskLinkService.issue(householdId as string, pollSeconds),
    onSuccess: (link) => {
      setIssued(link);
      setCopied(false);
      setCopyError(false);
      queryClient.invalidateQueries({ queryKey: ['kiosk-link', householdId] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: () => kioskLinkService.revoke(householdId as string),
    onSuccess: () => {
      setIssued(null);
      queryClient.invalidateQueries({ queryKey: ['kiosk-link', householdId] });
    },
  });

  const handleCopy = async () => {
    if (!issued) return;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  };

  if (linkQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // A settled read with no row means "no display is running". `undefined`
  // after loading means the read FAILED, which is a different sentence.
  const linkUnavailable = linkQuery.data === undefined;
  const activeLink = linkQuery.data ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={t('kiosk.settings.title')}
          description={t('kiosk.settings.description')}
        />

        <Alert variant="warning" className="mb-4">
          {t('kiosk.settings.securityNotice')}
        </Alert>

        {linkUnavailable && (
          <Alert variant="error" className="mb-4">
            {t('kiosk.settings.loadFailed')} {getErrorMessage(linkQuery.error)}
          </Alert>
        )}

        {issued && (
          <div className="mb-4 space-y-3">
            <Alert variant="success" title={t('kiosk.settings.issuedTitle')}>
              {t('kiosk.settings.issuedBody')}
            </Alert>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="text"
                readOnly
                value={issued.url}
                className="input flex-1 bg-gray-50"
                aria-label={t('kiosk.settings.urlLabel')}
              />
              <Button
                variant="secondary"
                onClick={() => void handleCopy()}
                leftIcon={<ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />}
              >
                {copied ? t('kiosk.settings.copied') : t('kiosk.settings.copy')}
              </Button>
            </div>
            {copyError && (
              <p className="text-sm text-red-700" role="alert">
                {t('kiosk.settings.copyFailed')}
              </p>
            )}
          </div>
        )}

        {!linkUnavailable && activeLink && (
          <div className="mb-4 rounded-lg border border-primary-100/70 p-4">
            <p className="text-sm font-medium text-gray-900">
              {t('kiosk.settings.runningSince', { date: formatDate(activeLink.createdAt) })}
            </p>
            <p className="mt-1 text-xs text-gray-600">
              {t('kiosk.settings.currentInterval', {
                label: t(`kiosk.settings.interval.${activeLink.pollIntervalSeconds}`, {
                  defaultValue: String(activeLink.pollIntervalSeconds),
                }),
              })}
            </p>
          </div>
        )}

        {!linkUnavailable && !activeLink && !issued && (
          <p className="mb-4 text-sm text-gray-600">{t('kiosk.settings.none')}</p>
        )}

        <label className="block">
          <span className="label">{t('kiosk.settings.intervalLabel')}</span>
          <select
            className="input"
            value={pollSeconds}
            disabled={!isAdmin}
            onChange={(event) => setPollSeconds(Number(event.target.value))}
          >
            {KIOSK_POLL_CHOICES.map((seconds) => (
              <option key={seconds} value={seconds}>
                {t(`kiosk.settings.interval.${seconds}`)}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-gray-600">
            {t('kiosk.settings.intervalHelp')}
          </span>
        </label>

        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            type="button"
            disabled={!isAdmin}
            isLoading={issueMutation.isPending}
            onClick={() => issueMutation.mutate()}
            leftIcon={<TvIcon className="h-4 w-4" aria-hidden="true" />}
          >
            {activeLink ? t('kiosk.settings.reissue') : t('kiosk.settings.issue')}
          </Button>
          {activeLink && (
            <Button
              type="button"
              variant="secondary"
              disabled={!isAdmin}
              isLoading={revokeMutation.isPending}
              onClick={() => revokeMutation.mutate()}
              leftIcon={<TrashIcon className="h-4 w-4 text-red-500" aria-hidden="true" />}
            >
              {t('kiosk.settings.revoke')}
            </Button>
          )}
        </div>

        {!isAdmin && <p className="mt-3 text-sm text-gray-600">{t('kiosk.settings.adminOnly')}</p>}

        {issueMutation.isError && (
          <Alert variant="error" className="mt-4">
            {getErrorMessage(issueMutation.error)}
          </Alert>
        )}
        {revokeMutation.isError && (
          <Alert variant="error" className="mt-4">
            {getErrorMessage(revokeMutation.error)}
          </Alert>
        )}
      </Card>
    </div>
  );
}
