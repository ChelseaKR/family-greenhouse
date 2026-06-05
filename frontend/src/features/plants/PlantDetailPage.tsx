import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  PencilIcon,
  TrashIcon,
  PlusIcon,
  CheckIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import { plantService, Task } from '@/services/plantService';
import { taskService } from '@/services/taskService';
import { Button } from '@/components/Button';
import { Card, CardHeader } from '@/components/Card';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { EmptyState } from '@/components/EmptyState';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';
import { computeStreak, streakLabel } from '@/utils/streaks';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AddTaskModal } from './AddTaskModal';
import { EditPlantModal } from './EditPlantModal';
import { EditTaskModal } from './EditTaskModal';
import { PlantImageUpload } from './PlantImageUpload';
import { PhotoTimeline } from './PhotoTimeline';
import { CareGuidanceCard } from './CareGuidanceCard';
import { CareGuideCard } from './CareGuideCard';
import { CareReportCard } from './CareReportCard';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import clsx from 'clsx';
import { taskTypeLabels, taskTypeStyle } from '@/utils/taskTypeConfig';

function formatDate(dateString: string | null): string {
  if (!dateString) return 'Never';
  return new Date(dateString).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function PlantDetailPage() {
  const { plantId } = useParams<{ plantId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showAddTask, setShowAddTask] = useState(false);
  const [showEditPlant, setShowEditPlant] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  const {
    data: plant,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['plants', plantId],
    queryFn: () => plantService.getPlant(plantId!),
    enabled: !!plantId,
  });

  // Title reflects the plant once it's loaded; falls back to a generic
  // "Plant" label during the loading flash.
  useDocumentTitle(plant?.name ?? 'Plant');

  const deleteMutation = useMutation({
    mutationFn: () => plantService.deletePlant(plantId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plants'] });
      navigate('/plants');
    },
  });

  const completeTaskMutation = useMutation({
    mutationFn: (taskId: string) => taskService.completeTask(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plants', plantId] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const snoozeTaskMutation = useMutation({
    mutationFn: ({ taskId, days }: { taskId: string; days: number }) =>
      taskService.snoozeTask(taskId, days),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plants', plantId] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
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
          <div className="h-48 rounded-lg bg-gray-100 overflow-hidden">
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
                  className="h-20 w-20 text-gray-300"
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
          <PhotoTimeline plantId={plant.id} />
        </div>

        <div className="flex-1">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{plant.name}</h1>
              {plant.species && <p className="text-lg text-gray-500 italic">{plant.species}</p>}
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowEditPlant(true)}
                leftIcon={<PencilIcon className="h-4 w-4" aria-hidden="true" />}
              >
                Edit
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                leftIcon={<TrashIcon className="h-4 w-4" aria-hidden="true" />}
              >
                Delete
              </Button>
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
          </dl>

          {plant.notes && (
            <div className="mt-4">
              <dt className="text-sm font-medium text-gray-500">Notes</dt>
              <dd className="mt-1 text-sm text-gray-900 whitespace-pre-wrap">{plant.notes}</dd>
            </div>
          )}
        </div>
      </div>

      {/* Curated care guidance — only renders if plant.species matches a known entry */}
      <CareGuidanceCard species={plant.species} />

      {/* Tasks */}
      <Card>
        <CardHeader
          title="Care Tasks"
          description="Scheduled care tasks for this plant"
          action={
            <Button
              size="sm"
              onClick={() => setShowAddTask(true)}
              leftIcon={<PlusIcon className="h-4 w-4" aria-hidden="true" />}
            >
              Add task
            </Button>
          }
        />

        {plant.upcomingTasks.length === 0 ? (
          <EmptyState
            title="No tasks"
            description="Add care tasks to track watering, fertilizing, and more."
            action={<Button onClick={() => setShowAddTask(true)}>Add first task</Button>}
          />
        ) : (
          <ul className="divide-y divide-gray-200 -mx-6 -mb-6">
            {plant.upcomingTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                completions={plant.recentCompletions}
                onComplete={() => completeTaskMutation.mutate(task.id)}
                onSnooze={(days) => snoozeTaskMutation.mutate({ taskId: task.id, days })}
                onEdit={() => setEditingTask(task)}
                isCompleting={completeTaskMutation.isPending}
                isSnoozing={snoozeTaskMutation.isPending}
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

      <EditPlantModal
        plant={plant}
        isOpen={showEditPlant}
        onClose={() => setShowEditPlant(false)}
      />

      {editingTask && (
        <EditTaskModal task={editingTask} isOpen={true} onClose={() => setEditingTask(null)} />
      )}

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => deleteMutation.mutate()}
        title="Delete plant"
        message={`Are you sure you want to delete "${plant.name}"? This will also delete all associated tasks and history.`}
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
}: TaskRowProps) {
  const isOverdue = new Date(task.nextDue) < new Date();
  const streak = computeStreak(task, completions);
  const streakText = streakLabel(task, streak);

  return (
    <li className="flex items-center justify-between gap-4 px-6 py-4 hover:bg-gray-50">
      <div className="flex items-center gap-4 min-w-0">
        <span
          className={clsx(
            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
            taskTypeStyle(task.type).chip
          )}
        >
          {task.customType || taskTypeLabels[task.type]}
        </span>
        <div>
          <p className="text-sm text-gray-900">Every {task.frequency} days</p>
          <p className={clsx('text-xs', isOverdue ? 'text-red-600 font-medium' : 'text-gray-500')}>
            Due: {formatDate(task.nextDue)}
            {task.lastCompleted && ` • Last: ${formatDate(task.lastCompleted)}`}
          </p>
          {streakText && (
            <p className="text-xs text-primary-700 font-medium mt-0.5">🌱 {streakText}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
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
          onClick={onEdit}
          leftIcon={<PencilIcon className="h-4 w-4" aria-hidden="true" />}
          aria-label="Edit task"
        >
          Edit
        </Button>
        <Button
          size="sm"
          onClick={onComplete}
          disabled={isCompleting}
          leftIcon={<CheckIcon className="h-4 w-4" aria-hidden="true" />}
        >
          Done
        </Button>
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
    <details className="relative">
      <summary
        className={clsx(
          'list-none inline-flex items-center justify-center gap-1 px-3 py-2 text-sm font-medium rounded-md min-h-touch min-w-touch cursor-pointer',
          'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2',
          isSnoozing && 'opacity-50 cursor-wait'
        )}
        aria-label="Snooze task"
      >
        <ClockIcon className="h-4 w-4" aria-hidden="true" />
        Snooze
      </summary>
      <ul className="absolute right-0 z-10 mt-1 w-44 rounded-md bg-white shadow-lg ring-1 ring-black/5 py-1">
        {SNOOZE_OPTIONS.map((opt) => (
          <li key={opt.label}>
            <button
              type="button"
              className="flex min-h-touch w-full items-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
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
