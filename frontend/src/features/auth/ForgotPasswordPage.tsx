import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { authService } from '@/services/authService';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AuthShell } from './AuthShell';

// Built per call so the message is in the visitor's language, as
// loginSchema.ts does.
const makeForgotPasswordSchema = (t: TFunction) =>
  z.object({
    email: z.string().email(t('auth.invalidEmail')),
  });

type ForgotPasswordFormData = z.infer<ReturnType<typeof makeForgotPasswordSchema>>;

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('auth.forgot.documentTitle'));
  const schema = useMemo(() => makeForgotPasswordSchema(t), [t]);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: ForgotPasswordFormData) => {
    setError(null);
    setIsLoading(true);

    try {
      await authService.forgotPassword(data);
      navigate('/reset-password', { state: { email: data.email } });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.forgot.title')}
      subtitle={t('auth.forgot.subtitle')}
      footer={
        <>
          {t('auth.forgot.remember')}{' '}
          <Link to="/login" className="font-medium text-primary-700 hover:text-primary-600">
            {t('auth.signInButton')}
          </Link>
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
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />

        <Button type="submit" className="w-full" isLoading={isLoading}>
          {t('auth.forgot.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
