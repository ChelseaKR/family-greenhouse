import { useMemo, useState } from 'react';
import { useLocation, Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { authService } from '@/services/authService';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AuthShell } from './AuthShell';

// Built per call so the messages are in the visitor's language, as
// loginSchema.ts does.
const makeResetPasswordSchema = (t: TFunction) =>
  z
    .object({
      code: z.string().regex(/^\d{6}$/, t('auth.reset.codeLength')),
      newPassword: z
        .string()
        .min(12, t('auth.passwordMin'))
        .regex(/[A-Z]/, t('auth.passwordUppercase'))
        .regex(/[a-z]/, t('auth.passwordLowercase'))
        .regex(/[0-9]/, t('auth.passwordNumber')),
      confirmPassword: z.string(),
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
      message: t('auth.passwordMismatch'),
      path: ['confirmPassword'],
    });

type ResetPasswordFormData = z.infer<ReturnType<typeof makeResetPasswordSchema>>;

export function ResetPasswordPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('auth.reset.documentTitle'));
  const schema = useMemo(() => makeResetPasswordSchema(t), [t]);
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
    resolver: zodResolver(schema),
  });

  if (!email) {
    return (
      <AuthShell title={t('auth.reset.noEmailTitle')} subtitle={t('auth.reset.noEmailSubtitle')}>
        <p className="text-center text-gray-700">{t('auth.reset.noEmailBody')}</p>
        <div className="mt-4 text-center">
          <Link
            to="/forgot-password"
            className="text-sm font-medium text-primary-700 hover:text-primary-600"
          >
            {t('auth.reset.requestAgain')}
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
      <AuthShell title={t('auth.reset.doneTitle')} subtitle={t('auth.reset.doneSubtitle')}>
        <Alert variant="success" className="mb-6">
          {t('auth.reset.doneBody')}
        </Alert>
        <Link to="/login" className="btn-primary inline-block w-full text-center">
          {t('auth.signInButton')}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('auth.reset.title')}
      subtitle={
        <>
          <Trans
            i18nKey="auth.reset.codeSentTo"
            values={{ email }}
            components={{ strong: <strong /> }}
          />
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
          label={t('auth.reset.codeLabel')}
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
          label={t('auth.reset.newPassword')}
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          error={errors.newPassword?.message}
          helperText={t('auth.passwordHelper')}
          {...register('newPassword')}
        />

        <Input
          label={t('auth.reset.confirmNewPassword')}
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

        <Button type="submit" className="w-full" isLoading={isLoading}>
          {t('auth.reset.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
