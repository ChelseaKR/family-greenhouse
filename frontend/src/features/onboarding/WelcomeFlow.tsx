import { useEffect, useId, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Card } from '@/components/Card';
import { BrandMark } from '@/components/BrandMark';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { usePrefsStore } from '@/store/prefsStore';
import { useAuthStore } from '@/store/authStore';
import { plantService } from '@/services/plantService';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { decideFirstRun, firstRunStepsFor, type FirstRunStep } from './firstRunModel';
import { FirstPlantStep } from './FirstPlantStep';
import { InviteStep } from './InviteStep';

/**
 * The first run: the path from "account created" to "this app is doing
 * something for me".
 *
 * It replaces a three-screen explanatory tour that (a) nothing in the app
 * ever navigated to, and (b) made no API calls — a new user read three
 * paragraphs and arrived at an empty dashboard having created nothing. Both
 * steps here do real work against the shipped backend: one adds a plant, one
 * mints an invite. A user who completes them lands on a dashboard with a
 * plant, a care schedule, and (if they want) somebody else in the household —
 * which is the product's actual claim.
 *
 * Reachability comes from `HomeRedirect` on `/`, the single place both
 * household creation and invite acceptance land.
 *
 * Nothing here is mandatory. Every step has a real skip, skipping never costs
 * the user anything, and the free tier is never gated behind finishing.
 */
export function WelcomeFlow() {
  const { t } = useTranslation();
  useDocumentTitle(t('firstRun.documentTitle'));
  const navigate = useNavigate();
  const firstName = useAuthStore((state) => state.user?.name?.split(' ')[0] ?? null);
  const welcomeSeen = usePrefsStore((state) => state.welcomeSeen);
  const setWelcomeSeen = usePrefsStore((state) => state.setWelcomeSeen);
  const { householdId, householdQuery } = useActiveHousehold();
  const isAdmin = useIsHouseholdAdmin();
  const headingId = useId();

  const plantsQuery = useQuery(
    householdQuery(
      (hh) => ['plants', hh],
      () => plantService.getPlants()
    )
  );

  // Once the first run has begun it stays begun. Adding the first plant
  // invalidates ['plants', hh] — which is this very query — so a decision
  // recomputed from live data would see one plant, conclude "established
  // household", and eject the user mid-flow, one step before the household
  // idea is ever mentioned.
  const [started, setStarted] = useState(false);

  const decision = started
    ? ({ kind: 'run' } as const)
    : decideFirstRun({
        hasHousehold: householdId != null,
        welcomeSeen,
        plantCount: plantsQuery.isSuccess ? plantsQuery.data.length : null,
        plantsFailed: plantsQuery.isError,
      });

  const shouldMarkSeen = decision.kind === 'leave' && decision.markSeen;
  useEffect(() => {
    if (shouldMarkSeen) setWelcomeSeen(true);
  }, [shouldMarkSeen, setWelcomeSeen]);

  const isRunning = decision.kind === 'run';
  useEffect(() => {
    if (isRunning) setStarted(true);
  }, [isRunning]);

  const steps = firstRunStepsFor(isAdmin);
  const [step, setStep] = useState<FirstRunStep>('plant');
  const stepIndex = Math.max(steps.indexOf(step), 0);

  // Move focus to the new step's heading on a step CHANGE only. Focusing it
  // on mount would yank the caret for someone who just arrived at the top of
  // the page anyway; not focusing it on a change would leave a keyboard or
  // screen-reader user stranded on a button that no longer exists.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isInitialStep = useRef(true);
  useEffect(() => {
    if (isInitialStep.current) {
      isInitialStep.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  function finish() {
    setWelcomeSeen(true);
    navigate('/dashboard');
  }

  function goToFullPlantForm() {
    setWelcomeSeen(true);
    navigate('/plants/new');
  }

  /** After the plant exists: on to the household idea, or straight in. */
  function afterPlant() {
    if (steps.includes('invite')) setStep('invite');
    else finish();
  }

  if (decision.kind === 'loading') {
    return (
      <div className="greenhouse-grid flex min-h-screen items-center justify-center bg-paper p-6">
        <div role="status" className="flex items-center gap-3">
          <LoadingSpinner size="lg" />
          <span className="sr-only">{t('firstRun.loading')}</span>
        </div>
      </div>
    );
  }

  if (decision.kind === 'leave') return <Navigate to={decision.to} replace />;

  // `run` already implies a household (see decideFirstRun), but the compiler
  // can't see through that. Re-checking is cheaper than an assertion that
  // would silently become wrong if the rule ever changed.
  if (householdId == null) return <Navigate to="/onboarding" replace />;

  return (
    <div className="greenhouse-grid flex min-h-screen flex-col items-center justify-center bg-paper p-6">
      <BrandMark variant="wordmark" className="mb-8" />

      <Card variant="glass" className="w-full max-w-lg">
        <div className="mb-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
            {firstName
              ? t('firstRun.greeting', { name: firstName })
              : t('firstRun.greetingFallback')}
          </p>
        </div>

        {step === 'plant' ? (
          <FirstPlantStep
            headingId={headingId}
            headingRef={headingRef}
            householdId={householdId}
            onAdded={afterPlant}
            onSkip={afterPlant}
            onWantsFullForm={goToFullPlantForm}
          />
        ) : (
          <InviteStep
            headingId={headingId}
            headingRef={headingRef}
            householdId={householdId}
            onSkip={finish}
            onFinish={finish}
          />
        )}

        {steps.length > 1 && (
          <div className="mt-8 border-t border-dew/50 pt-5">
            <p className="text-center text-xs font-medium text-gray-600" aria-live="polite">
              {t('firstRun.progress', { current: stepIndex + 1, total: steps.length })}
            </p>
            {/* Presentational only: the steps are driven by the buttons above,
                so making these focusable would add tab stops that do nothing a
                keyboard user can't already do. The live region above carries
                the same information to assistive tech. */}
            <ol className="mt-3 flex justify-center gap-2" aria-hidden="true">
              {steps.map((name, index) => (
                <li
                  key={name}
                  className={clsx(
                    'h-1.5 w-10 rounded-full transition-colors',
                    index <= stepIndex ? 'bg-primary-700' : 'bg-primary-200'
                  )}
                />
              ))}
            </ol>
          </div>
        )}
      </Card>

      <p className="mt-6 max-w-lg text-center text-xs text-gray-600">{t('firstRun.footer')}</p>
    </div>
  );
}
