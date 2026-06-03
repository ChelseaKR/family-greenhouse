import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuthStore } from '@/store/authStore';
import { authService } from '@/services/authService';
import { track } from '@/services/analytics';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AuthShell } from './AuthShell';

const confirmSchema = z.object({
  code: z.string().length(6, 'Confirmation code must be 6 digits'),
});

type ConfirmFormData = z.infer<typeof confirmSchema>;

export function ConfirmEmailPage() {
  useDocumentTitle('Confirm email');
  const navigate = useNavigate();
  const location = useLocation();
  const { setUser, setTokens } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isResending, setIsResending] = useState(false);

  const email = (location.state as { email?: string })?.email;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ConfirmFormData>({
    resolver: zodResolver(confirmSchema),
  });

  if (!email) {
    return (
      <AuthShell
        title="No email on file"
        subtitle="Start the registration flow from the beginning."
      >
        <p className="text-center text-gray-700">No email address provided.</p>
        <div className="mt-4 text-center">
          <Link
            to="/register"
            className="text-sm font-medium text-primary-700 hover:text-primary-600"
          >
            Go to registration
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
      const response = await authService.confirmEmail({
        email,
        code: data.code,
      });
      setTokens(response.idToken, response.accessToken, response.refreshToken);
      setUser(response.user);
      track('signup_completed');
      navigate('/onboarding');
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
