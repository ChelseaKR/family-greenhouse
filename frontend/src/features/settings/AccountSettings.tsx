import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link as RouterLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowPathIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { authService } from '@/services/authService';
import { plantService } from '@/services/plantService';
import { taskService } from '@/services/taskService';
import {
  calendarFeedService,
  type CalendarTokenCreateResult,
} from '@/services/calendarFeedService';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useAuthStore } from '@/store/authStore';
import { getErrorMessage } from '@/services/api';
import { downloadCsv, toCsv } from '@/utils/csv';
import { track } from '@/services/analytics';

/**
 * Account-level settings: change password, view profile, delete account.
 * Leaving a household isn't here yet — it's bundled into account deletion
 * because that's the support-burdened operation we want behind a friction
 * wall. A future "leave household but keep account" deserves its own
 * confirm flow.
 */
export function AccountSettings() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const hasHousehold = user?.householdId != null;
  const activeHouseholdId = useActiveHouseholdId();
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);
  const [nameDraft, setNameDraft] = useState(user?.name ?? '');
  const [nameSuccess, setNameSuccess] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSuccess, setPwSuccess] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const updateProfile = useMutation({
    mutationFn: () => authService.updateProfile({ name: nameDraft.trim() }),
    onSuccess: (updated) => {
      if (user) {
        setUser({ ...user, name: updated.name });
      }
      setNameSuccess(true);
    },
  });

  const changePassword = useMutation({
    mutationFn: () => authService.changePassword({ oldPassword, newPassword }),
    onSuccess: () => {
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPwSuccess(true);
    },
  });

  const deleteMe = useMutation({
    mutationFn: () => authService.deleteMe(),
    onSuccess: () => {
      logout();
      navigate('/');
    },
  });

  const exportData = useMutation({
    mutationFn: async () => {
      track('data_exported', { context: 'csv' });
      // 'all' — the CSV export promises every plant; getPlants defaults to
      // 'active' only, which would silently drop died/gave-away plants.
      const [plants, tasks] = await Promise.all([
        plantService.getPlants('all'),
        taskService.getTasks(),
      ]);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadCsv(
        `family-greenhouse-plants-${stamp}.csv`,
        toCsv(
          ['id', 'name', 'species', 'location', 'notes', 'tags', 'createdAt', 'updatedAt'],
          plants.map((p) => [
            p.id,
            p.name,
            p.species ?? '',
            p.location ?? '',
            p.notes ?? '',
            (p.tags ?? []).join('|'),
            p.createdAt,
            p.updatedAt,
          ])
        )
      );
      downloadCsv(
        `family-greenhouse-tasks-${stamp}.csv`,
        toCsv(
          [
            'id',
            'plantName',
            'type',
            'frequencyDays',
            'nextDue',
            'lastCompleted',
            'assignedTo',
            'notes',
          ],
          tasks.map((t) => [
            t.id,
            t.plantName,
            t.customType ?? t.type,
            t.frequency,
            t.nextDue,
            t.lastCompleted ?? '',
            t.assignedToName ?? '',
            t.notes ?? '',
          ])
        )
      );
    },
  });

  const exportJson = useMutation({
    mutationFn: async () => {
      track('data_exported', { context: 'json' });
      const blob = await authService.exportMyData();
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `family-greenhouse-export-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  });

  const passwordMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const passwordMeetsPolicy =
    newPassword.length >= 12 &&
    /[A-Z]/.test(newPassword) &&
    /[a-z]/.test(newPassword) &&
    /[0-9]/.test(newPassword);
  const canSubmit = !!oldPassword && passwordMeetsPolicy && newPassword === confirmPassword;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Profile"
          description={
            hasHousehold
              ? "Update how your name shows up in your household. Email changes aren't supported yet."
              : "Update the name on your account. Email changes aren't supported yet."
          }
        />
        {updateProfile.isError && (
          <Alert variant="error" className="mb-4">
            {getErrorMessage(updateProfile.error)}
          </Alert>
        )}
        {nameSuccess && (
          <Alert variant="success" className="mb-4">
            Name updated.
          </Alert>
        )}
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = nameDraft.trim();
            if (trimmed.length === 0 || trimmed === user?.name) return;
            setNameSuccess(false);
            updateProfile.mutate();
          }}
        >
          <Input
            label="Name"
            type="text"
            required
            maxLength={80}
            value={nameDraft}
            onChange={(e) => {
              setNameDraft(e.target.value);
              setNameSuccess(false);
            }}
          />
          <div>
            <p className="label">Email</p>
            <p className="text-sm text-gray-900">{user?.email ?? '—'}</p>
          </div>
          <div className="flex justify-end">
            <Button
              type="submit"
              isLoading={updateProfile.isPending}
              disabled={nameDraft.trim().length === 0 || nameDraft.trim() === user?.name}
            >
              Save name
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="Change password"
          description="You'll need your current password — we don't keep it on the server."
        />
        {changePassword.isError && (
          <Alert variant="error" className="mb-4">
            {getErrorMessage(changePassword.error)}
          </Alert>
        )}
        {pwSuccess && (
          <Alert variant="success" className="mb-4">
            Password updated.
          </Alert>
        )}
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) changePassword.mutate();
          }}
        >
          <Input
            label="Current password"
            type="password"
            autoComplete="current-password"
            required
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
          />
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            helperText="At least 12 characters with uppercase, lowercase, and number."
          />
          <Input
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={passwordMismatch ? 'Passwords do not match.' : undefined}
          />
          <div className="flex justify-end">
            <Button type="submit" isLoading={changePassword.isPending} disabled={!canSubmit}>
              Update password
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="Download my data"
          description="Export your data anytime. The full export is a single JSON document covering your profile, notification preferences, household memberships, and the plants and tasks of every household you belong to. The CSV option is a spreadsheet-friendly subset (plants and tasks for your active household)."
        />
        {(exportJson.isError || exportData.isError) && (
          <Alert variant="error" className="mb-4">
            {getErrorMessage(exportJson.error ?? exportData.error)}
          </Alert>
        )}
        <div className="flex flex-wrap gap-3">
          <Button isLoading={exportJson.isPending} onClick={() => exportJson.mutate()}>
            Download full data (JSON)
          </Button>
          {hasHousehold && (
            <Button
              variant="secondary"
              isLoading={exportData.isPending}
              onClick={() => exportData.mutate()}
            >
              Download CSV
            </Button>
          )}
        </div>
        {hasHousehold && (
          <p className="mt-3 text-xs text-gray-600">
            Moving in the other direction?{' '}
            <RouterLink to="/plants/import" className="font-medium text-primary-700 underline">
              Import plants from a CSV or JSON file
            </RouterLink>{' '}
            — including exports from this app.
          </p>
        )}
      </Card>

      {hasHousehold && (
        <Card>
          <CardHeader
            title={t('settings.calendarFeed.title')}
            description={t('settings.calendarFeed.description')}
          />
          {/* Keyed on the household so a switch drops any just-issued URL
              (which belongs to the previous household) from view. */}
          <CalendarFeedRow key={activeHouseholdId ?? 'none'} />
        </Card>
      )}

      <Card>
        <CardHeader
          title="Delete account"
          description="Permanently removes your login and your household membership. If you're the only admin in a multi-member household, promote someone else first."
        />
        {deleteMe.isError && (
          <Alert variant="error" className="mb-4">
            {getErrorMessage(deleteMe.error)}
          </Alert>
        )}
        <Button variant="danger" onClick={() => setDeleteConfirm(true)}>
          Delete my account
        </Button>
      </Card>

      <ConfirmDialog
        isOpen={deleteConfirm}
        onClose={() => setDeleteConfirm(false)}
        onConfirm={() => deleteMe.mutate()}
        title="Delete account?"
        message="Your login and notification tokens are removed, and you lose access to every household. Shared care history is retained without your name. This cannot be undone."
        confirmLabel="Yes, delete"
        variant="danger"
        isLoading={deleteMe.isPending}
      />
    </div>
  );
}

/**
 * The calendar-feed link for the ACTIVE household.
 *
 * Why this isn't just a URL in a box any more: the old row displayed
 * `${API}/me/calendar.ics`, a route behind the Cognito JWT authorizer.
 * Calendar apps fetch subscription URLs with no session, so every subscriber
 * got 401. The working pattern is a capability URL — a per-user, per-household
 * secret in the path — which is why this row now mints, shows once, and can
 * regenerate or revoke a link, and why it carries a plain warning: anyone
 * holding the link can read this household's task titles and due dates.
 *
 * The token is stored hashed server-side, so it can only ever be shown at the
 * moment of minting (same one-time-reveal contract as API keys). After a
 * reload the row says a link exists and offers regenerate/revoke.
 */
function CalendarFeedRow() {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<CalendarTokenCreateResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [confirm, setConfirm] = useState<'regenerate' | 'revoke' | null>(null);
  const [revokedNotice, setRevokedNotice] = useState(false);

  const statusQuery = useQuery({
    // Household-scoped: the active household lives in the key (see
    // useActiveHouseholdId) so a switch can never show another household's
    // link status.
    queryKey: ['calendar-token', householdId],
    queryFn: calendarFeedService.status,
    enabled: !!householdId,
    staleTime: 60_000,
  });
  // ADR 0010: a failed read is not "no link". An active link keeps granting
  // read access whether or not we could confirm it exists, so the failure
  // has to be rendered as itself — with the revoke control still reachable
  // through regenerate — not as the fresh "generate a link" zero-state.
  const statusUnavailable = !statusQuery.isLoading && statusQuery.data === undefined;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['calendar-token', householdId] });

  const generate = useMutation({
    mutationFn: calendarFeedService.regenerate,
    onSuccess: (result) => {
      setIssued(result);
      setRevokedNotice(false);
      setCopied(false);
      setCopyError(false);
      setConfirm(null);
      invalidate();
    },
    // Close the dialog on failure too — otherwise a failed regenerate leaves
    // it open with a cleared spinner and no message (same trap #349 fixed
    // for API keys). The error renders below.
    onError: () => setConfirm(null),
  });

  const revoke = useMutation({
    mutationFn: calendarFeedService.revoke,
    onSuccess: () => {
      setIssued(null);
      setRevokedNotice(true);
      setConfirm(null);
      invalidate();
    },
    onError: () => setConfirm(null),
  });

  const url = issued ? calendarFeedService.feedUrl(issued.path) : null;
  const active = url !== null || statusQuery.data?.active === true;
  const createdAt = issued?.createdAt ?? statusQuery.data?.createdAt ?? null;
  const lastUsedAt = issued ? null : (statusQuery.data?.lastUsedAt ?? null);

  async function copy() {
    if (!url) return;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
    }
  }

  if (statusQuery.isLoading) {
    return (
      <div className="flex justify-center py-4">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {(generate.isError || revoke.isError) && (
        <Alert variant="error">{getErrorMessage(generate.error ?? revoke.error)}</Alert>
      )}

      {statusUnavailable ? (
        <Alert variant="error">
          {t('settings.calendarFeed.loadFailed')} {getErrorMessage(statusQuery.error)}
        </Alert>
      ) : url ? (
        <>
          <Alert variant="warning">
            <p className="font-medium">{t('settings.calendarFeed.copyNow')}</p>
            <p className="mt-1">{t('settings.calendarFeed.linkWarning')}</p>
          </Alert>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="text"
              readOnly
              value={url}
              className="input flex-1 bg-gray-50 font-mono text-xs"
              aria-label={t('settings.calendarFeed.urlLabel')}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button variant="secondary" onClick={copy}>
              {copied ? t('settings.calendarFeed.copied') : t('settings.calendarFeed.copy')}
            </Button>
          </div>
          {copyError && (
            <p className="text-sm text-red-700" role="alert">
              {t('settings.calendarFeed.copyFailed')}
            </p>
          )}
          <p className="text-xs text-gray-600">{t('settings.calendarFeed.subscribeHint')}</p>
        </>
      ) : active ? (
        <>
          <p className="text-sm text-gray-900">
            {t('settings.calendarFeed.activeSince', {
              date: createdAt ? new Date(createdAt).toLocaleDateString() : '—',
            })}{' '}
            {lastUsedAt
              ? t('settings.calendarFeed.lastFetched', {
                  date: new Date(lastUsedAt).toLocaleDateString(),
                })
              : t('settings.calendarFeed.neverFetched')}
          </p>
          <p className="text-xs text-gray-600">{t('settings.calendarFeed.notShownAgain')}</p>
          <p className="text-xs text-gray-600">{t('settings.calendarFeed.linkWarning')}</p>
        </>
      ) : (
        <>
          {revokedNotice && <Alert variant="success">{t('settings.calendarFeed.revoked')}</Alert>}
          <p className="text-sm text-gray-900">{t('settings.calendarFeed.generateHint')}</p>
          <p className="text-xs text-gray-600">{t('settings.calendarFeed.linkWarning')}</p>
          <Button isLoading={generate.isPending} onClick={() => generate.mutate()}>
            {t('settings.calendarFeed.generate')}
          </Button>
        </>
      )}

      {!statusUnavailable && active && (
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setConfirm('regenerate')}
            leftIcon={<ArrowPathIcon className="h-4 w-4" aria-hidden="true" />}
          >
            {t('settings.calendarFeed.regenerate')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setConfirm('revoke')}
            leftIcon={<TrashIcon className="h-4 w-4 text-red-500" aria-hidden="true" />}
          >
            {t('settings.calendarFeed.revoke')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirm === 'regenerate'}
        onClose={() => setConfirm(null)}
        onConfirm={() => generate.mutate()}
        title={t('settings.calendarFeed.regenerateTitle')}
        message={t('settings.calendarFeed.regenerateMessage')}
        confirmLabel={t('settings.calendarFeed.regenerateConfirm')}
        variant="primary"
        isLoading={generate.isPending}
      />
      <ConfirmDialog
        isOpen={confirm === 'revoke'}
        onClose={() => setConfirm(null)}
        onConfirm={() => revoke.mutate()}
        title={t('settings.calendarFeed.revokeTitle')}
        message={t('settings.calendarFeed.revokeMessage')}
        confirmLabel={t('settings.calendarFeed.revokeConfirm')}
        variant="danger"
        isLoading={revoke.isPending}
      />
    </div>
  );
}
