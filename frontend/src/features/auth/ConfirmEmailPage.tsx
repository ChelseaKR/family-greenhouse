import { useState } from 'react';
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
import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';
import { useTranslation } from 'react-i18next';

const confirmSchema = z.object({
  code: z.string().length(6, 'Confirmation code must be 6 digits'),
});

type ConfirmFormData = z.infer<typeof confirmSchema>;

export function ConfirmEmailPage() {
  const { t } = useTranslation();
  useDocumentTitle('Confirm email');
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isResending, setIsResending] = useState(false);

  const { email, redirect } = (location.state as { email?: string; redirect?: string }) ?? {};

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ConfirmFormData>({
    resolver: zodResolver(confirmSchema),
  });

  if (!email) {
    return (
      <AuthShell title="No confirmation in progress" subtitle={t('commercialHold.headline')}>
        <p className="text-center text-gray-700">No email address provided.</p>
        <CommercialHoldNotice compact className="mt-4" />
        <div className="mt-4 text-center text-sm text-gray-700">
          {t('auth.existingAccount')}{' '}
          <Link to="/login" className="text-sm font-medium text-primary-700 hover:text-primary-600">
            {t('auth.signInButton')}
          </Link>
        </div>
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
      track('signup_completed');
      const safeRedirect =
        redirect?.startsWith('/') && !redirect.startsWith('//') ? redirect : null;
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
    setError(null);
    setInfo(null);
    setIsResending(true);
    try {
      const result = await authService.resendConfirmationCode(email);
      setInfo(result.message);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsResending(false);
    }
  };

  return (
    <AuthShell
      title="Confirm your email"
      subtitle={
        <>
          We sent a confirmation code to <strong>{email}</strong>
        </>
      }
      footer={
        <>
          Didn't receive the code?{' '}
          <button
            type="button"
            className="font-medium text-primary-700 hover:text-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleResend}
            disabled={isResending}
          >
            {isResending ? 'Sending…' : 'Resend code'}
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
          label="Confirmation code"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          autoComplete="one-time-code"
          required
          error={errors.code?.message}
          helperText="Enter the 6-digit code from your email"
          {...register('code')}
        />

        <Button type="submit" className="w-full" isLoading={isLoading}>
          Confirm email
        </Button>
      </form>
    </AuthShell>
  );
}
