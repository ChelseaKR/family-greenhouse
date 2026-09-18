import { useEffect, useState, useMemo, useRef } from 'react';
import { Link, useNavigate, useLocation, useSearchParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuthStore } from '@/store/authStore';
import {
  authService,
  isMfaChallenge,
  type AuthResponse,
  type LoginCredentials,
} from '@/services/authService';
import { getPasskeyAssertion, isCeremonyCancelled, passkeysUsableHere } from '@/lib/webauthn';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { AuthShell } from './AuthShell';
import { safeAppRedirect } from './safeRedirect';
import { readMfaErrorCode, submitCode, submitCredentials, type SignInState } from './signInFlow';
import { TotpChallengeForm } from './TotpChallengeForm';

// Built per-render from the active locale so validation messages are
// translated (zod resolves the message at schema-construction time, so the
// schema has to be rebuilt when the language changes — not defined at module
// load when no `t` exists yet).
const makeLoginSchema = (t: TFunction) =>
  z.object({
    email: z.string().email(t('auth.invalidEmail')),
    password: z.string().min(1, t('auth.passwordRequired')),
  });

type LoginFormData = z.infer<ReturnType<typeof makeLoginSchema>>;

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { setUser, setTokens, setRememberMe } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Default off: staying signed in after the browser closes means the
  // long-lived refresh token is persisted to localStorage, so it is asked for
  // rather than assumed. See the storage model in store/authStore.ts.
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  // Two-step verification (#671). The credentials are held only while the
  // code step is on screen — the flow may need them to start a fresh
  // challenge — and are dropped on success or on "back".
  const [codeStep, setCodeStep] = useState<Extract<SignInState, { step: 'code' }> | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const credentialsRef = useRef<LoginCredentials | null>(null);
  useDocumentTitle(codeStep ? t('auth.mfa.title') : t('auth.signInButton'));
  // Passkeys (#671): offered only where one can run (a browser with WebAuthn
  // on the site's own origin — never the native shells) AND the deployment
  // has them on. Unknown or failed = not offered: the password form is
  // always there, so a missing alternative is not a false all-clear.
  const [passkeysOffered, setPasskeysOffered] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  useEffect(() => {
    if (!passkeysUsableHere()) return;
    let cancelled = false;
    authService
      .passkeysAvailable()
      .then((available) => {
        if (!cancelled) setPasskeysOffered(available);
      })
      .catch(() => {
        if (!cancelled) setPasskeysOffered(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // An explicit ?redirect= (e.g. from a shared cutting card) wins, then the
  // ProtectedRoute's saved location, then the dashboard. Only same-origin
  // app paths are honored — guard against open-redirects.
  const redirectParam = searchParams.get('redirect');
  const safeRedirect = safeAppRedirect(redirectParam);
  const stateFrom = (location.state as { from?: { pathname?: string } })?.from?.pathname;
  const safeStateFrom = safeAppRedirect(stateFrom);
  const from = safeRedirect ?? safeStateFrom ?? '/dashboard';
  const signupHref =
    from !== '/dashboard' ? `/register?redirect=${encodeURIComponent(from)}` : '/register';
  const loginSchema = useMemo(() => makeLoginSchema(t), [t]);

  // After email confirmation the confirm page sends the user here with their
  // email + a justConfirmed flag (Cognito confirmSignUp issues no tokens, so a
  // sign-in is required). Prefill the email and show a success notice.
  const confirmState = location.state as { email?: string; justConfirmed?: boolean } | null;

  const {
    register,
    handleSubmit,
    trigger,
    getValues,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: confirmState?.email ?? '' },
  });

  const finishSignIn = (response: AuthResponse) => {
    credentialsRef.current = null;
    // BEFORE setTokens: the persist adapter reads this flag off the payload
    // it is writing, so it decides where the refresh token lands.
    setRememberMe(keepSignedIn);
    setTokens(response.idToken, response.accessToken, response.refreshToken);
    setUser(response.user);
    navigate(from, { replace: true });
  };

  const onSubmit = async (data: LoginFormData) => {
    setError(null);
    setIsLoading(true);

    try {
      const outcome = await submitCredentials(authService, data);
      if (outcome.kind === 'signedIn') {
        finishSignIn(outcome.auth);
      } else if (outcome.kind === 'needsCode') {
        credentialsRef.current = { email: data.email, password: data.password };
        setCodeError(null);
        setCodeStep(outcome.state);
      }
    } catch (err) {
      setError(signInErrorMessage(err, t));
    } finally {
      setIsLoading(false);
    }
  };

  const onSubmitCode = async (code: string) => {
    if (!codeStep) return;
    setCodeError(null);
    setIsLoading(true);
    try {
      const outcome = await submitCode(authService, credentialsRef.current, codeStep, code);
      if (outcome.kind === 'signedIn') {
        finishSignIn(outcome.auth);
      } else if (outcome.kind === 'restart') {
        backToCredentials();
        setError(t('auth.mfa.expired'));
      } else {
        setCodeStep(outcome.state);
        if (outcome.kind === 'wrongCode') setCodeError(t('auth.mfa.wrongCode'));
      }
    } catch (err) {
      setCodeError(signInErrorMessage(err, t));
    } finally {
      setIsLoading(false);
    }
  };

  // Passkey sign-in: the email says which account; the browser's passkey
  // sheet does the rest. Cognito verifies the assertion.
  const onPasskey = async () => {
    setError(null);
    if (!(await trigger('email'))) return;
    setPasskeyLoading(true);
    try {
      const started = await authService.startPasskeySignIn(getValues('email'));
      const credential = await getPasskeyAssertion(started.options);
      const result = await authService.finishPasskeySignIn({
        username: started.username,
        session: started.session,
        credential,
      });
      if (isMfaChallenge(result)) {
        // Cognito asked for the authenticator code after the passkey. There
        // is no password to re-challenge with, so a wrong code starts over.
        credentialsRef.current = null;
        setCodeError(null);
        setCodeStep({ step: 'code', challenge: result, spent: false });
      } else {
        finishSignIn(result);
      }
    } catch (err) {
      setError(isCeremonyCancelled(err) ? t('auth.passkey.cancelled') : signInErrorMessage(err, t));
    } finally {
      setPasskeyLoading(false);
    }
  };

  const backToCredentials = () => {
    credentialsRef.current = null;
    setCodeStep(null);
    setCodeError(null);
  };

  if (codeStep) {
    return (
      <AuthShell title={t('auth.mfa.title')} subtitle={t('auth.mfa.subtitle')}>
        <TotpChallengeForm
          onSubmit={onSubmitCode}
          onBack={backToCredentials}
          error={codeError}
          isLoading={isLoading}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.loginTitle')}
      subtitle={t('auth.loginSubtitle')}
      footer={
        PUBLIC_REGISTRATION_AVAILABLE ? (
          <>
            {t('auth.noAccount')}{' '}
            <Link to={signupHref} className="font-medium text-primary-700 hover:text-primary-600">
              {t('auth.signUpFree')}
            </Link>
          </>
        ) : (
          <>{t('auth.registrationPausedMessage')}</>
        )
      }
    >
      {error && (
        <Alert variant="error" className="mb-6">
          {error}
        </Alert>
      )}
      {confirmState?.justConfirmed && !error && (
        <Alert variant="success" className="mb-6">
          {t('auth.emailConfirmed')}
        </Alert>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
        <Input
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />

        <Input
          label={t('auth.password')}
          type="password"
          autoComplete="current-password"
          required
          error={errors.password?.message}
          {...register('password')}
        />

        <div className="flex items-center justify-between">
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary-700"
              checked={keepSignedIn}
              onChange={(event) => setKeepSignedIn(event.target.checked)}
            />
            <span className="text-sm text-gray-700">{t('auth.keepSignedIn')}</span>
          </label>
          <Link
            to="/forgot-password"
            className="text-sm font-medium text-primary-700 hover:text-primary-600"
          >
            {t('auth.forgotPassword')}
          </Link>
        </div>

        <Button type="submit" className="w-full" isLoading={isLoading}>
          {t('auth.signInButton')}
        </Button>
      </form>

      {passkeysOffered && (
        <div className="mt-6 space-y-4">
          <p className="flex items-center gap-3 text-xs uppercase tracking-wide text-gray-600">
            <span className="h-px flex-1 bg-gray-200" aria-hidden="true" />
            {t('auth.passkey.or')}
            <span className="h-px flex-1 bg-gray-200" aria-hidden="true" />
          </p>
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            isLoading={passkeyLoading}
            onClick={() => void onPasskey()}
          >
            {t('auth.passkey.use')}
          </Button>
        </div>
      )}
    </AuthShell>
  );
}

/** A refused sign-in step, worded in the reader's language where it is coded. */
function signInErrorMessage(error: unknown, t: TFunction): string {
  switch (readMfaErrorCode(error)) {
    case 'INVALID_CODE':
      return t('auth.mfa.wrongCode');
    case 'MFA_SESSION_EXPIRED':
      return t('auth.mfa.expired');
    case 'UNSUPPORTED_CHALLENGE':
      return t('auth.mfa.unsupported');
    case 'NO_PASSKEY':
      return t('auth.passkey.noPasskey');
    case 'PASSKEY_REJECTED':
      return t('auth.passkey.rejected');
    case 'PASSKEY_EXPIRED':
      return t('auth.passkey.expired');
    default:
      return getErrorMessage(error);
  }
}
