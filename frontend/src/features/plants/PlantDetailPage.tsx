import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftIcon,
  PencilIcon,
  TrashIcon,
  PlusIcon,
  CheckIcon,
  ClockIcon,
  ScissorsIcon,
  ShareIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import { plantService, Task, type PlantStatus } from '@/services/plantService';
import { taskService } from '@/services/taskService';
import { useCompleteTaskMutation } from '@/features/tasks/taskMutations';
import { Button } from '@/components/Button';
import { Card, CardHeader } from '@/components/Card';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';
import { computeStreak, streakLabel } from '@/utils/streaks';
import { isOverdue } from '@/utils/date';
import { findCareGuide } from '@/utils/careGuidance';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { AddTaskModal } from './AddTaskModal';
import { EditPlantModal } from './EditPlantModal';
import { EditTaskModal } from './EditTaskModal';
import { PlantImageUpload } from './PlantImageUpload';
import { PhotoTimeline } from './PhotoTimeline';
import { CareGuidanceCard } from './CareGuidanceCard';
import { CareGuideCard } from './CareGuideCard';
import { NoCareDataNotice } from './NoCareDataNotice';
import { CareReportCard } from './CareReportCard';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { RemovePlantDialog } from './RemovePlantDialog';
import { PlantLineageCard, PlantStatusBadge } from './PlantLineageCard';
import { ShareCuttingDialog } from './ShareCuttingDialog';
import { LeafHealthCard } from './LeafHealthCard';
import clsx from 'clsx';
import { TitleUnderline } from '@/components/brand/TitleUnderline';
import { taskTypeLabels, taskTypeStyle } from '@/utils/taskTypeConfig';
import { toast } from '@/store/toastStore';

function formatDate(dateString: string | null): string {
  if (!dateString) return 'Never';
  return new Date(dateString).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function PlantDetailPage() {
  const { t } = useTranslation();
  const { plantId } = useParams<{ plantId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();
  const [showAddTask, setShowAddTask] = useState(false);
  const [showEditPlant, setShowEditPlant] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showRemove, setShowRemove] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showLeafHealth, setShowLeafHealth] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  const {
    data: plant,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['plants', householdId, plantId],
    queryFn: () => plantService.getPlant(plantId!),
    enabled: !!plantId,
  });

  // Title reflects the plant once it's loaded; falls back to a generic
  // "Plant" label during the loading flash.
  useDocumentTitle(plant?.name ?? 'Plant');

  const deleteMutation = useMutation({
    mutationFn: () => plantService.deletePlant(plantId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      toast.success('Plant deleted');
      navigate('/plants');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const statusMutation = useMutation({
    mutationFn: (status: PlantStatus) => plantService.setPlantStatus(plantId!, status),
    onSuccess: (_data, status) => {
      // ['plants', householdId] is a prefix of the detail key, so this
      // invalidates both the list and this plant's detail/photos queries.
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      setShowRemove(false);
      if (status === 'active') {
        toast.success('Plant restored');
      } else {
        // It's left the active list — back to the (active) plants view.
        const message = {
          archived: t('plants.archive.archivedToast'),
          died: t('plants.archive.diedToast'),
          gave_away: t('plants.archive.gaveAwayToast'),
        }[status];
        toast.success(message);
        navigate('/plants');
      }
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const completeTaskMutation = useCompleteTaskMutation(householdId);

  const snoozeTaskMutation = useMutation({
    mutationFn: ({ taskId, days }: { taskId: string; days: number }) =>
      taskService.snoozeTask(taskId, days),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plants', householdId, plantId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
      toast.info('Task snoozed');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !plant) {
    return (
      <div className="space-y-6">
        <Link
          to="/plants"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-800"
        >
          <ArrowLeftIcon className="h-4 w-4 mr-1" aria-hidden="true" />
          Back to plants
        </Link>
        <Alert variant="error">{error ? getErrorMessage(error) : 'Plant not found'}</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        to="/plants"
        className="inline-flex items-center text-sm text-gray-600 hover:text-gray-800"
      >
        <ArrowLeftIcon className="h-4 w-4 mr-1" aria-hidden="true" />
        Back to plants
      </Link>

      {/* Plant header */}
      <div className="flex flex-col sm:flex-row gap-6">
        <div className="w-full sm:w-48 flex-shrink-0 space-y-3">
          <div className="h-48 rounded-lg bg-parchment overflow-hidden">
            {plant.imageUrl ? (
              <img
                src={plant.imageUrl}
                alt={`Photo of ${plant.name}`}
                width={192}
                height={192}
                loading="lazy"
                decoding="async"
                fetchPriority="high"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <svg
                  className="h-20 w-20 text-primary-300"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1}
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 21c-2-2-5-3-5-8 0-3 2-5 5-5s5 2 5 5c0 5-3 6-5 8z"
                  />
                </svg>
              </div>
            )}
          </div>
          <PlantImageUpload plantId={plant.id} />
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => setShowLeafHealth(true)}
            leftIcon={<SparklesIcon className="h-4 w-4" aria-hidden="true" />}
          >
            {t('plants.leafHealth.action')}
          </Button>
          <PhotoTimeline plantId={plant.id} />
        </div>

        <div className="flex-1">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-serif text-3xl text-ink leading-tight tracking-tight">
                  {plant.name}
                </h1>
                {(plant.status ?? 'active') !== 'active' && (
                  <PlantStatusBadge status={plant.status!} />
                )}
              </div>
              <TitleUnderline className="mt-1 h-3 w-28 text-primary-600" />
              {plant.species && <p className="text-lg text-gray-500 italic">{plant.species}</p>}
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
              {(plant.status ?? 'active') === 'active' && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() =>
                      // Prefill the add form and link the new plant back here.
                      navigate('/plants/new', {
                        state: {
                          parentPlantId: plant.id,
                          parentName: plant.name,
                          species: plant.species,
                        },
                      })
                    }
                    leftIcon={<ScissorsIcon className="h-4 w-4" aria-hidden="true" />}
                  >
                    {t('plants.propagate.action')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setShowShare(true)}
                    leftIcon={<ShareIcon className="h-4 w-4" aria-hidden="true" />}
                  >
                    {t('plants.share.action')}
                  </Button>
                </>
              )}
              <Button
                variant="secondary"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setShowEditPlant(true)}
                leftIcon={<PencilIcon className="h-4 w-4" aria-hidden="true" />}
              >
                Edit
              </Button>
              {(plant.status ?? 'active') === 'active' ? (
                <Button
                  variant="danger"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => setShowRemove(true)}
                  leftIcon={<TrashIcon className="h-4 w-4" aria-hidden="true" />}
                >
                  Remove
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => statusMutation.mutate('active')}
                  isLoading={statusMutation.isPending}
                >
                  Restore
                </Button>
              )}
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-4">
            {plant.location && (
              <div>
                <dt className="text-sm font-medium text-gray-500">Location</dt>
                <dd className="text-sm text-gray-900">{plant.location}</dd>
              </div>
            )}
            <div>
              <dt className="text-sm font-medium text-gray-500">Added</dt>
              <dd className="text-sm text-gray-900">{formatDate(plant.createdAt)}</dd>
            </div>
            {/* Notes lives inside the <dl> — a <dt>/<dd> pair outside a <dl>
                fails axe's `dlitem` rule. */}
            {plant.notes && (
              <div className="col-span-2">
                <dt className="text-sm font-medium text-gray-500">Notes</dt>
                <dd className="mt-1 text-sm text-gray-900 whitespace-pre-wrap">{plant.notes}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* Curated care guidance — only renders if plant.species matches a known entry */}
      <CareGuidanceCard species={plant.species} />

      {/* When neither the curated guide nor a Perenual match exists, both the
          care guide and suggested schedule are hidden. Say so honestly rather
          than leaving an unexplained blank where care guidance would be. */}
      {!plant.perenualSpeciesId && !findCareGuide(plant.species) && <NoCareDataNotice />}

      {/* Propagation lineage — parent link + cuttings (renders nothing when
          the plant has no lineage at all) */}
      <PlantLineageCard lineage={plant.lineage} />

      {/* Tasks */}
      <Card>
        <CardHeader
          title="Care Tasks"
          description={
            (plant.status ?? 'active') === 'active'
              ? 'Scheduled care tasks for this plant'
              : t('plants.archive.tasksPausedDescription')
          }
          action={
            (plant.status ?? 'active') === 'active' ? (
              <Button
                size="sm"
                onClick={() => setShowAddTask(true)}
                leftIcon={<PlusIcon className="h-4 w-4" aria-hidden="true" />}
              >
                Add task
              </Button>
            ) : undefined
          }
        />

        {plant.upcomingTasks.length === 0 ? (
          <EmptyState
            title="No tasks"
            description="Add care tasks to track watering, fertilizing, and more."
            action={
              (plant.status ?? 'active') === 'active' ? (
                <Button onClick={() => setShowAddTask(true)}>Add first task</Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-primary-100/60 -mx-6 -mb-6">
            {plant.upcomingTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                completions={plant.recentCompletions}
                onComplete={() => completeTaskMutation.mutate(task.id)}
                onSnooze={(days) => snoozeTaskMutation.mutate({ taskId: task.id, days })}
                onEdit={() => setEditingTask(task)}
                isCompleting={
                  completeTaskMutation.isPending && completeTaskMutation.variables === task.id
                }
                isSnoozing={snoozeTaskMutation.isPending}
                isReadOnly={(plant.status ?? 'active') !== 'active'}
              />
            ))}
          </ul>
        )}
      </Card>

      <CareReportCard plant={plant} />

      {plant.perenualSpeciesId && <CareGuideCard perenualSpeciesId={plant.perenualSpeciesId} />}

      {/* Care history */}
      <Card>
        <CardHeader title="Care History" description="Recent task completions" />

        {plant.recentCompletions.length === 0 ? (
          <p className="text-sm text-gray-500">No care history yet.</p>
        ) : (
          <ul className="space-y-3">
            {plant.recentCompletions.map((completion) => (
              <li key={completion.id} className="flex items-center gap-3 text-sm">
                <span className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-primary-100">
                  <CheckIcon className="h-4 w-4 text-primary-700" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-gray-900">
                    <span className="font-medium">{completion.completedByName}</span> completed{' '}
                    <span className="font-medium">{completion.taskType}</span>
                  </p>
                  <p className="text-gray-500">{formatDate(completion.completedAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Modals */}
      <AddTaskModal plantId={plantId!} isOpen={showAddTask} onClose={() => setShowAddTask(false)} />

      <ShareCuttingDialog
        plantId={plant.id}
        isOpen={showShare}
        onClose={() => setShowShare(false)}
      />

      <LeafHealthCard
        plantId={plant.id}
        isOpen={showLeafHealth}
        onClose={() => setShowLeafHealth(false)}
      />

      <EditPlantModal
        plant={plant}
        isOpen={showEditPlant}
        onClose={() => setShowEditPlant(false)}
      />

      {editingTask && (
        <EditTaskModal task={editingTask} isOpen={true} onClose={() => setEditingTask(null)} />
      )}

      <RemovePlantDialog
        isOpen={showRemove}
        plantName={plant.name}
        isLoading={statusMutation.isPending || deleteMutation.isPending}
        onClose={() => setShowRemove(false)}
        onArchive={() => statusMutation.mutate('archived')}
        onDied={() => statusMutation.mutate('died')}
        onGaveAway={() => statusMutation.mutate('gave_away')}
        onDelete={() => {
          // Permanent delete gets a second, explicit confirm.
          setShowRemove(false);
          setShowDeleteConfirm(true);
        }}
      />

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => deleteMutation.mutate()}
        title="Delete plant"
        message={`Are you sure you want to delete "${plant.name}"? This permanently removes the plant and all its tasks and history. Use "It died" or "I gave it away" instead if you want to keep the record.`}
        confirmLabel="Delete"
        isLoading={deleteMutation.isPending}
      />
    </div>
  );
}

interface TaskRowProps {
  task: Task;
  completions: import('@/services/plantService').TaskCompletion[];
  onComplete: () => void;
  onSnooze: (days: number) => void;
  onEdit: () => void;
  isCompleting: boolean;
  isSnoozing: boolean;
  isReadOnly: boolean;
}

const SNOOZE_OPTIONS = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: 'Skip cycle', days: 0 }, // resolved at click time using task.frequency
];

function TaskRow({
  task,
  completions,
  onComplete,
  onSnooze,
  onEdit,
  isCompleting,
  isSnoozing,
  isReadOnly,
}: TaskRowProps) {
  const { t } = useTranslation();
  const streak = computeStreak(task, completions);
  const streakText = streakLabel(task, streak);
  const style = taskTypeStyle(task.type);
  const { Icon } = style;

  return (
    <li className="px-4 py-4 hover:bg-parchment/60 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
          <span
            className={clsx(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1',
              style.chip
            )}
          >
            <Icon className={clsx('h-4 w-4', style.iconColor)} aria-hidden="true" />
            {task.customType || taskTypeLabels[task.type]}
          </span>
          <div className="min-w-0">
            <p className="text-sm text-gray-900">Every {task.frequency} days</p>
            {isReadOnly ? (
              <p className="text-xs font-medium text-amber-800">
                {t('plants.archive.tasksPaused')}
              </p>
            ) : (
              <p
                className={clsx(
                  'text-xs',
                  isOverdue(task.nextDue) ? 'text-accent-700 font-medium' : 'text-gray-600'
                )}
              >
                Due: {formatDate(task.nextDue)}
                {task.lastCompleted && ` • Last: ${formatDate(task.lastCompleted)}`}
              </p>
            )}
            {streakText && (
              <p className="text-xs text-primary-700 font-medium mt-0.5">🌱 {streakText}</p>
            )}
          </div>
        </div>
        {!isReadOnly && (
          <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center">
            <SnoozeMenu
              isSnoozing={isSnoozing}
              onPick={(days) => {
                // "Skip cycle" sentinel — bump by one full frequency.
                onSnooze(days === 0 ? task.frequency : days);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              className="w-full sm:w-auto"
              onClick={onEdit}
              leftIcon={<PencilIcon className="h-4 w-4" aria-hidden="true" />}
              aria-label="Edit task"
            >
              Edit
            </Button>
            <Button
              size="sm"
              className="w-full sm:w-auto"
              onClick={onComplete}
              disabled={isCompleting}
              leftIcon={<CheckIcon className="h-4 w-4" aria-hidden="true" />}
            >
              Done
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

interface SnoozeMenuProps {
  isSnoozing: boolean;
  onPick: (days: number) => void;
}

/**
 * Pop-down menu of snooze durations. Native `<details>`/`<summary>` keeps
 * keyboard semantics correct without pulling a heavier popover library, and
 * collapses on outside click via the browser's own `toggle` event handling.
 */
function SnoozeMenu({ isSnoozing, onPick }: SnoozeMenuProps) {
  return (
    <details className="relative min-w-0">
      <summary
        className={clsx(
          'list-none inline-flex w-full items-center justify-center gap-1 px-3 py-2 text-sm font-medium rounded-md min-h-touch min-w-touch cursor-pointer sm:w-auto',
          'bg-paper text-gray-700 border border-primary-200/70 hover:bg-primary-50',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2',
          isSnoozing && 'opacity-50 cursor-wait'
        )}
        aria-label="Snooze task"
      >
        <ClockIcon className="h-4 w-4" aria-hidden="true" />
        Snooze
      </summary>
      <ul className="absolute right-0 z-10 mt-1 w-44 max-w-[calc(100vw-2rem)] rounded-md bg-paper shadow-lg ring-1 ring-primary-100/80 py-1">
        {SNOOZE_OPTIONS.map((opt) => (
          <li key={opt.label}>
            <button
              type="button"
              className="flex min-h-touch w-full items-center px-3 py-2 text-sm text-gray-700 hover:bg-parchment/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
              onClick={(e) => {
                onPick(opt.days);
                // Close the details popover after clicking.
                (e.currentTarget.closest('details') as HTMLDetailsElement).open = false;
              }}
            >
              {opt.label}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
