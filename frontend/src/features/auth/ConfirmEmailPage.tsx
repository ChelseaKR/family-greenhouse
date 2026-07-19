import { useMemo, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { authService } from '@/services/authService';
import { track } from '@/services/analytics';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AuthShell } from './AuthShell';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  clearPendingConfirmation,
  getPendingConfirmation,
  setPendingConfirmation,
} from './pendingConfirmation';
import { safeAppRedirect } from './safeRedirect';

const makeConfirmSchema = (t: TFunction) =>
  z.object({
    code: z.string().regex(/^\d{6}$/, t('auth.confirmationCodeLength')),
  });

type ConfirmFormData = z.infer<ReturnType<typeof makeConfirmSchema>>;

export function ConfirmEmailPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('auth.confirmDocumentTitle'));
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState('');

  const state = (location.state as { email?: string; redirect?: string }) ?? {};
  const pending = getPendingConfirmation();
  const email = state.email ?? pending?.email;
  const redirect = state.redirect ?? pending?.redirect ?? undefined;
  const safeRedirect = safeAppRedirect(redirect);
  const loginHref = safeRedirect ? `/login?redirect=${encodeURIComponent(safeRedirect)}` : '/login';
  const confirmSchema = useMemo(() => makeConfirmSchema(t), [t]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ConfirmFormData>({
    resolver: zodResolver(confirmSchema),
  });

  const resendConfirmation = async (targetEmail: string) => {
    setError(null);
    setInfo(null);
    setIsResending(true);
    try {
      await authService.resendConfirmationCode(targetEmail);
      setPendingConfirmation({
        email: targetEmail,
        redirect: targetEmail === email ? safeRedirect : null,
      });
      setInfo(t('auth.confirmationResent'));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsResending(false);
    }
  };

  if (!email) {
    return (
      <AuthShell
        title={t('auth.confirmRecoveryTitle')}
        subtitle={t('auth.confirmRecoverySubtitle')}
      >
        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}
        {info && (
          <Alert variant="success" className="mb-4">
            {info}
          </Alert>
        )}
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void resendConfirmation(recoveryEmail.trim());
          }}
        >
          <Input
            key="confirmation-recovery-email"
            label={t('auth.email')}
            type="email"
            autoComplete="email"
            required
            value={recoveryEmail}
            onChange={(event) => setRecoveryEmail(event.target.value)}
          />
          <Button type="submit" className="w-full" isLoading={isResending}>
            {t('auth.resendConfirmation')}
          </Button>
        </form>
        <div className="mt-4 text-center text-sm text-gray-700">
          {t('auth.existingAccount')}{' '}
          <Link to={loginHref} className="font-medium text-primary-700 hover:text-primary-600">
            {t('auth.signInButton')}
          </Link>
        </div>
        {PUBLIC_REGISTRATION_AVAILABLE ? (
          <div className="mt-3 text-center">
            <Link
              to="/register"
              className="text-sm font-medium text-primary-700 hover:text-primary-600"
            >
              {t('auth.goToRegistration')}
            </Link>
          </div>
        ) : (
          <Alert variant="info" className="mt-4">
            {t('auth.registrationPausedMessage')}
          </Alert>
        )}
      </AuthShell>
    );
  }

  const onSubmit = async (data: ConfirmFormData) => {
    setError(null);
    setInfo(null);
    setIsLoading(true);

    try {
      // Cognito's confirmSignUp returns no tokens — the user must sign in
      // afterward. (The old code read undefined tokens off this response and
      // wrote a half-authenticated session, then bounced off /onboarding's
      // ProtectedRoute back to /login anyway.) Send them to /login with their
      // email prefilled, carrying any post-auth redirect (e.g. /join/CODE) so
      // an invite-accept flow resumes after they sign in.
      await authService.confirmEmail({ email, code: data.code });
      clearPendingConfirmation();
      track('signup_completed');
      navigate(safeRedirect ? `/login?redirect=${encodeURIComponent(safeRedirect)}` : '/login', {
        state: { email, justConfirmed: true },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleResend = async () => {
    await resendConfirmation(email);
  };

  return (
    <AuthShell
      title={t('auth.confirmTitle')}
      subtitle={
        <>
          {t('auth.confirmSentTo')} <strong>{email}</strong>
        </>
      }
      footer={
        <>
          {t('auth.resendPrompt')}{' '}
          <button
            type="button"
            className="font-medium text-primary-700 hover:text-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleResend}
            disabled={isResending}
          >
            {isResending ? t('auth.sending') : t('auth.resendCode')}
          </button>
        </>
      }
    >
      {error && (
        <Alert variant="error" className="mb-6">
          {error}
        </Alert>
      )}
      {info && (
        <Alert variant="success" className="mb-6">
          {info}
        </Alert>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
        <Input
          key="confirmation-code"
          label={t('auth.confirmationCode')}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          autoComplete="one-time-code"
          required
          error={errors.code?.message}
          helperText={t('auth.confirmationCodeHelper')}
          {...register('code')}
        />

        <Button type="submit" className="w-full" isLoading={isLoading}>
          {t('auth.confirmEmailButton')}
        </Button>
      </form>
    </AuthShell>
  );
}
