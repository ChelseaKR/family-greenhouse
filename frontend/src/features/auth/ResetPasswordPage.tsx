import { useState } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { authService } from '@/services/authService';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AuthShell } from './AuthShell';

const resetPasswordSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/, 'Reset code must be 6 digits'),
    newPassword: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>;

export function ResetPasswordPage() {
  useDocumentTitle('Reset password');
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const email = (location.state as { email?: string })?.email;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetPasswordFormData>({
    resolver: zodResolver(resetPasswordSchema),
  });

  if (!email) {
    return (
      <AuthShell title="No email on file" subtitle="Start the reset flow from the beginning.">
        <p className="text-center text-gray-700">No email address provided.</p>
        <div className="mt-4 text-center">
          <Link
            to="/forgot-password"
            className="text-sm font-medium text-primary-700 hover:text-primary-600"
          >
            Request password reset
          </Link>
        </div>
      </AuthShell>
    );
  }

  const onSubmit = async (data: ResetPasswordFormData) => {
    setError(null);
    setIsLoading(true);

    try {
      await authService.resetPassword({
        email,
        code: data.code,
        newPassword: data.newPassword,
      });
      setSuccess(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <AuthShell title="Password reset" subtitle="You're all set — sign back in to continue.">
        <Alert variant="success" className="mb-6">
          Your password has been reset successfully.
        </Alert>
        <Link to="/login" className="btn-primary inline-block w-full text-center">
          Sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Set a new password"
      subtitle={
        <>
          Enter the code we sent to <strong>{email}</strong>
        </>
      }
    >
      {error && (
        <Alert variant="error" className="mb-6">
          {error}
        </Alert>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
        <Input
          label="Reset code"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          autoComplete="one-time-code"
          required
          error={errors.code?.message}
          {...register('code')}
        />

        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          error={errors.newPassword?.message}
          helperText="At least 12 characters with uppercase, lowercase, and number"
          {...register('newPassword')}
        />

        <Input
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

        <Button type="submit" className="w-full" isLoading={isLoading}>
          Reset password
        </Button>
      </form>
    </AuthShell>
  );
}
