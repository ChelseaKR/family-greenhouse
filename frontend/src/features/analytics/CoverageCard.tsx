import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import axios from 'axios';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { buttonStyles } from '@/components/buttonStyles';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { useAuthStore } from '@/store/authStore';
import {
  householdService,
  type AwayRisk,
  type CoverageMember,
  type CoveragePlant,
  type CoverageReport,
} from '@/services/householdService';
import { taskService, type TaskWithCoverage } from '@/services/taskService';
import { billingService } from '@/services/billingService';
import { formatDate } from '@/i18n/format';
import { getErrorMessage } from '@/services/api';
import { toast } from '@/store/toastStore';
import { COMMERCIAL_HOLD_ACTIVE } from '@/config/commercialStatus';

/**
 * Coverage — the household's bus-factor view. DESIGN RULE (the backend states
 * the same rule at the top of services/coverageMath.ts):
 *
 *   This is a fragility view, NOT a leaderboard. It never shows a per-member
 *   total, never ranks members, and never sorts anything by contribution. The
 *   lists arrive from the API in name order and date order and are rendered
 *   in that order. A person appears here only as "the one who knows this
 *   plant" or "the one who will be away".
 *
 * The copy is the product: a plant resting on one person is a risk the
 * household fixes together, so the two calls to action are "assign a backup"
 * (the existing task assignment — the next task on the plant goes to someone
 * else, and once they log it the plant has a second pair of hands) and "teach
 * someone this plant" (the plant page, where its notes and history live).
 * Neither is "do more".
 *
 * Three settled states are distinguished on purpose: a failed read says so
 * (never "0 plants at risk"), a household of one gets an honest "coverage
 * needs a second member" rather than a red list of every plant it owns, and a
 * plan without the toolkit gets the locked state instead of an empty card.
 *
 * ENTITLEMENT IS READ BEFORE THE REQUEST, not inferred from its failure — the
 * same shape AwayRecapPage uses (PR #506) and the same three-state plan read
 * as AutoHandoffCard. The endpoint is Garden-and-up and answers 402 to
 * everyone else. Handling that 402 correctly (below) is not enough: the
 * browser writes "Failed to load resource: 402 (Payment Required)" to the
 * console for any non-2xx response, before a line of our code runs. No amount
 * of error HANDLING removes it — only not making the request does.
 *
 * `undefined` stays distinct from `false` throughout. A failed catalog read,
 * or an older backend whose plan summary carries no feature map, means we
 * could not determine entitlement. That is not "your plan has no toolkit",
 * which is a claim, and it is certainly not an empty coverage report (ADR
 * 0010) — so it says so in words instead.
 *
 * The 402 branch stays as defence in depth: if the plan read ever says
 * entitled and the server disagrees, that must still land on the locked state.
 */

function isPaymentRequired(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 402;
}

/**
 * A 402 is an answer ("this plan has no toolkit"), not a failed read, so it
 * settles as data instead of an error: no retries, and the locked state can
 * never be confused with the unavailable one.
 */
type CoverageState = { kind: 'locked' } | { kind: 'report'; report: CoverageReport };

async function readCoverage(householdId: string): Promise<CoverageState> {
  try {
    return { kind: 'report', report: await householdService.getCoverage(householdId) };
  } catch (err) {
    if (isPaymentRequired(err)) return { kind: 'locked' };
    throw err;
  }
}

/** Short day-month for a window; the year adds nothing inside a season. */
function shortDate(iso: string): string {
  return formatDate(iso, { year: undefined });
}

export function CoverageCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { householdId, householdQuery } = useActiveHousehold();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const plansQuery = useQuery({ queryKey: ['plans'], queryFn: billingService.listPlans });
  const subscriptionQuery = useQuery({
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: householdId != null,
    staleTime: 60_000,
  });

  const checkingPlan = plansQuery.isPending || subscriptionQuery.isPending;
  const plan =
    plansQuery.data && subscriptionQuery.data
      ? plansQuery.data.plans.find((p) => p.id === subscriptionQuery.data.planId)
      : undefined;
  // `features` is the catalog map; the bare `householdToolkit` is the legacy
  // name an older backend publishes. Neither present means UNKNOWN, not false.
  const hasToolkit: boolean | undefined =
    plan?.features?.householdToolkit ?? plan?.householdToolkit;

  const {
    data: state,
    isLoading,
    isError,
    error,
  } = useQuery(
    householdQuery(
      (hh) => ['household', hh, 'analytics', 'coverage'],
      (hh) => readCoverage(hh),
      // AND-ed with the hook's own household gate. Only a POSITIVE
      // entitlement makes the request; unknown does not guess and does not ask.
      { enabled: hasToolkit === true }
    )
  );
  const report = state?.kind === 'report' ? state.report : undefined;

  // Same key the analytics page already uses, so react-query serves one read.
  const { data: tasks } = useQuery(
    householdQuery(
      (hh) => ['tasks', hh, 'all'],
      () => taskService.getTasks()
    )
  );

  /** Soonest-due active task per plant — the one a backup would take next. */
  const nextTaskByPlant = useMemo(() => {
    const map = new Map<string, TaskWithCoverage>();
    for (const task of tasks ?? []) {
      const current = map.get(task.plantId);
      if (!current || task.nextDue < current.nextDue) map.set(task.plantId, task);
    }
    return map;
  }, [tasks]);

  const [backupFor, setBackupFor] = useState<string | null>(null);

  const assignMutation = useMutation({
    mutationFn: (vars: { taskId: string; assignedTo: string }) =>
      taskService.updateTask(vars.taskId, { assignedTo: vars.assignedTo }),
    onSuccess: (_task, vars) => {
      const plant = report?.soleCaregiverPlants.find(
        (p) => nextTaskByPlant.get(p.plantId)?.id === vars.taskId
      );
      const task = nextTaskByPlant.get(plant?.plantId ?? '');
      const backup = report?.members.find((m) => m.userId === vars.assignedTo);
      toast.success(
        t('analytics.coverage.backupAssigned', {
          task: task ? taskLabel(task) : '',
          plant: plant?.plantName ?? '',
          name: backup?.name ?? '',
        })
      );
      setBackupFor(null);
      if (householdId) {
        queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
        queryClient.invalidateQueries({
          queryKey: ['household', householdId, 'analytics', 'coverage'],
        });
      }
    },
    onError: (err) => {
      toast.error(`${t('analytics.coverage.backupFailed')} ${getErrorMessage(err)}`);
    },
  });

  const taskLabel = (task: TaskWithCoverage): string =>
    task.type === 'custom' && task.customType
      ? task.customType
      : t(`tasks.types.${task.type}`, { defaultValue: task.type });

  const soleCaregiverLine = (member: CoverageMember): string =>
    member.userId === currentUserId
      ? t('analytics.coverage.soleCaregiverYou')
      : t('analytics.coverage.soleCaregiver', { name: member.name });

  const riskSentence = (risk: AwayRisk): string => {
    const dates = {
      name: risk.name,
      start: shortDate(risk.startDate),
      end: shortDate(risk.endDate),
    };
    if (risk.uncoveredPlantCount === 0) {
      return risk.active
        ? t('analytics.coverage.awayClearActive', dates)
        : t('analytics.coverage.awayClear', dates);
    }
    return risk.active
      ? t('analytics.coverage.awayRiskActive', { ...dates, count: risk.uncoveredPlantCount })
      : t('analytics.coverage.awayRisk', { ...dates, count: risk.uncoveredPlantCount });
  };

  return (
    <Card padding="none">
      <div className="border-b border-primary-100/70 px-6 py-4">
        <CardHeader
          title={t('analytics.coverage.title')}
          description={t('analytics.coverage.description')}
        />
      </div>

      <div className="px-6 py-5">
        {checkingPlan || (hasToolkit === true && isLoading) ? (
          <div className="flex items-center gap-3 text-sm text-gray-600" role="status">
            <LoadingSpinner size="sm" />
            {t('analytics.coverage.loading')}
          </div>
        ) : hasToolkit === undefined ? (
          // We could not read the plan. That is not "you don't have the
          // toolkit", and it is certainly not "every plant is covered".
          <Alert variant="warning">{t('analytics.coverage.planUnknown')}</Alert>
        ) : hasToolkit === false || state?.kind === 'locked' ? (
          <div>
            <h3 className="font-serif text-base text-ink">{t('analytics.coverage.lockedTitle')}</h3>
            <p className="mt-1 text-sm text-gray-600">
              {t('analytics.coverage.lockedDescription')}
            </p>
            <Alert variant="info" className="mt-3">
              {COMMERCIAL_HOLD_ACTIVE
                ? t('analytics.coverage.lockedPaused')
                : t('analytics.coverage.lockedUpgrade')}
            </Alert>
            <Link
              to="/settings/billing"
              className={buttonStyles({ variant: 'secondary', size: 'sm', className: 'mt-3' })}
            >
              {t('analytics.coverage.viewPlanStatus')}
            </Link>
          </div>
        ) : isError || !report ? (
          // A failed read is not "everything is covered". Absence of a
          // warning here would read as reassurance nobody computed.
          <Alert variant="warning">
            {t('analytics.coverage.loadFailed')}
            {error ? ` ${getErrorMessage(error)}` : ''}
          </Alert>
        ) : report.memberCount < 2 ? (
          // A household of one: every plant rests on them by construction.
          // Listing them all in red would be true and useless.
          <div>
            <p className="text-sm font-medium text-ink">
              {t('analytics.coverage.needsSecondMember')}
            </p>
            <p className="mt-1 text-sm text-gray-600">
              {t('analytics.coverage.needsSecondMemberBody')}
            </p>
            <Link
              to="/household"
              className={buttonStyles({ variant: 'secondary', size: 'sm', className: 'mt-3' })}
            >
              {t('analytics.coverage.inviteAction')}
            </Link>
          </div>
        ) : (
          <div className="space-y-5">
            <p className="text-sm text-ink">
              {report.soleCaregiverPlants.length === 0
                ? t('analytics.coverage.allCovered')
                : t('analytics.coverage.summary', {
                    count: report.soleCaregiverPlants.length,
                    total: report.plantCount,
                  })}
            </p>

            {report.uncaredPlantCount > 0 && (
              <p className="text-xs text-gray-600">
                {t('analytics.coverage.uncared', { count: report.uncaredPlantCount })}
              </p>
            )}

            {report.awayRisks.length > 0 && (
              <section aria-labelledby="coverage-away-heading">
                <h3
                  id="coverage-away-heading"
                  className="text-xs uppercase tracking-[0.14em] text-gray-600"
                >
                  {t('analytics.coverage.awayHeading')}
                </h3>
                <ul className="mt-2 space-y-3">
                  {report.awayRisks.map((risk) => {
                    const cover = risk.coveredByName ?? t('analytics.coverage.coverFallback');
                    return (
                      <li
                        key={`${risk.userId}-${risk.startDate}`}
                        className="border-l-2 border-primary-500 pl-4"
                      >
                        <p className="text-sm font-medium text-ink">{riskSentence(risk)}</p>
                        {risk.uncoveredPlantCount > 0 && (
                          <>
                            <p className="mt-0.5 text-sm text-gray-600">
                              {t('analytics.coverage.coverNotYet', { cover })}
                            </p>
                            <details className="mt-2">
                              <summary className="cursor-pointer text-sm font-medium text-primary-700 underline hover:text-primary-800">
                                {t('analytics.coverage.teachCover', { cover })}
                              </summary>
                              <ul className="mt-2 flex flex-wrap gap-2">
                                {risk.uncoveredPlants.map((plant) => (
                                  <li key={plant.plantId}>
                                    <Link
                                      to={`/plants/${plant.plantId}`}
                                      className="inline-flex min-h-touch items-center rounded-full bg-primary-50 px-3 text-sm text-primary-900 ring-1 ring-primary-200 hover:bg-primary-100"
                                    >
                                      {plant.plantName}
                                    </Link>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {report.soleCaregiverPlants.length > 0 && (
              <section aria-labelledby="coverage-plants-heading">
                <h3
                  id="coverage-plants-heading"
                  className="text-xs uppercase tracking-[0.14em] text-gray-600"
                >
                  {t('analytics.coverage.plantsHeading')}
                </h3>
                <ul className="mt-2 divide-y divide-primary-100/60">
                  {report.soleCaregiverPlants.map((plant) => {
                    const sole = plant.soleCaregiver as CoverageMember;
                    const nextTask = nextTaskByPlant.get(plant.plantId);
                    const backups = report.members.filter((m) => m.userId !== sole.userId);
                    return (
                      <li key={plant.plantId} className="py-3">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <Link
                              to={`/plants/${plant.plantId}`}
                              className="font-medium text-gray-900 hover:underline"
                            >
                              {plant.plantName}
                            </Link>
                            <p className="text-sm text-gray-600">{soleCaregiverLine(sole)}</p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Link
                              to={`/plants/${plant.plantId}`}
                              className={buttonStyles({ variant: 'secondary', size: 'sm' })}
                            >
                              {t('analytics.coverage.teachSomeone')}
                            </Link>
                            {nextTask && backups.length > 0 ? (
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                aria-expanded={backupFor === plant.plantId}
                                onClick={() =>
                                  setBackupFor((open) =>
                                    open === plant.plantId ? null : plant.plantId
                                  )
                                }
                              >
                                {t('analytics.coverage.assignBackup')}
                              </Button>
                            ) : (
                              <span className="text-xs text-gray-500">
                                {t('analytics.coverage.noTasks')}
                              </span>
                            )}
                          </div>
                        </div>
                        {backupFor === plant.plantId && nextTask && (
                          <BackupForm
                            plant={plant}
                            task={nextTask}
                            taskLabel={taskLabel(nextTask)}
                            backups={backups}
                            pending={assignMutation.isPending}
                            onCancel={() => setBackupFor(null)}
                            onSubmit={(assignedTo) =>
                              assignMutation.mutate({ taskId: nextTask.id, assignedTo })
                            }
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

interface BackupFormProps {
  plant: CoveragePlant;
  task: TaskWithCoverage;
  taskLabel: string;
  backups: CoverageMember[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (assignedTo: string) => void;
}

/**
 * "Assign a backup" — the existing task assignment, pointed at one plant.
 * The next task on the plant goes to the chosen member; nothing else changes.
 */
function BackupForm({
  plant,
  task,
  taskLabel,
  backups,
  pending,
  onCancel,
  onSubmit,
}: BackupFormProps) {
  const { t } = useTranslation();
  const [assignedTo, setAssignedTo] = useState(backups[0]?.userId ?? '');
  const selectId = `coverage-backup-${plant.plantId}`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (assignedTo) onSubmit(assignedTo);
  };

  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded-lg border border-primary-100 bg-primary-50/60 p-4"
    >
      <label htmlFor={selectId} className="block text-sm font-medium text-primary-900">
        {t('analytics.coverage.backupLabel', { plant: plant.plantName })}
      </label>
      <p className="mt-0.5 text-xs text-primary-900/80">
        {t('analytics.coverage.backupHelp', { task: taskLabel })}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          id={selectId}
          value={assignedTo}
          onChange={(e) => setAssignedTo(e.target.value)}
          className="min-h-touch rounded-lg border border-dew bg-paper px-3 text-sm text-ink"
        >
          {backups.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={pending || !assignedTo} data-task-id={task.id}>
          {t('analytics.coverage.backupConfirm')}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
