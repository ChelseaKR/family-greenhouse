import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { track } from '@/services/analytics';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { HomeIcon, UserGroupIcon } from '@heroicons/react/24/outline';
import { BrandMark } from '@/components/BrandMark';
import { useAuthStore } from '@/store/authStore';
import { householdService } from '@/services/householdService';
import { authService } from '@/services/authService';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Card } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { getPendingShareCode, clearPendingShareCode } from '@/features/plants/pendingShareCode';
import { useTranslation } from 'react-i18next';

type OnboardingStep = 'choice' | 'create' | 'join';

const createHouseholdSchema = z.object({
  name: z.string().min(1, 'Household name is required').max(100),
});

type CreateHouseholdFormData = z.infer<typeof createHouseholdSchema>;

export function HouseholdOnboarding() {
  const { t } = useTranslation();
  useDocumentTitle('Welcome');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const { setHousehold, setActiveHouseholdId, user } = useAuthStore();
  // `?mode=add` distinguishes "new user, first household" from "existing
  // user adding another household". Different success states.
  const isAddingAnother = params.get('mode') === 'add' && !!user?.householdId;
  // When adding another household we know it's a "create" flow; the
  // "choice" screen would be redundant ceremony.
  const [step, setStep] = useState<OnboardingStep>(
    params.get('mode') === 'add' ? 'create' : 'choice'
  );
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateHouseholdFormData>({
    resolver: zodResolver(createHouseholdSchema),
  });

  const createMutation = useMutation({
    mutationFn: householdService.createHousehold,
    onSuccess: async (household) => {
      track('household_created', {
        ordinal: isAddingAnother ? 'subsequent' : 'first',
      });
      if (isAddingAnother) {
        // Activate the newly-created household via the X-Household-Id
        // path; don't disturb the user's "default" Cognito-claim household.
        setActiveHouseholdId(household.id);
        queryClient.invalidateQueries();
        navigate('/dashboard');
      } else {
        setHousehold(household.id, 'admin');
        // The `custom:household_id` claim was just written to Cognito, but our
        // current access token predates it. Refresh now so the very first
        // /dashboard request carries valid household claims instead of eating
        // a 403 and bouncing through the interceptor's on-demand refresh.
        // Best-effort: if the refresh fails, the interceptor still recovers on
        // the first failing request.
        const { refreshToken, setTokens } = useAuthStore.getState();
        if (refreshToken) {
          try {
            const tokens = await authService.refreshToken(refreshToken);
            setTokens(tokens.idToken, tokens.accessToken, tokens.refreshToken);
          } catch {
            // fall through — the 401-refresh interceptor will catch up.
          }
        }
        // If this signup began on a shared cutting card, bring the new member
        // back to it so they can graft it into the household they just made —
        // the lineage continues across people. Otherwise land on home.
        const pendingShareCode = getPendingShareCode();
        if (pendingShareCode) {
          clearPendingShareCode();
          navigate(`/shared/${pendingShareCode}`);
        } else {
          navigate('/');
        }
      }
    },
    onError: (err) => {
      setError(getErrorMessage(err));
    },
  });

  const onSubmit = (data: CreateHouseholdFormData) => {
    setError(null);
    createMutation.mutate(data);
  };

  return (
    <div className="greenhouse-grid min-h-screen flex flex-col justify-center bg-paper py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md flex flex-col items-center">
        <BrandMark variant="wordmark" />
        <h2 className="mt-8 text-center font-serif text-3xl tracking-tight text-ink">
          {step === 'choice' &&
            (isAddingAnother ? 'Add another household' : 'Set up your household')}
          {step === 'create' &&
            (isAddingAnother ? 'Name your new household' : 'Create your household')}
          {step === 'join' && 'Join a household'}
        </h2>
        {step === 'choice' && !isAddingAnother && (
          <p className="mt-2 max-w-sm text-center text-sm text-gray-600">
            A household keeps your plant care in one place — just you, or shared with others. Create
            one to start fresh, or if someone already invited you, paste their link instead.
          </p>
        )}
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        {step === 'choice' && (
          <div className="space-y-4">
            <button type="button" onClick={() => setStep('create')} className="w-full">
              <Card className="hover:border-primary-500 hover:shadow-md transition-all cursor-pointer">
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 rounded-lg bg-primary-100 p-3">
                    <HomeIcon className="h-6 w-6 text-primary-700" aria-hidden="true" />
                  </div>
                  <div className="text-left">
                    <h3 className="text-base font-semibold text-ink">Create a new household</h3>
                    <p className="mt-1 text-sm text-gray-500">
                      Start fresh on your own — invite family any time you like
                    </p>
                  </div>
                </div>
              </Card>
            </button>

            <button type="button" onClick={() => setStep('join')} className="w-full">
              <Card className="hover:border-primary-500 hover:shadow-md transition-all cursor-pointer">
                <div className="flex items-start gap-4">
                  <div className="flex-shrink-0 rounded-lg bg-accent-100 p-3">
                    <UserGroupIcon className="h-6 w-6 text-accent-700" aria-hidden="true" />
                  </div>
                  <div className="text-left">
                    <h3 className="text-base font-semibold text-ink">Join an existing household</h3>
                    <p className="mt-1 text-sm text-gray-500">
                      Use an invite link from a family member
                    </p>
                  </div>
                </div>
              </Card>
            </button>
          </div>
        )}

        {step === 'create' && (
          <Card>
            {error && (
              <Alert variant="error" className="mb-6">
                {error}
              </Alert>
            )}

            {!isAddingAnother && (
              <p className="mb-6 text-sm text-gray-600">
                Flying solo? Name it after yourself or your home — it's just for you, and you can
                invite people whenever you're ready.
              </p>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
              <Input
                label="Household name"
                placeholder="e.g., The Smith Family"
                required
                error={errors.name?.message}
                {...register('name')}
              />

              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setStep('choice')}
                >
                  Back
                </Button>
                <Button type="submit" className="flex-1" isLoading={createMutation.isPending}>
                  Create household
                </Button>
              </div>
            </form>
          </Card>
        )}

        {step === 'join' && (
          <Card>
            <div className="text-center space-y-4">
              <p className="text-gray-600">
                To join an existing household, you'll need an invite link from a household admin.
              </p>
              <p className="text-sm text-gray-500">
                Ask a family member who has already set up a household to send you an invite link.
              </p>
              <Button variant="secondary" onClick={() => setStep('choice')}>
                Back
              </Button>
            </div>
          </Card>
        )}
        {!isAddingAnother && (
          <p className="mt-6 text-center text-sm text-gray-600">
            {t('mobile.accountPrompt')}{' '}
            <Link
              to="/account"
              className="font-medium text-primary-700 underline underline-offset-2"
            >
              {t('mobile.openAccount')}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
