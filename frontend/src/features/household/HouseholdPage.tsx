import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardDocumentIcon, UserPlusIcon, TrashIcon } from '@heroicons/react/24/outline';
import { useAuthStore } from '@/store/authStore';
import { householdService } from '@/services/householdService';
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
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { MemberVacation } from './MemberVacation';
import { useVacationWindows } from './useVacationWindows';

export function HouseholdPage() {
  useDocumentTitle('Household');
  const user = useAuthStore((state) => state.user);
  // Operate on the ACTIVE household (multi-household users can switch);
  // user.householdId is only the Cognito-claim default.
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<string | null>(null);

  const {
    data: household,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['household', householdId],
    queryFn: () => householdService.getHousehold(householdId!),
    enabled: !!householdId,
  });

  const createInviteMutation = useMutation({
    mutationFn: () => householdService.createInvite(householdId!),
    onSuccess: (data) => {
      setInviteLink(data.url);
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
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const isAdmin = user?.householdRole === 'admin';

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
              <EmptyMembers className="h-20 w-auto flex-shrink-0" />
              <p className="text-sm text-primary-900">
                You&rsquo;re the only one here. Plant care is more fun (and more reliable) with
                someone else helping — share an invite link with whoever lives with you.
              </p>
            </div>
          )}

          {inviteLink ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
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
              <p className="text-xs text-gray-500">This link will expire in 7 days.</p>
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

      {/* Location — drives climate-aware care tips. Admin-only because the
          location is shared across the household. Non-admins still see what
          it's set to via the dashboard ClimateCard. */}
      {isAdmin && (
        <Card>
          <CardHeader
            title="Location"
            description="Used for climate-aware care tips (humidity warnings, freeze alerts, etc.)."
          />
          {household.location ? (
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
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            Members
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({household.members.length})
            </span>
          </h2>
        </div>

        <ul className="divide-y divide-gray-200">
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
                  <p className="text-sm text-gray-500">{member.email}</p>
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

              <div className="flex items-center gap-3">
                <span
                  className={clsx(
                    'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                    member.role === 'admin'
                      ? 'bg-primary-100 text-primary-900'
                      : 'bg-gray-100 text-gray-900'
                  )}
                >
                  {member.role === 'admin' ? 'Admin' : 'Member'}
                </span>

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
        message="Are you sure you want to remove this member from the household? They will lose access to all shared plants and tasks."
        confirmLabel="Remove"
        isLoading={removeMemberMutation.isPending}
      />
    </div>
  );
}
