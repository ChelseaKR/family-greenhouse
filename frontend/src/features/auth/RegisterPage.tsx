import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
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
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AuthShell } from './AuthShell';
import { setPendingConfirmation } from './pendingConfirmation';
import { safeAppRedirect } from './safeRedirect';

const makeRegisterSchema = (t: TFunction) =>
  z
    .object({
      name: z.string().trim().min(2, t('auth.nameMin')).max(100, t('auth.nameMax')),
      email: z.string().email(t('auth.invalidEmail')),
      password: z
        .string()
        .min(12, t('auth.passwordMin'))
        .regex(/[A-Z]/, t('auth.passwordUppercase'))
        .regex(/[a-z]/, t('auth.passwordLowercase'))
        .regex(/[0-9]/, t('auth.passwordNumber')),
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: t('auth.passwordMismatch'),
      path: ['confirmPassword'],
    });

type RegisterFormData = z.infer<ReturnType<typeof makeRegisterSchema>>;

export function RegisterPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('auth.signUpTitle'));
  const [searchParams] = useSearchParams();
  const redirect = safeAppRedirect(searchParams.get('redirect'));
  const loginHref = redirect ? `/login?redirect=${encodeURIComponent(redirect)}` : '/login';

  if (!PUBLIC_REGISTRATION_AVAILABLE) {
    return (
      <AuthShell
        title={t('auth.registrationPausedTitle')}
        subtitle={t('auth.registrationPausedSubtitle')}
        footer={
          <>
            {t('auth.existingAccount')}{' '}
            <Link to={loginHref} className="font-medium text-primary-700 hover:text-primary-600">
              {t('auth.signInButton')}
            </Link>
          </>
        }
      >
        <Alert variant="info">{t('auth.registrationPausedMessage')}</Alert>
      </AuthShell>
    );
  }

  return <RegistrationForm redirect={redirect} loginHref={loginHref} />;
}

function RegistrationForm({ redirect, loginHref }: { redirect: string | null; loginHref: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Preserve a post-auth redirect (e.g. /join/CODE from a shared invite) across
  // register → confirm → login so an invite-accept flow resumes after signup.
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const registerSchema = useMemo(() => makeRegisterSchema(t), [t]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
  });

  const onSubmit = async (data: RegisterFormData) => {
    setError(null);
    setIsLoading(true);

    try {
      await authService.register({
        name: data.name,
        email: data.email,
        password: data.password,
      });
      setPendingConfirmation({ email: data.email, redirect });
      navigate('/confirm-email', { state: { email: data.email, redirect } });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.registerTitle')}
      subtitle={t('auth.registerSubtitle')}
      footer={
        <>
          {t('auth.existingAccount')}{' '}
          <Link to={loginHref} className="font-medium text-primary-700 hover:text-primary-600">
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
          label={t('auth.fullName')}
          type="text"
          autoComplete="name"
          required
          error={errors.name?.message}
          {...register('name')}
        />

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
          autoComplete="new-password"
          minLength={12}
          required
          error={errors.password?.message}
          helperText={t('auth.passwordHelper')}
          {...register('password')}
        />

        <Input
          label={t('auth.confirmPassword')}
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

        <Button type="submit" className="w-full" isLoading={isLoading}>
          {t('auth.createAccount')}
        </Button>
      </form>
    </AuthShell>
  );
}
