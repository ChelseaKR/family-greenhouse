import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ClipboardDocumentIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { getErrorMessage } from '@/services/api';
import {
  groupSecret,
  otpauthUri,
  securityService,
  type MfaStatus,
} from '@/services/securityService';
import { useAuthStore } from '@/store/authStore';
import { isNativeApp } from '@/lib/platform';
import { normalizeCode, readMfaErrorCode } from '@/features/auth/signInFlow';
import { QrCode } from './QrCode';
import { PasskeySettings } from './PasskeySettings';
import { authService } from '@/services/authService';
import { passkeysUsableHere } from '@/lib/webauthn';

const STATUS_KEY = ['mfa-status'] as const;

/** A two-step-verification refusal, worded in the reader's language. */
function mfaErrorMessage(error: unknown, t: TFunction): string {
  switch (readMfaErrorCode(error)) {
    case 'REAUTH_FAILED':
      return t('security.totp.wrongPassword');
    case 'INVALID_CODE':
      return t('security.totp.wrongCode');
    case 'TOTP_ALREADY_ENABLED':
      return t('security.totp.alreadyOn');
    case 'TOTP_SETUP_NOT_STARTED':
      return t('security.totp.setupExpired');
    default:
      return getErrorMessage(error);
  }
}

/**
 * Settings → Security (#671). Two-step verification with an authenticator app,
 * on Cognito's software-token MFA: set up (password, then QR or key, then one
 * code), see whether it is on, and turn it off (password and a current code).
 *
 * ADR 0010: the status is a READ, and a failed read is shown as a failure —
 * never as "off", which would invite someone who has it on to set it up again
 * (refused) or to believe their account is less protected than it is.
 */
export function SecuritySettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'idle' | 'enrolling' | 'disabling'>('idle');
  const [notice, setNotice] = useState<'enabled' | 'disabled' | null>(null);
  const setUpButtonRef = useRef<HTMLButtonElement>(null);
  const turnOffButtonRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const statusQuery = useQuery({
    queryKey: STATUS_KEY,
    queryFn: securityService.getMfaStatus,
    staleTime: 60_000,
  });
  const statusUnavailable = !statusQuery.isLoading && statusQuery.data === undefined;
  const enabled = statusQuery.data?.totp.enabled === true;

  // Passkeys (#671): the card exists only where a passkey can be made — a
  // browser with WebAuthn on the site's own origin, never the native shells
  // (lib/webauthn.ts) — and only once the deployment says they are on.
  const usable = passkeysUsableHere();
  const passkeysQuery = useQuery({
    queryKey: ['passkeys-available'],
    queryFn: authService.passkeysAvailable,
    enabled: usable,
    staleTime: 300_000,
  });
  const showPasskeys = usable && passkeysQuery.data === true;

  const settle = (status: MfaStatus, next: 'enabled' | 'disabled' | null) => {
    queryClient.setQueryData(STATUS_KEY, status);
    setMode('idle');
    setNotice(next);
  };

  // Where focus goes when a flow closes: onto the control that reopens it, or
  // onto the status line that now says what changed.
  const previousMode = useRef(mode);
  useEffect(() => {
    if (previousMode.current !== 'idle' && mode === 'idle') {
      if (notice) statusRef.current?.focus();
      else (enabled ? turnOffButtonRef : setUpButtonRef).current?.focus();
    }
    previousMode.current = mode;
  }, [mode, notice, enabled]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={t('security.totp.title')} description={t('security.totp.description')} />

        {statusQuery.isLoading ? (
          <div className="flex justify-center py-4">
            <LoadingSpinner size="md" />
          </div>
        ) : statusUnavailable ? (
          <Alert variant="error">
            <p>
              {t('security.totp.loadFailed')} {getErrorMessage(statusQuery.error)}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => void statusQuery.refetch()}
            >
              {t('security.totp.retry')}
            </Button>
          </Alert>
        ) : (
          <div className="space-y-4">
            {notice === 'enabled' && (
              <Alert variant="success">{t('security.totp.enabledNotice')}</Alert>
            )}
            {notice === 'disabled' && (
              <Alert variant="success">{t('security.totp.disabledNotice')}</Alert>
            )}
            <p
              ref={statusRef}
              tabIndex={-1}
              className="flex items-start gap-2 text-sm text-gray-900 focus:outline-none"
              data-testid="totp-status"
            >
              {enabled && (
                <ShieldCheckIcon className="h-5 w-5 shrink-0 text-primary-700" aria-hidden="true" />
              )}
              <span>{enabled ? t('security.totp.onSummary') : t('security.totp.offSummary')}</span>
            </p>

            {mode === 'enrolling' && (
              <TotpEnrollment
                onDone={() => settle({ totp: { enabled: true } }, 'enabled')}
                onCancel={() => setMode('idle')}
              />
            )}
            {mode === 'disabling' && (
              <TotpDisable
                onDone={() => settle({ totp: { enabled: false } }, 'disabled')}
                onCancel={() => setMode('idle')}
              />
            )}

            {mode === 'idle' && !enabled && (
              <Button
                ref={setUpButtonRef}
                onClick={() => {
                  setNotice(null);
                  setMode('enrolling');
                }}
              >
                {t('security.totp.setUp')}
              </Button>
            )}
            {mode === 'idle' && enabled && (
              <>
                <RecoveryGuidance />
                <Button
                  ref={turnOffButtonRef}
                  variant="secondary"
                  onClick={() => {
                    setNotice(null);
                    setMode('disabling');
                  }}
                >
                  {t('security.totp.turnOff')}
                </Button>
              </>
            )}
          </div>
        )}
      </Card>

      {showPasskeys && statusQuery.data !== undefined && <PasskeySettings totpEnabled={enabled} />}
    </div>
  );
}

/** What to do if the phone is lost: shown after setup and while it is on. */
function RecoveryGuidance() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="totp-recovery-title" className="rounded-md bg-primary-50/60 p-4">
      <h3 id="totp-recovery-title" className="text-sm font-semibold text-ink">
        {t('security.totp.recoveryTitle')}
      </h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
        <li>{t('security.totp.recovery1')}</li>
        <li>{t('security.totp.recovery2')}</li>
        <li>{t('security.totp.recovery3')}</li>
      </ul>
    </section>
  );
}

type EnrollStep = 'password' | 'scan' | 'done';

/**
 * Setup, in three steps. The secret lives only in this component's state, from
 * the setup response until the flow closes; it is never written to storage.
 */
function TotpEnrollment({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const email = useAuthStore((s) => s.user?.email ?? '');
  const [step, setStep] = useState<EnrollStep>('password');
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeFormatError, setCodeFormatError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const scanHeadingRef = useRef<HTMLHeadingElement>(null);
  const doneHeadingRef = useRef<HTMLHeadingElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Each step takes focus when it appears, so keyboard and screen-reader
  // users start where the content changed.
  useEffect(() => {
    if (step === 'password') passwordRef.current?.focus();
    if (step === 'scan') scanHeadingRef.current?.focus();
    if (step === 'done') doneHeadingRef.current?.focus();
  }, [step]);

  const start = useMutation({
    mutationFn: () => securityService.startTotpSetup(password),
    onSuccess: ({ secretCode }) => {
      setPassword('');
      setSecret(secretCode);
      setStep('scan');
    },
    onError: () => passwordRef.current?.focus(),
  });

  const verify = useMutation({
    mutationFn: (digits: string) => securityService.verifyTotp(digits),
    onSuccess: () => {
      // The secret has done its job; drop it before the recovery step shows.
      setSecret(null);
      setCode('');
      setStep('done');
    },
    onError: (error) => {
      setCode('');
      if (readMfaErrorCode(error) === 'TOTP_SETUP_NOT_STARTED') {
        setSecret(null);
        setStep('password');
      } else {
        codeRef.current?.focus();
      }
    },
  });

  async function copyKey() {
    if (!secret) return;
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  if (step === 'password') {
    return (
      <form
        className="space-y-4 rounded-md border border-gray-200 p-4"
        aria-labelledby="totp-password-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (password) start.mutate();
        }}
      >
        <h3 id="totp-password-title" className="text-base font-semibold text-ink">
          {t('security.totp.passwordStepTitle')}
        </h3>
        <p className="text-sm text-gray-700">{t('security.totp.passwordStepHelp')}</p>
        {(start.isError || verify.isError) && (
          <Alert variant="error">{mfaErrorMessage(start.error ?? verify.error, t)}</Alert>
        )}
        <Input
          ref={passwordRef}
          label={t('security.totp.currentPassword')}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" isLoading={start.isPending} disabled={!password}>
            {t('security.totp.continue')}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('security.totp.cancel')}
          </Button>
        </div>
      </form>
    );
  }

  if (step === 'scan' && secret) {
    return (
      <form
        className="space-y-4 rounded-md border border-gray-200 p-4"
        aria-labelledby="totp-scan-title"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const digits = normalizeCode(code);
          if (!/^\d{6}$/.test(digits)) {
            setCodeFormatError(t('security.totp.codeFormat'));
            codeRef.current?.focus();
            return;
          }
          setCodeFormatError(null);
          verify.mutate(digits);
        }}
      >
        <h3
          id="totp-scan-title"
          ref={scanHeadingRef}
          tabIndex={-1}
          className="text-base font-semibold text-ink focus:outline-none"
        >
          {t('security.totp.scanTitle')}
        </h3>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
          <li>{t('security.totp.scanStep1')}</li>
          <li>{t('security.totp.scanStep2')}</li>
          <li>{t('security.totp.scanStep3')}</li>
        </ol>
        {isNativeApp() && <p className="text-sm text-gray-700">{t('security.totp.nativeHint')}</p>}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <QrCode
            value={otpauthUri(secret, email)}
            label={t('security.totp.qrLabel')}
            unavailableText={t('security.totp.qrUnavailable')}
          />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="label" id="totp-key-label">
              {t('security.totp.manualKey')}
            </p>
            <code
              className="block break-all rounded-sm bg-gray-50 px-2 py-1 font-mono text-sm text-gray-900"
              aria-labelledby="totp-key-label"
              data-testid="totp-secret"
            >
              {groupSecret(secret)}
            </code>
            <p className="text-xs text-gray-600">{t('security.totp.manualKeyHelp')}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={copyKey}
              leftIcon={<ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />}
            >
              {copied ? t('security.totp.copied') : t('security.totp.copyKey')}
            </Button>
            {copyFailed && (
              <p className="text-sm text-red-700" role="alert">
                {t('security.totp.copyFailed')}
              </p>
            )}
          </div>
        </div>
        {verify.isError && <Alert variant="error">{mfaErrorMessage(verify.error, t)}</Alert>}
        <Input
          ref={codeRef}
          label={t('security.totp.codeLabel')}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          required
          error={codeFormatError ?? undefined}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setCodeFormatError(null);
          }}
        />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" isLoading={verify.isPending}>
            {t('security.totp.verify')}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('security.totp.cancel')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-gray-200 p-4">
      <h3
        ref={doneHeadingRef}
        tabIndex={-1}
        className="text-base font-semibold text-ink focus:outline-none"
      >
        {t('security.totp.enabledTitle')}
      </h3>
      <RecoveryGuidance />
      <Button onClick={onDone}>{t('security.totp.done')}</Button>
    </div>
  );
}

/** Turning it off: the password and a current code, checked by Cognito. */
function TotpDisable({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeFormatError, setCodeFormatError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  const disable = useMutation({
    mutationFn: (digits: string) => securityService.disableTotp(password, digits),
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

  return (
    <form
      className="space-y-4 rounded-md border border-gray-200 p-4"
      aria-labelledby="totp-disable-title"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const digits = normalizeCode(code);
        if (!/^\d{6}$/.test(digits)) {
          setCodeFormatError(t('security.totp.codeFormat'));
          return;
        }
        setCodeFormatError(null);
        if (password) disable.mutate(digits);
      }}
    >
      <h3 id="totp-disable-title" className="text-base font-semibold text-ink">
        {t('security.totp.turnOffTitle')}
      </h3>
      <p className="text-sm text-gray-700">{t('security.totp.turnOffHelp')}</p>
      {disable.isError && <Alert variant="error">{mfaErrorMessage(disable.error, t)}</Alert>}
      <Input
        ref={passwordRef}
        label={t('security.totp.currentPassword')}
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Input
        label={t('security.totp.codeLabel')}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        required
        error={codeFormatError ?? undefined}
        value={code}
        onChange={(event) => {
          setCode(event.target.value);
          setCodeFormatError(null);
        }}
      />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="danger" isLoading={disable.isPending} disabled={!password}>
          {t('security.totp.turnOffConfirm')}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('security.totp.cancel')}
        </Button>
      </div>
    </form>
  );
}
