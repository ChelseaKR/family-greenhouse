import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { authService } from '@/services/authService';
import { plantService } from '@/services/plantService';
import { taskService } from '@/services/taskService';
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
  const user = useAuthStore((s) => s.user);
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
      const [plants, tasks] = await Promise.all([plantService.getPlants(), taskService.getTasks()]);
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
  const canSubmit = !!oldPassword && newPassword.length >= 8 && newPassword === confirmPassword;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Profile"
          description="Update how your name shows up in your household. Email changes aren't supported yet."
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
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            helperText="Minimum 8 characters."
          />
          <Input
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
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
          <Button
            variant="secondary"
            isLoading={exportData.isPending}
            onClick={() => exportData.mutate()}
          >
            Download CSV
          </Button>
        </div>
        <p className="mt-3 text-xs text-gray-600">
          Moving in the other direction?{' '}
          <RouterLink to="/plants/import" className="font-medium text-primary-700 underline">
            Import plants from a CSV or JSON file
          </RouterLink>{' '}
          — including exports from this app.
        </p>
      </Card>

      <Card>
        <CardHeader
          title="Calendar feed"
          description="Subscribe to your plant care tasks in Apple Calendar, Google Calendar, or any iCalendar-aware app. The feed updates as your tasks change — no manual re-export."
        />
        <CalendarFeedRow />
      </Card>

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
        message="Your login is removed and you lose access to this household. Past completion records keep your name on them as historical artifacts. This cannot be undone."
        confirmLabel="Yes, delete"
        variant="danger"
        isLoading={deleteMe.isPending}
      />
    </div>
  );
}

/**
 * Display the calendar feed URL with a copy-to-clipboard affordance.
 * Pulled into its own component so the URL construction (which depends
 * on the API base) and the copy-state are local — keeps AccountSettings
 * focused on the broader account surface.
 */
function CalendarFeedRow() {
  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000';
  const url = `${apiBase}/me/calendar.ics`;
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={url}
          className="input flex-1 bg-gray-50 font-mono text-xs"
          aria-label="Calendar feed URL"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button variant="secondary" onClick={copy}>
          {copied ? 'Copied!' : 'Copy'}
        </Button>
      </div>
      <p className="text-xs text-gray-600">
        Paste this URL into your calendar app&rsquo;s &ldquo;subscribe to calendar&rdquo; option.
        The feed shows tasks for your active household; switching households updates what you see
        automatically.
      </p>
    </div>
  );
}
