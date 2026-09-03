import { useRef, useState, type Ref } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { UserPlusIcon } from '@heroicons/react/24/outline';
import { householdService } from '@/services/householdService';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { EmptyMembers } from '@/components/illustrations/EmptyMembers';
import { formatDate } from '@/utils/date';

interface InviteStepProps {
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  householdId: string;
  /** "It's just me for now" — no invite, no guilt, straight to the app. */
  onSkip: () => void;
  onFinish: () => void;
}

/**
 * Step two: the thing that makes this app different from a plant tracker.
 *
 * Every competitor is a single-user log. The whole premise here is that one
 * set of plants belongs to several people, and if a new user never meets that
 * idea in their first minute they experience a generic tracker and the
 * positioning is gone at exactly the moment it mattered. So the invite is
 * offered in the first run — as a real link, minted from the real endpoint,
 * not a tour slide describing a feature.
 *
 * It is also entirely optional, and says so. Plenty of households are one
 * person, the free tier is perfectly usable solo, and nagging a solo user to
 * recruit somebody is a worse first minute than no prompt at all.
 *
 * Admin-only by construction: the parent only renders this step for admins,
 * because POST /households/:id/invites is behind `requireAdmin`.
 */
export function InviteStep({
  headingId,
  headingRef,
  householdId,
  onSkip,
  onFinish,
}: InviteStepProps) {
  const { t } = useTranslation();
  const linkRef = useRef<HTMLInputElement>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // `createInvite` emits the `invite_sent` analytics event itself, so the
  // first-run invite is counted in the same funnel as one made from the
  // Household page.
  const inviteMutation = useMutation({
    mutationFn: () => householdService.createInvite(householdId),
    onSuccess: () => setCopyState('idle'),
  });

  const invite = inviteMutation.data;

  const copyLink = async () => {
    if (!invite) return;
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(invite.url);
      setCopyState('copied');
    } catch {
      // Clipboard access is denied in plenty of ordinary situations (Safari
      // without a user gesture chain, locked-down enterprise profiles). Select
      // the text so a manual copy is one keystroke rather than a dead end.
      setCopyState('failed');
      linkRef.current?.focus();
      linkRef.current?.select();
    }
  };

  return (
    <div>
      <div className="text-center">
        <EmptyMembers className="mx-auto h-28 w-auto" />
        <h1
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="mt-4 font-serif text-3xl tracking-tight text-ink focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        >
          {t('firstRun.invite.title')}
        </h1>
        <p className="mt-3 text-base leading-relaxed text-gray-700">
          {t('firstRun.invite.description')}
        </p>
        <p className="mt-2 text-sm text-gray-600">{t('firstRun.invite.free')}</p>
      </div>

      {inviteMutation.isError && (
        <Alert variant="error" className="mt-6">
          {getErrorMessage(inviteMutation.error)}
        </Alert>
      )}

      <div className="mt-6">
        {invite ? (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                ref={linkRef}
                type="text"
                readOnly
                value={invite.url}
                className="input flex-1 bg-gray-50"
                aria-label={t('firstRun.invite.linkLabel')}
              />
              <Button variant="secondary" onClick={copyLink}>
                {t('firstRun.invite.copy')}
              </Button>
            </div>
            <p className="text-sm text-gray-600" aria-live="polite">
              {copyState === 'copied' && t('firstRun.invite.copied')}
              {copyState === 'failed' && t('firstRun.invite.copyFailed')}
            </p>
            <p className="text-xs text-gray-600">
              {t('firstRun.invite.expires', { date: formatDate(invite.expiresAt) })}
            </p>
          </div>
        ) : (
          <Button
            size="lg"
            className="w-full sm:w-auto"
            onClick={() => inviteMutation.mutate()}
            isLoading={inviteMutation.isPending}
            leftIcon={<UserPlusIcon className="h-5 w-5" aria-hidden="true" />}
          >
            {t('firstRun.invite.create')}
          </Button>
        )}
      </div>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row-reverse sm:items-center sm:justify-start">
        <Button size="lg" onClick={onFinish} className="sm:min-w-44">
          {t('firstRun.invite.finish')}
        </Button>
        {!invite && (
          <Button variant="secondary" onClick={onSkip}>
            {t('firstRun.invite.solo')}
          </Button>
        )}
      </div>
    </div>
  );
}
