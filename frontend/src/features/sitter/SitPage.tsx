import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BrandMark } from '@/components/BrandMark';
import { Footer } from '@/components/Footer';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useMetaTags } from '@/hooks/useMetaTags';
import { sitterService, SitterLinkInactiveError, type SitterTask } from '@/services/sitterService';

/**
 * Public, no-account plant-sitting page. A household member shares a
 * time-boxed link before they travel; the sitter opens /sit/{token}, sees the
 * household's due tasks ("Water the Monstera"), and taps Done — without ever
 * creating an account or joining the household.
 *
 * Auth-free by design: it talks to the public GET /sitter/{token} +
 * POST /sitter/{token}/tasks/{taskId}/complete endpoints via the bare-fetch
 * sitterService (no axios interceptors), exactly like the pet-safe page. The
 * endpoints expose no PII — just the plant common name, task type, and due
 * date. An expired/revoked link shows a friendly message, not a raw error.
 */

/** Turn a task type + plant name into a warm, plain instruction. */
function instructionFor(task: SitterTask): string {
  const plant = task.plantName || 'this plant';
  switch (task.taskType) {
    case 'water':
      return `Water the ${plant}`;
    case 'fertilize':
      return `Feed the ${plant}`;
    case 'prune':
      return `Prune the ${plant}`;
    case 'repot':
      return `Repot the ${plant}`;
    default:
      // Custom task types come through as free text — show them as-is.
      return `${task.taskType} — ${plant}`;
  }
}

function dueLabel(task: SitterTask, now: number): string {
  const due = new Date(task.dueDate).getTime();
  if (task.overdue) return 'Overdue';
  const days = Math.round((due - now) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}

export function SitPage() {
  const { token = '' } = useParams<{ token: string }>();

  useMetaTags({
    title: 'Plant-sitting — Family Greenhouse',
    description: 'See which plants need care and check them off. No sign-up needed.',
  });

  const [label, setLabel] = useState<string | null>(null);
  const [tasks, setTasks] = useState<SitterTask[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'inactive' | 'error'>('loading');
  // taskIds currently being completed (optimistic in-flight), and ones done.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    sitterService
      .getView(token, controller.signal)
      .then((view) => {
        setLabel(view.label);
        setTasks(view.tasks);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus(err instanceof SitterLinkInactiveError ? 'inactive' : 'error');
      });
    return () => controller.abort();
  }, [token]);

  const handleComplete = useCallback(
    async (taskId: string) => {
      // Optimistic: mark pending immediately; revert on failure.
      setPending((p) => new Set(p).add(taskId));
      try {
        await sitterService.completeTask(token, taskId);
        setDone((d) => new Set(d).add(taskId));
      } catch (err) {
        if (err instanceof SitterLinkInactiveError) {
          // The window closed while the page was open — fall back to the
          // friendly inactive screen rather than leaving a stuck button.
          setStatus('inactive');
          return;
        }
        // Otherwise leave the task actionable so the sitter can retry.
      } finally {
        setPending((p) => {
          const next = new Set(p);
          next.delete(taskId);
          return next;
        });
      }
    },
    [token]
  );

  const now = Date.now();
  const remaining = tasks.filter((t) => !done.has(t.taskId));
  const allDone = status === 'ready' && remaining.length === 0;

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-gray-200">
        <nav className="mx-auto max-w-2xl flex items-center justify-between p-6">
          <Link to="/" aria-label="Family Greenhouse home">
            <BrandMark variant="wordmark" size="sm" />
          </Link>
        </nav>
      </header>

      <main className="flex-1 mx-auto max-w-2xl w-full px-6 py-12">
        {status === 'loading' && (
          <div className="flex min-h-[40vh] items-center justify-center" role="status">
            <LoadingSpinner size="lg" />
            <span className="sr-only">Loading plant-sitting tasks…</span>
          </div>
        )}

        {status === 'inactive' && (
          <div className="mt-8">
            <Alert variant="info" title="This plant-sitting link is no longer active">
              The link may have expired or been turned off by the person who shared it. If you’re
              still helping out, ask them for a fresh link.
            </Alert>
          </div>
        )}

        {status === 'error' && (
          <div className="mt-8">
            <Alert variant="error" title="Something went wrong">
              We couldn’t load the plant-sitting list just now. Please refresh and try again in a
              moment.
            </Alert>
          </div>
        )}

        {status === 'ready' && (
          <>
            <h1 className="font-serif text-3xl font-semibold tracking-tight text-gray-900 sm:text-4xl">
              {label ? `${label}: what needs doing` : 'Thanks for plant-sitting!'}
            </h1>
            <p className="mt-3 text-base text-gray-600">
              Here’s what needs a little care while they’re away. Tap <strong>Done</strong> once
              you’ve looked after each one — no account needed.
            </p>

            {/* Live region announces completions to screen readers. */}
            <div className="mt-10 space-y-3" aria-live="polite">
              {allDone ? (
                <Alert variant="success" title="All caught up — you’re a star 🌿">
                  Every plant has been looked after. Thank you so much for helping out!
                </Alert>
              ) : (
                <ul className="space-y-3">
                  {remaining.map((task) => {
                    const isPending = pending.has(task.taskId);
                    return (
                      <li
                        key={task.taskId}
                        className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900">{instructionFor(task)}</p>
                          <p
                            className={
                              'mt-0.5 text-sm ' +
                              (task.overdue ? 'text-amber-700' : 'text-gray-500')
                            }
                          >
                            {dueLabel(task, now)}
                          </p>
                        </div>
                        <Button
                          variant="primary"
                          size="sm"
                          isLoading={isPending}
                          onClick={() => handleComplete(task.taskId)}
                          aria-label={`Mark "${instructionFor(task)}" as done`}
                        >
                          Done
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <p className="mt-10 text-sm text-gray-500">
              Looking after plants regularly?{' '}
              <Link to="/" className="text-primary-700 underline hover:text-primary-800">
                Family Greenhouse
              </Link>{' '}
              keeps a whole household’s plant care in one shared place.
            </p>
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
