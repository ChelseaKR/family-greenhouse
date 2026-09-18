import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChatBubbleLeftRightIcon, PaperAirplaneIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { Input } from '@/components/Input';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import {
  CHANNEL_PLATFORMS,
  channelErrorCode,
  householdChannelService,
  type ChannelLocale,
  type ChannelPlatform,
  type HouseholdChannelSummary,
  type TestPostResult,
} from '@/services/householdChannelService';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { getErrorMessage } from '@/services/api';
import { formatDate } from '@/i18n/format';
import { resolveBrowserTimeZone } from '@/utils/timeZone';

const URL_ERROR_CODES = new Set([
  'not_a_url',
  'too_long',
  'not_https',
  'has_credentials',
  'has_port',
  'has_query',
  'wrong_host',
  'ip_literal',
  'private_host',
  'wrong_path',
  'url_required',
  'unresolvable',
]);

interface Draft {
  platform: ChannelPlatform;
  url: string;
  dailyDue: boolean;
  upForGrabs: boolean;
  quietStart: string;
  quietEnd: string;
  locale: ChannelLocale;
}

function draftFrom(channel: HouseholdChannelSummary | null, uiLocale: string): Draft {
  return {
    platform: channel?.platform ?? 'discord',
    url: '',
    dailyDue: channel?.events.dailyDue ?? true,
    upForGrabs: channel?.events.upForGrabs ?? true,
    quietStart: channel?.quietStart ?? '',
    quietEnd: channel?.quietEnd ?? '',
    locale: channel?.locale ?? (uiLocale.startsWith('es') ? 'es' : 'en'),
  };
}

/**
 * Connect the household's Discord, Slack or Matrix channel (#674).
 *
 * Three things this card is deliberately plain about:
 *
 *   1. **What leaves the app.** Plant names, task names and due dates — and
 *      the card says so above the form, because everyone in that chat reads
 *      every post.
 *   2. **The address is a password.** It is typed into a password field, sent
 *      once, and never shown again: the card only ever has the masked form.
 *   3. **When posting stopped, and why.** A channel the server switched off
 *      after repeated errors is the one moment an admin needs telling; the
 *      reason and the way back are shown here, in words.
 *
 * A failed read renders "could not check", never "not connected" (ADR 0010).
 */
export function HouseholdChannelSettings() {
  const { t, i18n } = useTranslation();
  const isAdmin = useIsHouseholdAdmin();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const formId = useId();
  const zone = resolveBrowserTimeZone() ?? 'UTC';
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null, i18n.language));
  const [notice, setNotice] = useState<'saved' | 'disconnected' | null>(null);
  const [testResult, setTestResult] = useState<TestPostResult | null>(null);

  const queryKey = ['household-channel', householdId];
  const channelQuery = useQuery({
    queryKey,
    queryFn: () => householdChannelService.get(householdId as string),
    enabled: !!householdId && isAdmin,
    staleTime: 60_000,
  });
  const channel = channelQuery.data?.channel ?? null;

  // Re-seed the form from the server whenever the stored channel changes.
  useEffect(() => {
    setDraft(draftFrom(channelQuery.data?.channel ?? null, i18n.language));
  }, [channelQuery.data, i18n.language]);

  const saveMutation = useMutation({
    mutationFn: () =>
      householdChannelService.save(householdId as string, {
        platform: draft.platform,
        ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
        events: { dailyDue: draft.dailyDue, upForGrabs: draft.upForGrabs },
        quietStart: draft.quietStart,
        quietEnd: draft.quietEnd,
        timezone: channel?.timezone ?? zone,
        locale: draft.locale,
      }),
    onSuccess: (state) => {
      queryClient.setQueryData(queryKey, state);
      setNotice('saved');
      setTestResult(null);
    },
  });

  const testMutation = useMutation({
    mutationFn: () => householdChannelService.test(householdId as string),
    onSuccess: (result) => {
      setTestResult(result);
      setNotice(null);
      queryClient.setQueryData(queryKey, { available: true, channel: result.channel });
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => householdChannelService.remove(householdId as string),
    onSuccess: () => {
      queryClient.setQueryData(queryKey, { available: true, channel: null });
      setNotice('disconnected');
      setTestResult(null);
    },
  });

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader
          title={t('householdChannel.title')}
          description={t('householdChannel.description')}
        />
        <p className="text-sm text-gray-600">{t('householdChannel.adminOnly')}</p>
      </Card>
    );
  }

  if (channelQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const readFailed = channelQuery.data === undefined;
  const available = channelQuery.data?.available ?? false;
  const platformChanged = !!channel && draft.platform !== channel.platform;
  const needsUrl = !channel || platformChanged;
  const quietHalfSet = (draft.quietStart === '') !== (draft.quietEnd === '');

  const saveCode = channelErrorCode(saveMutation.error);
  const saveError =
    saveMutation.isError &&
    (saveCode && URL_ERROR_CODES.has(saveCode)
      ? t(`householdChannel.urlError.${saveCode}`)
      : getErrorMessage(saveMutation.error));

  const field = (key: keyof Draft) => `${formId}-${key}`;

  return (
    <Card>
      <CardHeader
        title={t('householdChannel.title')}
        description={t('householdChannel.description')}
      />

      <Alert variant="info" className="mb-4">
        {t('householdChannel.privacy')}
      </Alert>

      {readFailed && (
        <Alert variant="error" className="mb-4">
          {t('householdChannel.loadFailed')} {getErrorMessage(channelQuery.error)}
        </Alert>
      )}

      {!readFailed && !available && (
        <p className="mb-4 text-sm text-gray-600">{t('householdChannel.unavailable')}</p>
      )}

      {!readFailed && channel?.status === 'disabled' && channel.disabledReason && (
        <Alert variant="error" className="mb-4" title={t('householdChannel.stoppedTitle')}>
          {t('householdChannel.stoppedBody', {
            reason: t(`householdChannel.reason.${channel.disabledReason}`),
          })}
        </Alert>
      )}

      {!readFailed && channel?.status === 'active' && channel.lastFailure && (
        <Alert variant="warning" className="mb-4">
          {t('householdChannel.retrying', {
            reason: t(`householdChannel.failure.${channel.lastFailure.kind}`),
            date: formatDate(channel.nextAttemptAt, { hour: 'numeric', minute: '2-digit' }),
          })}
        </Alert>
      )}

      {!readFailed && channel && (
        <div className="mb-4 rounded-lg border border-primary-100/70 p-4">
          <p className="text-sm font-medium text-gray-900">
            {t('householdChannel.connectedTo', {
              platform: t(`householdChannel.platform.${channel.platform}`),
              masked: channel.maskedUrl,
            })}
          </p>
          {channel.lastDeliveredAt && (
            <p className="mt-1 text-xs text-gray-600">
              {t('householdChannel.lastDelivered', {
                date: formatDate(channel.lastDeliveredAt, { hour: 'numeric', minute: '2-digit' }),
              })}
            </p>
          )}
        </div>
      )}

      {!readFailed && !channel && available && (
        <p className="mb-4 text-sm text-gray-600">{t('householdChannel.notConnected')}</p>
      )}

      {!readFailed && available && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            saveMutation.mutate();
          }}
        >
          <label className="block" htmlFor={field('platform')}>
            <span className="label">{t('householdChannel.platformLabel')}</span>
            <select
              id={field('platform')}
              className="input"
              value={draft.platform}
              onChange={(e) => setDraft({ ...draft, platform: e.target.value as ChannelPlatform })}
            >
              {CHANNEL_PLATFORMS.map((platform) => (
                <option key={platform} value={platform}>
                  {t(`householdChannel.platform.${platform}`)}
                </option>
              ))}
            </select>
          </label>

          <Input
            id={field('url')}
            type="password"
            autoComplete="off"
            spellCheck={false}
            label={t('householdChannel.urlLabel')}
            value={draft.url}
            required={needsUrl}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            helperText={
              needsUrl
                ? t(`householdChannel.urlHelp.${draft.platform}`)
                : t('householdChannel.urlKeepHint')
            }
          />

          <fieldset className="space-y-2">
            <legend className="label">{t('householdChannel.eventsLegend')}</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 accent-primary-700"
                checked={draft.dailyDue}
                onChange={(e) => setDraft({ ...draft, dailyDue: e.target.checked })}
              />
              <span>{t('householdChannel.events.dailyDue')}</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 accent-primary-700"
                checked={draft.upForGrabs}
                onChange={(e) => setDraft({ ...draft, upForGrabs: e.target.checked })}
              />
              <span>{t('householdChannel.events.upForGrabs')}</span>
            </label>
          </fieldset>

          <fieldset>
            <legend className="label">{t('householdChannel.quietLegend')}</legend>
            <div className="flex flex-wrap gap-3">
              <Input
                id={field('quietStart')}
                type="time"
                label={t('householdChannel.quietStart')}
                value={draft.quietStart}
                onChange={(e) => setDraft({ ...draft, quietStart: e.target.value })}
              />
              <Input
                id={field('quietEnd')}
                type="time"
                label={t('householdChannel.quietEnd')}
                value={draft.quietEnd}
                onChange={(e) => setDraft({ ...draft, quietEnd: e.target.value })}
              />
            </div>
            <p className="mt-1 text-xs text-gray-600">
              {t('householdChannel.quietHelp', { zone: channel?.timezone ?? zone })}
            </p>
            {quietHalfSet && (
              <p className="mt-1 text-sm text-red-700" role="alert">
                {t('householdChannel.quietBothEnds')}
              </p>
            )}
          </fieldset>

          <label className="block" htmlFor={field('locale')}>
            <span className="label">{t('householdChannel.localeLabel')}</span>
            <select
              id={field('locale')}
              className="input"
              value={draft.locale}
              onChange={(e) => setDraft({ ...draft, locale: e.target.value as ChannelLocale })}
            >
              <option value="en">{t('householdChannel.locale.en')}</option>
              <option value="es">{t('householdChannel.locale.es')}</option>
            </select>
          </label>

          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              isLoading={saveMutation.isPending}
              disabled={quietHalfSet || (needsUrl && !draft.url.trim())}
              leftIcon={<ChatBubbleLeftRightIcon className="h-4 w-4" aria-hidden="true" />}
            >
              {channel ? t('householdChannel.save') : t('householdChannel.connect')}
            </Button>
            {channel && (
              <Button
                type="button"
                variant="secondary"
                isLoading={testMutation.isPending}
                onClick={() => testMutation.mutate()}
                leftIcon={<PaperAirplaneIcon className="h-4 w-4" aria-hidden="true" />}
              >
                {t('householdChannel.test')}
              </Button>
            )}
            {channel && (
              <Button
                type="button"
                variant="secondary"
                isLoading={removeMutation.isPending}
                onClick={() => removeMutation.mutate()}
                leftIcon={<TrashIcon className="h-4 w-4 text-red-500" aria-hidden="true" />}
              >
                {t('householdChannel.disconnect')}
              </Button>
            )}
          </div>
        </form>
      )}

      {notice === 'saved' && (
        <Alert variant="success" className="mt-4">
          {t('householdChannel.saved')}
        </Alert>
      )}
      {notice === 'disconnected' && (
        <Alert variant="success" className="mt-4">
          {t('householdChannel.disconnected')}
        </Alert>
      )}
      {testResult?.outcome === 'delivered' && (
        <Alert variant="success" className="mt-4">
          {t('householdChannel.testDelivered')}
        </Alert>
      )}
      {testResult?.outcome === 'failed' && (
        <Alert variant="error" className="mt-4">
          {t('householdChannel.testFailed', {
            reason: t(`householdChannel.failure.${testResult.failure.kind}`),
          })}
        </Alert>
      )}
      {saveError && (
        <Alert variant="error" className="mt-4">
          {saveError}
        </Alert>
      )}
      {testMutation.isError && (
        <Alert variant="error" className="mt-4">
          {getErrorMessage(testMutation.error)}
        </Alert>
      )}
      {removeMutation.isError && (
        <Alert variant="error" className="mt-4">
          {getErrorMessage(removeMutation.error)}
        </Alert>
      )}
    </Card>
  );
}
