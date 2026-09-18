import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { KeyIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { getErrorMessage } from '@/services/api';
import { securityService, type PasskeySummary } from '@/services/securityService';
import { createPasskey, isCeremonyCancelled } from '@/lib/webauthn';
import { normalizeCode, readMfaErrorCode } from '@/features/auth/signInFlow';

const LIST_KEY = ['passkeys'] as const;

function passkeyErrorMessage(error: unknown, t: TFunction): string {
  if (isCeremonyCancelled(error)) return t('security.passkeys.cancelled');
  switch (readMfaErrorCode(error)) {
    case 'REAUTH_FAILED':
      return t('security.totp.wrongPassword');
    case 'INVALID_CODE':
      return t('security.totp.wrongCode');
    case 'CODE_REQUIRED':
      return t('security.passkeys.codeRequired');
    case 'PASSKEY_EXPIRED':
      return t('security.passkeys.expired');
    case 'PASSKEY_REJECTED':
      return t('security.passkeys.rejected');
    default:
      return getErrorMessage(error);
  }
}

/**
 * Settings → Security → Passkeys (#671). Rendered only where a passkey can
 * actually be made: the deployment has passkeys on AND this is a browser with
 * WebAuthn on the site's own origin (never inside the native shells — see
 * lib/webauthn.ts). Elsewhere the card is absent, not broken.
 *
 * ADR 0010: the list is a read, and a failed read says so. It is never shown
 * as "no passkeys", which would hide a way into the account from its owner.
 */
export function PasskeySettings({ totpEnabled }: { totpEnabled: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<'added' | 'removed' | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const listQuery = useQuery({
    queryKey: LIST_KEY,
    queryFn: securityService.listPasskeys,
    staleTime: 60_000,
  });
  const listUnavailable = !listQuery.isLoading && listQuery.data === undefined;

  const remove = useMutation({
    mutationFn: (id: string) => securityService.deletePasskey(id),
    onSuccess: () => {
      setRemoveId(null);
      setNotice('removed');
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      addButtonRef.current?.focus();
    },
    onError: () => setRemoveId(null),
  });

  const removing = listQuery.data?.find((p) => p.id === removeId);

  return (
    <Card>
      <CardHeader
        title={t('security.passkeys.title')}
        description={t('security.passkeys.description')}
      />
      <div className="space-y-4">
        {notice === 'added' && <Alert variant="success">{t('security.passkeys.added')}</Alert>}
        {notice === 'removed' && <Alert variant="success">{t('security.passkeys.removed')}</Alert>}
        {remove.isError && <Alert variant="error">{passkeyErrorMessage(remove.error, t)}</Alert>}

        {listQuery.isLoading ? (
          <div className="flex justify-center py-4">
            <LoadingSpinner size="md" />
          </div>
        ) : listUnavailable ? (
          <Alert variant="error">
            {t('security.passkeys.loadFailed')} {getErrorMessage(listQuery.error)}
          </Alert>
        ) : listQuery.data && listQuery.data.length > 0 ? (
          <ul
            className="divide-y divide-gray-200 rounded-md border border-gray-200"
            aria-label={t('security.passkeys.listLabel')}
          >
            {listQuery.data.map((passkey) => (
              <PasskeyRow
                key={passkey.id}
                passkey={passkey}
                onRemove={() => setRemoveId(passkey.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-700">{t('security.passkeys.none')}</p>
        )}

        {adding ? (
          <AddPasskey
            totpEnabled={totpEnabled}
            onDone={() => {
              setAdding(false);
              setNotice('added');
              void queryClient.invalidateQueries({ queryKey: LIST_KEY });
            }}
            onCancel={() => {
              setAdding(false);
              requestAnimationFrame(() => addButtonRef.current?.focus());
            }}
          />
        ) : (
          <Button
            ref={addButtonRef}
            variant="secondary"
            leftIcon={<KeyIcon className="h-4 w-4" aria-hidden="true" />}
            onClick={() => {
              setNotice(null);
              setAdding(true);
            }}
          >
            {t('security.passkeys.add')}
          </Button>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!removeId}
        onClose={() => setRemoveId(null)}
        onConfirm={() => removeId && remove.mutate(removeId)}
        title={t('security.passkeys.removeTitle')}
        message={t('security.passkeys.removeMessage', {
          name: removing?.name || t('security.passkeys.unnamed'),
        })}
        confirmLabel={t('security.passkeys.removeConfirm')}
        variant="danger"
        isLoading={remove.isPending}
      />
    </Card>
  );
}

function PasskeyRow({ passkey, onRemove }: { passkey: PasskeySummary; onRemove: () => void }) {
  const { t } = useTranslation();
  const name = passkey.name || t('security.passkeys.unnamed');
  const kind =
    passkey.attachment === 'platform'
      ? t('security.passkeys.kindDevice')
      : passkey.attachment === 'cross-platform'
        ? t('security.passkeys.kindKey')
        : null;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="truncate font-medium text-gray-900">{name}</p>
        <p className="text-xs text-gray-600">
          {[
            kind,
            passkey.createdAt
              ? t('security.passkeys.addedOn', {
                  date: new Date(passkey.createdAt).toLocaleDateString(),
                })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onRemove}
        leftIcon={<TrashIcon className="h-4 w-4 text-red-500" aria-hidden="true" />}
        aria-label={t('security.passkeys.removeNamed', { name })}
      >
        {t('security.passkeys.remove')}
      </Button>
    </li>
  );
}

/** Re-prove it is you, then let the browser make the passkey. */
function AddPasskey({
  totpEnabled,
  onDone,
  onCancel,
}: {
  totpEnabled: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  const add = useMutation({
    mutationFn: async () => {
      const { options } = await securityService.startPasskeyRegistration(
        password,
        totpEnabled ? normalizeCode(code) : undefined
      );
      const credential = await createPasskey(options);
      await securityService.finishPasskeyRegistration(credential);
    },
    onSuccess: () => {
      setPassword('');
      setCode('');
      onDone();
    },
    onError: () => {
      setCode('');
      passwordRef.current?.focus();
    },
  });

  const codeOk = !totpEnabled || /^\d{6}$/.test(normalizeCode(code));

  return (
    <form
      className="space-y-4 rounded-md border border-gray-200 p-4"
      aria-labelledby="passkey-add-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (password && codeOk) add.mutate();
      }}
    >
      <h3 id="passkey-add-title" className="text-base font-semibold text-ink">
        {t('security.passkeys.addTitle')}
      </h3>
      <p className="text-sm text-gray-700">
        {totpEnabled ? t('security.passkeys.addHelpWithCode') : t('security.passkeys.addHelp')}
      </p>
      {add.isError && <Alert variant="error">{passkeyErrorMessage(add.error, t)}</Alert>}
      <Input
        ref={passwordRef}
        label={t('security.totp.currentPassword')}
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {totpEnabled && (
        <Input
          label={t('security.totp.codeLabel')}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" isLoading={add.isPending} disabled={!password || !codeOk}>
          {t('security.passkeys.addConfirm')}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('security.totp.cancel')}
        </Button>
      </div>
    </form>
  );
}
