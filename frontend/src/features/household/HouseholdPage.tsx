import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ClipboardDocumentIcon,
  EnvelopeIcon,
  UserPlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { useAuthStore } from '@/store/authStore';
import { householdService, type InviteEmailStatus } from '@/services/householdService';
import { climateService } from '@/services/climateService';
import { Input } from '@/components/Input';
import { EmptyMembers } from '@/components/illustrations/EmptyMembers';
import { Button } from '@/components/Button';
import { Card, CardHeader } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Alert } from '@/components/Alert';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { getErrorMessage } from '@/services/api';
import clsx from 'clsx';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { MemberVacation } from './MemberVacation';
import { useVacationWindows } from './useVacationWindows';
import { SitterLinksCard } from './SitterLinksCard';
import { CaretakerSeatsCard } from './CaretakerSeatsCard';
import { CareLoadCard } from './CareLoadCard';
import { AutoHandoffCard } from './AutoHandoffCard';

export function HouseholdPage() {
  useDocumentTitle('Household');
  const { t, i18n } = useTranslation();
  const user = useAuthStore((state) => state.user);
  // Operate on the ACTIVE household (multi-household users can switch);
  // user.householdId is only the Cognito-claim default.
  const { householdId, householdQuery } = useActiveHousehold();
  const queryClient = useQueryClient();
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [inviteEmailDraft, setInviteEmailDraft] = useState('');
  // What the server actually did with the last emailed invite. Held so the UI
  // can say "we could not send it, here is the link" rather than implying a
  // delivery that did not happen.
  const [inviteEmailStatus, setInviteEmailStatus] = useState<InviteEmailStatus | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<string | null>(null);

  const {
    data: household,
    isLoading,
    error,
  } = useQuery(
    householdQuery(
      (hh) => ['household', hh],
      (hh) => householdService.getHousehold(hh)
    )
  );

  const createInviteMutation = useMutation({
    mutationFn: () => householdService.createInvite(householdId!),
    onSuccess: (data) => {
      setInviteLink(data.url);
      setCopyError(false);
    },
  });

  const emailInviteMutation = useMutation({
    mutationFn: () =>
      householdService.emailInvite(
        householdId!,
        inviteEmailDraft.trim(),
        i18n.language.startsWith('es') ? 'es' : 'en'
      ),
    onSuccess: (data) => {
      setInviteLink(data.url);
      setInviteEmailStatus(data.status);
      setCopyError(false);
      if (data.status === 'accepted') setInviteEmailDraft('');
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => householdService.removeMember(householdId!, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['household', householdId] });
      setMemberToRemove(null);
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'member' }) =>
      householdService.updateMemberRole(householdId!, userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['household', householdId] });
    },
  });

  const setLocationMutation = useMutation({
    mutationFn: (city: string | null) => climateService.setLocation(householdId!, city),
    onSuccess: () => {
      // ['household', householdId] is a prefix of the climate key, so this
      // refreshes both the household detail and the dashboard ClimateCard.
      queryClient.invalidateQueries({ queryKey: ['household', householdId] });
    },
  });
  const [locationDraft, setLocationDraft] = useState('');

  const handleCopyInvite = async () => {
    if (inviteLink) {
      setCopyError(false);
      try {
        await navigator.clipboard.writeText(inviteLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        setCopyError(true);
      }
    }
  };

  // Role of the ACTIVE household (not the stale Cognito-claim default role),
  // so a multi-household user sees the correct admin controls after a switch.
  const isAdmin = useIsHouseholdAdmin();
  const climateQuery = useQuery({
    queryKey: ['household', householdId, 'climate'],
    queryFn: () => climateService.getClimate(householdId!),
    enabled: isAdmin && Boolean(householdId),
    staleTime: 30 * 60 * 1000,
  });

  // Vacation windows (care handoff) — one query for all member rows.
  const { data: vacationWindows } = useVacationWindows(householdId);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !household) {
    return <Alert variant="error">{error ? getErrorMessage(error) : 'Household not found'}</Alert>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Your household"
        title={household.name}
        description="Manage your household members and settings."
      />

      {/* How the care is actually split. Shown to every member, not just
          admins — the roster is shared, and so is the work. Skipped for a
          household of one, where a split is not a thing that exists yet. */}
      {householdId && household.members.length > 1 && (
        <CareLoadCard
          householdId={householdId}
          members={household.members}
          currentUserId={user?.id ?? null}
        />
      )}

      {/* Invite section */}
      {isAdmin && (
        <Card>
          <CardHeader
            title="Invite members"
            description="Generate an invite link to add family members to your household"
          />

          {/* Friendly nudge when the caller is the only member — the
              household-as-single-user state is the one we most want to
              get them out of, since the collaborative loop is the value. */}
          {household.members.length === 1 && !inviteLink && (
            <div className="mb-4 flex items-center gap-4 rounded-lg border border-primary-100 bg-primary-50 p-4">
              <EmptyMembers className="h-20 w-auto shrink-0" />
              <p className="text-sm text-primary-900">
                You&rsquo;re the only one here. Plant care is more fun (and more reliable) with
                someone else helping — share an invite link with whoever lives with you.
              </p>
            </div>
          )}

          {/* Send it, rather than making the inviter find their own channel.
              The link below still appears either way — the email is the fast
              path, not the only one. */}
          <form
            className="mb-4 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (inviteEmailDraft.trim()) emailInviteMutation.mutate();
            }}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                className="flex-1"
                label={t('household.inviteByEmailLabel')}
                placeholder={t('household.inviteByEmailPlaceholder')}
                helperText={t('household.inviteByEmailHint')}
                value={inviteEmailDraft}
                onChange={(e) => {
                  setInviteEmailDraft(e.target.value);
                  setInviteEmailStatus(null);
                }}
              />
              <Button
                type="submit"
                variant="secondary"
                disabled={!inviteEmailDraft.trim()}
                isLoading={emailInviteMutation.isPending}
                leftIcon={<EnvelopeIcon className="h-4 w-4" aria-hidden="true" />}
              >
                {t('household.inviteByEmailSend')}
              </Button>
            </div>
            {inviteEmailStatus === 'accepted' && (
              <Alert variant="success">{t('household.inviteByEmailSent')}</Alert>
            )}
            {inviteEmailStatus === 'recipient_cooldown' && (
              <Alert variant="info">{t('household.inviteByEmailCooldown')}</Alert>
            )}
            {(inviteEmailStatus === 'unavailable' ||
              inviteEmailStatus === 'identity_unavailable') && (
              <Alert variant="warning">{t('household.inviteByEmailUnavailable')}</Alert>
            )}
            {emailInviteMutation.isError && (
              <Alert variant="error">{getErrorMessage(emailInviteMutation.error)}</Alert>
            )}
          </form>

          {inviteLink ? (
            <div className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="text"
                  readOnly
                  value={inviteLink}
                  className="input flex-1 bg-gray-50"
                  aria-label="Invite link"
                />
                <Button
                  variant="secondary"
                  onClick={handleCopyInvite}
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
              <p className="text-xs text-gray-600">This link will expire in 7 days.</p>
            </div>
          ) : (
            <Button
              onClick={() => createInviteMutation.mutate()}
              isLoading={createInviteMutation.isPending}
              leftIcon={<UserPlusIcon className="h-4 w-4" aria-hidden="true" />}
            >
              Generate invite link
            </Button>
          )}

          {createInviteMutation.isError && (
            <Alert variant="error" className="mt-4">
              {getErrorMessage(createInviteMutation.error)}
            </Alert>
          )}
        </Card>
      )}

      {/* Plant-sitter links — every member, not only admins (ADR 0015): the
          traveller is rarely the admin. A separate component so the
          create/copy/revoke state stays self-contained; it decides per link
          whether this member may revoke it. */}
      {householdId && <SitterLinksCard householdId={householdId} members={household.members} />}

      {/* Return recap — deliberately NOT admin-gated: the sitter looked after
          the whole household's plants, so every member can see what happened
          while they were away. */}
      <Card>
        <CardHeader
          title={t('awayRecap.title')}
          description={t('awayRecap.householdCardDescription')}
        />
        <Link to="/away-recap" className="text-primary-700 underline hover:text-primary-800">
          {t('awayRecap.householdCardLink')}
        </Link>
      </Card>
      {/* Auto-handoff (ADR 0018) — admin-only because it turns on a new class
          of email for everyone. Plan gating is read from the catalog inside. */}
      {isAdmin && householdId && (
        <AutoHandoffCard householdId={householdId} household={household} />
      )}

      {/* Caretaker seats — named, revocable helper identities with a
          proof-of-visit report. Admin-only, like sitter links. Plan gating is
          read from the catalog inside, exactly like AutoHandoffCard. */}
      {isAdmin && householdId && <CaretakerSeatsCard householdId={householdId} />}

      {/* Location — drives climate-aware care tips. Admin-only because the
          location is shared across the household. Non-admins still see what
          it's set to via the dashboard ClimateCard. */}
      {isAdmin && (
        <Card>
          <CardHeader
            title="Location"
            description="Used for climate-aware care tips (humidity warnings, freeze alerts, etc.)."
          />
          {climateQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-600" role="status">
              <LoadingSpinner size="sm" />
              {t('household.climateChecking')}
            </div>
          ) : climateQuery.isError || !climateQuery.data ? (
            <Alert variant="warning">{t('household.climateCheckFailed')}</Alert>
          ) : !climateQuery.data.configured ? (
            <div className="space-y-3">
              <Alert variant="info">{t('household.climateUnavailable')}</Alert>
              {household.location && (
                <>
                  <p className="text-sm">
                    {t('household.climateSavedLocation', {
                      city: household.location.city,
                    })}
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => setLocationMutation.mutate(null)}
                    isLoading={setLocationMutation.isPending}
                  >
                    {t('household.clearSavedLocation')}
                  </Button>
                </>
              )}
            </div>
          ) : household.location ? (
            <div className="space-y-3">
              <p className="text-sm">
                Currently set to{' '}
                <span className="font-medium text-gray-900">{household.location.city}</span>.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setLocationMutation.mutate(null)}
                  isLoading={setLocationMutation.isPending}
                >
                  Clear location
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (locationDraft.trim().length === 0) return;
                setLocationMutation.mutate(locationDraft.trim());
              }}
            >
              <Input
                label="City"
                placeholder="e.g. Austin, US"
                value={locationDraft}
                onChange={(e) => setLocationDraft(e.target.value)}
                helperText="Add a country if your city name is ambiguous."
              />
              <Button
                type="submit"
                isLoading={setLocationMutation.isPending}
                disabled={locationDraft.trim().length === 0}
              >
                Save location
              </Button>
            </form>
          )}
          {setLocationMutation.isError && (
            <Alert variant="error" className="mt-3">
              {getErrorMessage(setLocationMutation.error)}
            </Alert>
          )}
        </Card>
      )}

      {/* Members list */}
      <Card padding="none">
        <div className="px-6 py-4 border-b border-primary-100/70">
          <h2 className="font-serif text-lg text-ink">
            Members
            <span className="ml-2 text-sm font-normal text-gray-600">
              ({household.members.length})
            </span>
          </h2>
        </div>

        <ul className="divide-y divide-primary-100/60">
          {household.members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between gap-4 px-6 py-4">
              <div className="flex items-center gap-4">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-100 text-primary-700 font-medium"
                  aria-hidden="true"
                >
                  {member.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {member.name}
                    {member.userId === user?.id && (
                      <span className="ml-2 text-gray-500">(you)</span>
                    )}
                  </p>
                  {householdId && (
                    <MemberVacation
                      householdId={householdId}
                      member={member}
                      members={household.members}
                      canManage={isAdmin || member.userId === user?.id}
                      window={vacationWindows?.find((w) => w.userId === member.userId)}
                    />
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <span
                  className={clsx(
                    'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                    member.role === 'admin'
                      ? 'bg-primary-100 text-primary-900'
                      : 'bg-parchment text-gray-700 ring-1 ring-primary-200/50'
                  )}
                >
                  {member.role === 'admin' ? 'Admin' : 'Member'}
                </span>

                {/* A member whose address bounced silently stops receiving
                    every reminder and digest. Without this the household has
                    no way to find out — the failure looks exactly like health.
                    Says nothing about the address itself, or about which of a
                    bounce and a complaint stopped the mail. */}
                {member.emailStatus === 'undeliverable' && (
                  <span
                    className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-amber-300/60"
                    title={t('household.memberEmailUndeliverableHint')}
                  >
                    {t('household.memberEmailUndeliverable')}
                  </span>
                )}

                {isAdmin && member.userId !== user?.id && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        updateRoleMutation.mutate({
                          userId: member.userId,
                          role: member.role === 'admin' ? 'member' : 'admin',
                        })
                      }
                      disabled={updateRoleMutation.isPending}
                      aria-label={
                        member.role === 'admin'
                          ? `Demote ${member.name} to member`
                          : `Promote ${member.name} to admin`
                      }
                    >
                      {member.role === 'admin' ? 'Make member' : 'Make admin'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setMemberToRemove(member.userId)}
                      aria-label={`Remove ${member.name}`}
                    >
                      <TrashIcon className="h-4 w-4 text-red-500" aria-hidden="true" />
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* Remove member confirmation */}
      <ConfirmDialog
        isOpen={!!memberToRemove}
        onClose={() => setMemberToRemove(null)}
        onConfirm={() => memberToRemove && removeMemberMutation.mutate(memberToRemove)}
        title="Remove member"
        message="Are you sure you want to remove this member from the household? They will lose access to all shared plants and tasks. Anything they set up for other people also stops working: their plant-tag labels (you will need to print new ones), their sitter links, their wall display, and any API key they issued."
        confirmLabel="Remove"
        isLoading={removeMemberMutation.isPending}
      />
    </div>
  );
}
