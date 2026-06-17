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
import { AuthShell } from './AuthShell';

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
  useDocumentTitle('Sign in');
  const { t } = useTranslation();
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
  const safeRedirect = redirectParam?.startsWith('/') && !redirectParam.startsWith('//');
  const from =
    (safeRedirect ? redirectParam : null) ??
    (location.state as { from?: { pathname: string } })?.from?.pathname ??
    '/dashboard';
  const loginSchema = useMemo(() => makeLoginSchema(t), [t]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
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
      title="Welcome back"
      subtitle="Sign in to tend to your greenhouse."
      footer={
        <>
          Don't have an account?{' '}
          <Link to="/register" className="font-medium text-primary-700 hover:text-primary-600">
            Sign up
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
          label="Email address"
          type="email"
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email')}
        />

        <Input
          label="Password"
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
            Forgot your password?
          </Link>
        </div>

        <Button type="submit" className="w-full" isLoading={isLoading}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
