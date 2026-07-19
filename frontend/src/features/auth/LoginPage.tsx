import { useState, useMemo } from 'react';
import { Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuthStore } from '@/store/authStore';
import { authService } from '@/services/authService';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { AuthShell } from './AuthShell';
import { safeAppRedirect } from './safeRedirect';

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
  useDocumentTitle(t('auth.signInButton'));
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { setUser, setTokens } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

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
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: confirmState?.email ?? '' },
  });

  const onSubmit = async (data: LoginFormData) => {
    setError(null);
    setIsLoading(true);

    try {
      const response = await authService.login(data);
      setTokens(response.idToken, response.accessToken, response.refreshToken);
      setUser(response.user);
      navigate(from, { replace: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

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

        <div className="flex items-center justify-end">
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
    </AuthShell>
  );
}
