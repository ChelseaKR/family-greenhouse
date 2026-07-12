import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { BrandMark } from '@/components/BrandMark';
import { usePrefsStore } from '@/store/prefsStore';
import { useAuthStore } from '@/store/authStore';
import { EmptyPlants } from '@/components/illustrations/EmptyPlants';
import { EmptyMembers } from '@/components/illustrations/EmptyMembers';
import { EmptyActivity } from '@/components/illustrations/EmptyActivity';
import clsx from 'clsx';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

/**
 * 3-step welcome wizard shown immediately after a user joins or creates
 * their first household. Sets `welcomeSeen=true` in prefs so we never
 * shows it twice; users can also skip at any step.
 *
 * The flow is content-only (no API calls). It explains what the app does
 * with one strong visual per step, then drops the user on /plants/new
 * ready to add their first plant.
 */
const STEPS: Array<{
  illustration: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}> = [
  {
    illustration: EmptyPlants,
    title: "You're in",
    body: "Your space is set up. Just you for now? That's perfectly fine — you can invite people any time. Two things worth knowing before you add your first plant.",
  },
  {
    illustration: EmptyMembers,
    title: 'Plant care that fits you',
    body: "Add plants, schedule recurring tasks, and keep everything in one calm place. Looking after your plants solo? It all just works. Sharing with others? Assign tasks — whoever's around does it and marks it done, and everyone sees it. No more 'I thought you watered it' arguments.",
  },
  {
    illustration: EmptyActivity,
    title: 'Reminders that find you',
    body: 'Pick how you want to be reminded (browser, email, or SMS) and we nudge whoever is assigned when something is due. Quiet hours and Do-Not-Disturb are respected. Change it any time in Settings.',
  },
];

export function WelcomeFlow() {
  useDocumentTitle('Welcome');
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const firstName = user?.name?.split(' ')[0] ?? null;
  const welcomeSeen = usePrefsStore((s) => s.welcomeSeen);
  const setWelcomeSeen = usePrefsStore((s) => s.setWelcomeSeen);
  const [step, setStep] = useState(0);

  if (welcomeSeen) return <Navigate to="/dashboard" replace />;

  function finish() {
    setWelcomeSeen(true);
    navigate('/plants/new');
  }

  function skip() {
    setWelcomeSeen(true);
    navigate('/dashboard');
  }

  const current = STEPS[step];
  const Illustration = current.illustration;
  const isLast = step === STEPS.length - 1;
  const isFirst = step === 0;

  return (
    <div
      className="greenhouse-grid min-h-screen flex flex-col items-center justify-center bg-paper p-6"
      role="dialog"
      aria-labelledby="welcome-title"
    >
      <BrandMark variant="wordmark" className="mb-8" />

      <Card variant="glass" className="w-full max-w-lg">
        <div className="text-center">
          <Illustration className="mx-auto h-32 w-auto" />
          <h1 id="welcome-title" className="mt-4 font-serif text-3xl tracking-tight text-ink">
            {isFirst && firstName ? `Welcome, ${firstName}` : current.title}
          </h1>
          {isFirst && firstName && (
            <p className="mt-1 text-sm font-medium text-primary-700">{current.title}</p>
          )}
          <p className="mt-3 text-base leading-relaxed text-gray-600">{current.body}</p>
        </div>

        <div className="mt-8 flex justify-center gap-2" role="presentation">
          {STEPS.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setStep(i)}
              aria-label={`Step ${i + 1} of ${STEPS.length}`}
              aria-current={i === step ? 'step' : undefined}
              className={clsx(
                'h-1.5 w-8 rounded-full transition-colors',
                i === step ? 'bg-primary-700' : 'bg-primary-200 hover:bg-primary-300'
              )}
            />
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <Button variant="secondary" onClick={skip}>
            Skip the tour
          </Button>
          {isLast ? (
            <Button onClick={finish} size="lg">
              Add my first plant →
            </Button>
          ) : (
            <Button onClick={() => setStep((s) => Math.min(s + 1, STEPS.length - 1))}>Next</Button>
          )}
        </div>
      </Card>

      <p className="mt-6 text-center text-xs text-gray-600">
        You can revisit any of this from <span className="font-medium">Help</span> in the sidebar.
      </p>
    </div>
  );
}
