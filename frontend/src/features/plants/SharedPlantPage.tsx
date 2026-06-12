import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { toast } from '@/store/toastStore';

/**
 * PUBLIC landing page for a shared cutting link (/shared/:code).
 *
 * Works logged-out: the preview endpoint requires no auth (mirroring invite
 * previews), so a recipient sees the plant card before having an account.
 *   - logged out         → card + sign in / create account CTAs
 *   - logged in, no household → card + onboarding CTA
 *   - logged in + household   → card + "Add to my greenhouse"
 */
export function SharedPlantPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('plants.shared.title'));
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const householdId = useActiveHouseholdId();
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const {
    data: preview,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['sharedPlant', code],
    queryFn: () => plantService.getSharedPlant(code!),
    enabled: !!code,
    retry: false, // 404 (expired/unknown) shouldn't be retried
  });

  const acceptMutation = useMutation({
    mutationFn: () => plantService.acceptSharedPlant(code!),
    onSuccess: (plant) => {
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      toast.success(t('plants.shared.added', { name: plant.name }));
      navigate(`/plants/${plant.id}`);
    },
    onError: (err) => setAcceptError(getErrorMessage(err)),
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col justify-center bg-gray-50 py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <h1 className="text-center text-3xl font-bold text-primary-700">Family Greenhouse</h1>
        <h2 className="mt-6 text-center text-2xl font-semibold text-gray-900">
          🌱 {t('plants.shared.title')}
        </h2>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <Card>
          {error || !preview ? (
            <div className="space-y-4 text-center">
              <Alert variant="error">{t('plants.shared.invalid')}</Alert>
              <p className="text-sm text-gray-500">{t('plants.shared.askForNew')}</p>
              <Link to={isAuthenticated ? '/plants' : '/'}>
                <Button variant="secondary">
                  {isAuthenticated ? t('plants.backToPlants') : 'Family Greenhouse'}
                </Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-5">
              <p className="text-center text-sm text-gray-500">
                {t('plants.shared.fromHousehold', { name: preview.householdName })}
              </p>

              {/* The shared plant card (frozen snapshot) */}
              <div className="flex items-start gap-4">
                <div className="h-24 w-24 flex-shrink-0 overflow-hidden rounded-lg bg-gray-100">
                  {preview.plant.imageUrl ? (
                    <img
                      src={preview.plant.imageUrl}
                      alt={preview.plant.name}
                      width={96}
                      height={96}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div
                      className="flex h-full w-full items-center justify-center text-3xl"
                      aria-hidden="true"
                    >
                      🪴
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-lg font-semibold text-gray-900">{preview.plant.name}</p>
                  {preview.plant.species && (
                    <p className="text-sm italic text-gray-500">{preview.plant.species}</p>
                  )}
                  {preview.plant.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {preview.plant.tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-800"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {preview.plant.notes && (
                <div>
                  <p className="text-sm font-medium text-gray-500">
                    {t('plants.shared.notesLabel')}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">
                    {preview.plant.notes}
                  </p>
                </div>
              )}

              {acceptError && <Alert variant="error">{acceptError}</Alert>}

              {!isAuthenticated ? (
                <div className="space-y-3 text-center">
                  <p className="text-sm text-gray-500">{t('plants.shared.signInPrompt')}</p>
                  <div className="flex justify-center gap-3">
                    <Link to={`/login?redirect=/shared/${code}`}>
                      <Button>{t('plants.shared.signIn')}</Button>
                    </Link>
                    <Link to={`/register?redirect=/shared/${code}`}>
                      <Button variant="secondary">{t('plants.shared.createAccount')}</Button>
                    </Link>
                  </div>
                </div>
              ) : !householdId ? (
                <div className="space-y-3 text-center">
                  <p className="text-sm text-gray-500">{t('plants.shared.needHousehold')}</p>
                  <Link to="/onboarding">
                    <Button>{t('plants.shared.goToOnboarding')}</Button>
                  </Link>
                </div>
              ) : (
                <div className="flex justify-center">
                  <Button
                    onClick={() => {
                      setAcceptError(null);
                      acceptMutation.mutate();
                    }}
                    isLoading={acceptMutation.isPending}
                  >
                    {t('plants.shared.addToGreenhouse')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
