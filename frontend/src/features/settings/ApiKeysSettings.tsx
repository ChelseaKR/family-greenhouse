import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TrashIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  apiKeyService,
  API_SCOPES,
  READ_API_SCOPES,
  WRITE_API_SCOPES,
  SCOPE_LABELS,
  type ApiScope,
} from '@/services/apiKeyService';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { getErrorMessage } from '@/services/api';

/**
 * Manage household API keys. Greenhouse plan only — the create call returns
 * 402 with a clear message for other plans, which we surface as the "upgrade
 * to use the API" state.
 *
 * The plaintext key is shown ONCE in a flash banner after creation. We never
 * store it in component state beyond the current render, and once the user
 * dismisses the banner they have to revoke and re-issue if they lost it.
 */
export function ApiKeysSettings() {
  const { t } = useTranslation();
  // Active household's role, not the stale Cognito-claim default role.
  const isAdmin = useIsHouseholdAdmin();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  // Default to the full READ surface — the common case is "give me a key that
  // works"; narrowing is opt-in and write access is always an explicit grant.
  const [scopes, setScopes] = useState<ApiScope[]>([...READ_API_SCOPES]);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [createdPlaintext, setCreatedPlaintext] = useState<string | null>(null);
  const [copyOk, setCopyOk] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const toggleScope = (scope: ApiScope) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  const keysQuery = useQuery({
    // API keys are household-scoped — the active household lives in the key
    // so switching households can never show another household's keys.
    queryKey: ['api-keys', householdId],
    queryFn: apiKeyService.list,
    enabled: !!householdId,
    // Keys are stable; refetch only when we mutate.
    staleTime: 60_000,
  });

  const createMutation = useMutation({
    mutationFn: (vars: { label: string; scopes: ApiScope[] }) =>
      apiKeyService.create(vars.label, vars.scopes),
    onSuccess: (result) => {
      setCreatedPlaintext(result.plaintext);
      setLabel('');
      setScopes([...READ_API_SCOPES]);
      queryClient.invalidateQueries({ queryKey: ['api-keys', householdId] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiKeyService.revoke(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', householdId] });
      setRevokeId(null);
    },
    // Without this a failed revoke (500/network) left the dialog open with only
    // a cleared spinner and no message — the key stayed listed and the user
    // assumed it worked. Close the dialog and surface the error below.
    onError: () => setRevokeId(null),
  });

  const handleCopy = async () => {
    if (!createdPlaintext) return;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(createdPlaintext);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 2000);
    } catch {
      setCopyError(true);
    }
  };

  if (keysQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="API keys"
          description="Issue keys for access to your household data — Home Assistant, scripts, etc. Keys are read-only unless you explicitly grant write access. Greenhouse plan only."
        />

        {createdPlaintext && (
          <Alert variant="success" className="mb-4">
            <p className="font-medium">New key created — copy it now, it won't be shown again.</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 rounded bg-white px-2 py-1 text-xs font-mono break-all">
                {createdPlaintext}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopy}
                leftIcon={<ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />}
              >
                {copyOk ? 'Copied!' : 'Copy'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setCreatedPlaintext(null);
                  setCopyError(false);
                }}
              >
                Dismiss
              </Button>
            </div>
            {copyError && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                Could not copy automatically. Select the key and copy it manually.
              </p>
            )}
          </Alert>
        )}

        {createMutation.isError && (
          <Alert variant="error" className="mb-4">
            {getErrorMessage(createMutation.error)}
          </Alert>
        )}

        {isAdmin && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Input
                  label="Key label"
                  placeholder="Home Assistant, personal script…"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  helperText="Shown in the list to identify the key — can't be changed later."
                />
              </div>
              <Button
                onClick={() => createMutation.mutate({ label: label.trim(), scopes })}
                isLoading={createMutation.isPending}
                disabled={!label.trim() || scopes.length === 0}
              >
                Issue key
              </Button>
            </div>
            <fieldset>
              <legend className="label">Scopes</legend>
              <p className="mb-2 text-xs text-gray-600">
                Grant only what the key needs. A request to an endpoint outside the key&rsquo;s
                scopes is refused with a 403.
              </p>
              <div className="flex flex-wrap gap-4">
                {API_SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      className="rounded border-gray-300 accent-primary-700 text-primary-600 focus:ring-primary-500"
                      checked={scopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                    />
                    {SCOPE_LABELS[scope]}
                  </label>
                ))}
              </div>
              {scopes.some((s) => WRITE_API_SCOPES.includes(s)) && (
                <Alert variant="warning" className="mt-3">
                  {t('settings.apiKeys.writeScopeWarning')}
                </Alert>
              )}
              {scopes.length === 0 && (
                <p className="mt-1 text-xs text-red-600">Select at least one scope.</p>
              )}
            </fieldset>
          </div>
        )}
      </Card>

      <Card padding="none">
        <div className="px-6 py-4 border-b border-gray-200">
          <CardHeader
            title={`Active keys (${keysQuery.data?.length ?? 0})`}
            description="Revoking is immediate — clients using the key will start getting 401 on the next request."
          />
        </div>
        {revokeMutation.isError && (
          <Alert variant="error" className="mx-6 mt-4">
            {getErrorMessage(revokeMutation.error)}
          </Alert>
        )}
        {!keysQuery.data || keysQuery.data.length === 0 ? (
          <p className="p-6 text-sm text-gray-600">No keys yet.</p>
        ) : (
          <ul className="divide-y divide-gray-200">
            {keysQuery.data.map((key) => (
              <li
                key={key.id}
                className="flex flex-col items-stretch gap-3 px-6 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 truncate">{key.label}</p>
                  <p className="text-xs text-gray-600">
                    fg_… <span className="font-mono">{key.last4}</span> · Issued{' '}
                    {new Date(key.createdAt).toLocaleDateString()}
                    {key.lastUsedAt &&
                      ` · Last used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(key.scopes ?? []).map((scope) => (
                      <span
                        key={scope}
                        className="inline-flex rounded bg-primary-50 px-1.5 py-0.5 text-[11px] font-medium text-primary-800"
                      >
                        {SCOPE_LABELS[scope] ?? scope}
                      </span>
                    ))}
                  </div>
                </div>
                {isAdmin && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setRevokeId(key.id)}
                    leftIcon={<TrashIcon className="h-4 w-4 text-red-500" aria-hidden="true" />}
                    aria-label={`Revoke key ${key.label}`}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        isOpen={!!revokeId}
        onClose={() => setRevokeId(null)}
        onConfirm={() => revokeId && revokeMutation.mutate(revokeId)}
        title="Revoke API key?"
        message="The key will stop working immediately. Anything currently using it will get 401 on the next request."
        confirmLabel="Revoke"
        variant="danger"
        isLoading={revokeMutation.isPending}
      />
    </div>
  );
}
