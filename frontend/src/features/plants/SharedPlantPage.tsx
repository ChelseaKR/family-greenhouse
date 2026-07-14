import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { BrandMark } from '@/components/BrandMark';
import { PlantPlaceholder } from '@/components/PlantImage';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useMetaTags } from '@/hooks/useMetaTags';
import { toast } from '@/store/toastStore';
import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';

/**
 * PUBLIC landing page for a shared cutting link (/shared/:code).
 *
 * This is the share-worthy face of the propagation loop: a logged-out visitor
 * who's been passed a cutting sees a warm, brand-styled card that leads with
 * the plant and its provenance ("a cutting of …, grown by …"), then a clear
 * "grow your own cutting" action for existing account holders. Logged-out
 * visitors can still see provenance and sign in, but public registration is
 * not offered while the commercial hold is active.
 *
 * Works logged-out: the preview endpoint requires no auth (mirroring invite
 * previews), so a recipient sees the plant card before having an account.
 *   - logged out         → card + status notice + existing-account sign-in
 *   - logged in, no household → card + onboarding CTA
 *   - logged in + household   → card + "Add to my greenhouse"
 *
 * PII safety: the public payload only ever exposes the plant snapshot
 * (name/species/notes/imageUrl/tags) and the sharing household's DISPLAY name —
 * no emails, member rosters, household ids, or location. We render exactly that
 * and nothing more.
 *
 * SPA-SEO note: this is a client-rendered SPA, so the per-cutting og:image /
 * og:title set below are only seen by scrapers that execute JS. Crawlers that
 * read raw HTML (most link-unfurlers) fall back to the static branded card and
 * copy baked into index.html — an honest, bounded default rather than a broken
 * preview. Build-time/SSR per-cutting cards are tracked separately.
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

  // Dynamic OG/Twitter tags for clients that execute JS; the static branded
  // card in index.html is the reliable fallback for raw-HTML scrapers.
  useMetaTags(
    preview
      ? {
          title: t('plants.shared.metaTitle', { name: preview.plant.name }),
          description: t('plants.shared.metaDescription', {
            name: preview.plant.name,
            household: preview.householdName,
          }),
          // A public plant photo makes the best card; otherwise the branded
          // default OG image baked into index.html keeps the unfurl on-brand.
          ogImage: preview.plant.imageUrl ?? '/brand/og-image.png',
        }
      : {}
  );

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
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="flex min-h-screen flex-col justify-center bg-paper px-4 py-12">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-8 flex justify-center">
            <BrandMark variant="wordmark" />
          </div>
          <Card variant="paper">
            <div className="space-y-4 text-center">
              <Alert variant="error">{t('plants.shared.invalid')}</Alert>
              <p className="text-sm text-gray-500">{t('plants.shared.askForNew')}</p>
              <Link to={isAuthenticated ? '/plants' : '/'}>
                <Button variant="secondary">
                  {isAuthenticated ? t('plants.backToPlants') : 'Family Greenhouse'}
                </Button>
              </Link>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  const { plant, householdName } = preview;

  return (
    <div className="flex min-h-screen flex-col justify-center bg-paper px-4 py-12">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <BrandMark variant="wordmark" />
        </div>

        <Card variant="paper" padding="none" className="overflow-hidden">
          {/* Hero: the plant leads. A public photo fills the top; otherwise a
              warm botanical placeholder keeps the card share-worthy. */}
          <div className="relative aspect-[4/3] w-full bg-primary-100/60">
            {plant.imageUrl ? (
              <img
                src={plant.imageUrl}
                alt={plant.name}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : (
              <PlantPlaceholder />
            )}
            <span className="absolute left-4 top-4 inline-flex items-center rounded-full bg-paper/90 px-3 py-1 text-xs font-medium uppercase tracking-wide text-primary-800 shadow-sm backdrop-blur">
              {t('plants.shared.eyebrow')}
            </span>
          </div>

          <div className="space-y-5 p-6">
            {/* Provenance lead-in — the lineage story, PII-safe (display name
                only, never an email or household id). */}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-primary-700">
                {t('plants.shared.cuttingOf')}
              </p>
              <h1 className="mt-1 font-serif text-3xl leading-tight text-ink">{plant.name}</h1>
              {plant.species && (
                <p className="mt-0.5 text-sm italic text-gray-600">{plant.species}</p>
              )}
              <p className="mt-2 text-sm text-gray-600">
                {t('plants.shared.provenance', { name: householdName })}
              </p>
            </div>

            {plant.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {plant.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center rounded-full bg-primary-50 px-2.5 py-0.5 text-xs font-medium text-primary-800"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {plant.notes && (
              <div className="rounded-lg border border-primary-100/70 bg-white/60 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-600">
                  {t('plants.shared.notesLabel')}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{plant.notes}</p>
              </div>
            )}

            {acceptError && <Alert variant="error">{acceptError}</Alert>}

            {/* The graft CTA — the loop. */}
            <div className="border-t border-primary-100/70 pt-5">
              <h2 className="font-serif text-lg text-ink">{t('plants.shared.graftHeading')}</h2>
              <p className="mt-1 text-sm text-gray-600">
                {t('plants.shared.graftBody', { name: plant.name })}
              </p>

              {!isAuthenticated ? (
                <div className="mt-4 space-y-3">
                  <CommercialHoldNotice compact />
                  <p className="text-center text-xs text-gray-600">
                    {t('auth.existingAccount')}{' '}
                    <Link
                      to={`/login?redirect=/shared/${code}`}
                      className="font-medium text-primary-700 hover:text-primary-600"
                    >
                      {t('plants.shared.signIn')}
                    </Link>
                  </p>
                </div>
              ) : !householdId ? (
                <div className="mt-4 space-y-2 text-center">
                  <p className="text-sm text-gray-500">{t('plants.shared.needHousehold')}</p>
                  <Link to="/onboarding">
                    <Button className="w-full">{t('plants.shared.goToOnboarding')}</Button>
                  </Link>
                </div>
              ) : (
                <div className="mt-4">
                  <Button
                    className="w-full"
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
          </div>
        </Card>
      </div>
    </div>
  );
}
