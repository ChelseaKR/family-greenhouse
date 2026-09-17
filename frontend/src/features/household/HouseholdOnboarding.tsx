import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
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
import {
  getPendingReferralCode,
  clearPendingReferralCode,
} from '@/features/referrals/pendingReferralCode';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

type OnboardingStep = 'choice' | 'create' | 'join';

/**
 * `.trim()` before `.min(1)`, not after — and this is not a tidy-up.
 * Without it a name of three spaces passed validation, POST /households
 * accepted it (the backend schema is `min(1)` too), and the household was
 * created with a blank name: the switcher above the sidebar then rendered an
 * empty line on every screen, with nothing on this page to explain it.
 * Measured against the local server on 2026-09-13.
 */
const makeCreateHouseholdSchema = (t: TFunction) =>
  z.object({
    name: z.string().trim().min(1, t('household.onboarding.nameRequired')).max(100),
  });

type CreateHouseholdFormData = z.infer<ReturnType<typeof makeCreateHouseholdSchema>>;

export function HouseholdOnboarding() {
  const { t } = useTranslation();
  useDocumentTitle(t('household.onboarding.chooseTitle'));
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
  const [pastedInvite, setPastedInvite] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);

  // Choosing "Create" or "Join" unmounts the button that was pressed, so
  // keyboard focus fell to <body> and a screen reader was told nothing at all
  // about the screen having changed. Move focus to the new step's heading —
  // the same thing WelcomeFlow does between ITS steps.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isFirstStep = useRef(true);
  useEffect(() => {
    if (isFirstStep.current) {
      isFirstStep.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const createHouseholdSchema = useMemo(() => makeCreateHouseholdSchema(t), [t]);
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
        // Refresh BEFORE `setHousehold`, not after. The `custom:household_id`
        // claim is written (and awaited) by POST /households before it answers
        // 201, so a refresh here is guaranteed to pick it up — but our current
        // token still predates it.
        //
        // Ordering is the whole fix. `setHousehold` sets `user.householdId`,
        // which flips `hasHousehold` in App.tsx, and `OnboardingGate` renders
        // `<Navigate to="/welcome" replace />` on that very render. WelcomeFlow
        // then mounts and fires its plants query IMMEDIATELY — synchronously,
        // before an `await` placed after `setHousehold` could ever resolve. So
        // refreshing afterwards, as this did, could not prevent the 403 it was
        // written to prevent: the request was already in flight.
        //
        // Measured against deployed staging: refreshing after the store flip
        // produced a 403 on `GET /plants` every run. The pre-#394 path, which
        // fanned out the whole dashboard instead of the one welcome query,
        // produced EIGHT. They self-heal via the interceptor, but a failed
        // plants read is not nothing — `decideFirstRun` treats `plantsFailed`
        // as "step aside to /dashboard", so a brand-new household could be
        // skipped past first-run activation entirely by a transient 403.
        //
        // Still best-effort: if the refresh fails we fall through and set the
        // household anyway, and the 401 interceptor recovers as before. The
        // ordering only removes the guaranteed race, it does not add a new
        // way to fail.
        const { refreshToken, setTokens } = useAuthStore.getState();
        if (refreshToken) {
          try {
            const tokens = await authService.refreshToken(refreshToken);
            setTokens(tokens.idToken, tokens.accessToken, tokens.refreshToken);
          } catch {
            // fall through — the 401-refresh interceptor will catch up.
          }
        }
        setHousehold(household.id, 'admin');
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
    // Refer-a-friend (ADR 0029): only a genuinely NEW account can be a
    // referred signup — `isAddingAnother` means this account already has a
    // household and is opening a second one, which is not what the code was
    // shared for. Cleared either way so a stale code from an earlier visit
    // never resurfaces on a LATER, unrelated household creation.
    const referralCode = isAddingAnother ? null : getPendingReferralCode();
    clearPendingReferralCode();
    createMutation.mutate({
      ...data,
      name: data.name.trim(),
      ...(referralCode ? { referralCode } : {}),
    });
  };

  /**
   * Pull the invite code out of whatever the user pasted: a full link, a
   * path, or the bare code. The route (`/join/:inviteCode`) and
   * JoinHouseholdPage do the validating — this only has to decide which
   * characters are the code.
   */
  function inviteCodeFrom(pasted: string): string | null {
    const trimmed = pasted.trim();
    if (!trimmed) return null;
    const last = trimmed.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() ?? '';
    return /^[A-Za-z0-9_-]{6,64}$/.test(last) ? last : null;
  }

  function openInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = inviteCodeFrom(pastedInvite);
    if (!code) {
      setJoinError(t('household.onboarding.joinInvalid'));
      return;
    }
    setJoinError(null);
    navigate(`/join/${code}`);
  }

  return (
    <div className="greenhouse-grid min-h-screen flex flex-col justify-center bg-paper py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md flex flex-col items-center">
        <BrandMark variant="wordmark" />
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="mt-8 text-center font-serif text-3xl tracking-tight text-ink focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        >
          {step === 'choice' &&
            t(
              isAddingAnother
                ? 'household.onboarding.chooseTitleAnother'
                : 'household.onboarding.chooseTitle'
            )}
          {step === 'create' &&
            t(
              isAddingAnother
                ? 'household.onboarding.createTitleAnother'
                : 'household.onboarding.createTitle'
            )}
          {step === 'join' && t('household.onboarding.joinTitle')}
        </h2>
        {step === 'choice' && !isAddingAnother && (
          <p className="mt-2 max-w-sm text-center text-sm text-gray-600">
            {t('household.onboarding.chooseLede')}
          </p>
        )}
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        {step === 'choice' && (
          <div className="space-y-4">
            <button type="button" onClick={() => setStep('create')} className="w-full">
              <Card className="hover:border-primary-500 hover:shadow-md transition-all cursor-pointer">
                <div className="flex items-start gap-4">
                  <div className="shrink-0 rounded-lg bg-primary-100 p-3">
                    <HomeIcon className="h-6 w-6 text-primary-700" aria-hidden="true" />
                  </div>
                  <div className="text-left">
                    <h3 className="text-base font-semibold text-ink">
                      {t('household.onboarding.createCardTitle')}
                    </h3>
                    <p className="mt-1 text-sm text-gray-500">
                      {t('household.onboarding.createCardBody')}
                    </p>
                  </div>
                </div>
              </Card>
            </button>

            <button type="button" onClick={() => setStep('join')} className="w-full">
              <Card className="hover:border-primary-500 hover:shadow-md transition-all cursor-pointer">
                <div className="flex items-start gap-4">
                  <div className="shrink-0 rounded-lg bg-accent-100 p-3">
                    <UserGroupIcon className="h-6 w-6 text-accent-700" aria-hidden="true" />
                  </div>
                  <div className="text-left">
                    <h3 className="text-base font-semibold text-ink">
                      {t('household.onboarding.joinCardTitle')}
                    </h3>
                    <p className="mt-1 text-sm text-gray-500">
                      {t('household.onboarding.joinCardBody')}
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
              <p className="mb-6 text-sm text-gray-600">{t('household.onboarding.createLede')}</p>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
              <Input
                label={t('household.onboarding.nameLabel')}
                placeholder={t('household.onboarding.namePlaceholder')}
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
                  {t('household.onboarding.back')}
                </Button>
                <Button type="submit" className="flex-1" isLoading={createMutation.isPending}>
                  {t('household.onboarding.createSubmit')}
                </Button>
              </div>
            </form>
          </Card>
        )}

        {/* This step used to be a dead end: the screen before it says "paste
            their link", and this one said "you'll need an invite link" with
            nothing to paste it into and only a Back button. Somebody who
            registered first and opened the app rather than the email had no
            way forward from here at all. */}
        {step === 'join' && (
          <Card>
            <form onSubmit={openInvite} className="space-y-4" noValidate>
              <p className="text-sm text-gray-600">{t('household.onboarding.joinLede')}</p>
              <Input
                label={t('household.onboarding.joinLinkLabel')}
                placeholder={t('household.onboarding.joinLinkPlaceholder')}
                autoComplete="off"
                value={pastedInvite}
                onChange={(event) => {
                  setPastedInvite(event.target.value);
                  if (joinError) setJoinError(null);
                }}
                error={joinError ?? undefined}
              />
              <p className="text-sm text-gray-500">{t('household.onboarding.joinNoLink')}</p>
              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setStep('choice')}
                >
                  {t('household.onboarding.back')}
                </Button>
                <Button type="submit" className="flex-1">
                  {t('household.onboarding.joinSubmit')}
                </Button>
              </div>
            </form>
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
