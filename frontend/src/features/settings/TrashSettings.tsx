import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowUturnLeftIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { EmptyState } from '@/components/EmptyState';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { getErrorMessage } from '@/services/api';
import { trashService, type TrashEntry } from '@/services/trashService';
import { formatDate } from '@/i18n/format';
import { toast } from '@/store/toastStore';

/**
 * Settings → Trash (#670). Deleted plants and tasks wait here for the
 * retention window the server reports; anyone in the household can restore
 * them, or delete them for good ahead of time.
 *
 * Read states are kept apart (ADR 0010): a failed listing is an error with a
 * retry, never "The trash is empty" — an empty trash tells someone who just
 * deleted the wrong plant that it is gone, which is the one thing this page
 * exists to not say falsely.
 */
export function TrashSettings() {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [purgeTarget, setPurgeTarget] = useState<TrashEntry | null>(null);

  const trashQuery = useQuery({
    queryKey: ['trash', householdId],
    queryFn: () => trashService.list(householdId!),
    enabled: !!householdId,
  });

  const labelFor = (entry: TrashEntry): string => {
    if (entry.kind === 'plant') return entry.name;
    const taskLabel =
      entry.taskType && entry.taskType !== 'custom'
        ? t(`tasks.types.${entry.taskType}`, { defaultValue: entry.name })
        : entry.name;
    return entry.plantName
      ? t('trash.taskLabel', { task: taskLabel, plant: entry.plantName })
      : taskLabel;
  };

  const invalidateAfterChange = () => {
    queryClient.invalidateQueries({ queryKey: ['trash', householdId] });
    queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
    queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
  };

  const restoreMutation = useMutation({
    mutationFn: (entry: TrashEntry) => trashService.restore(householdId!, entry.kind, entry.id),
    onSuccess: (_restored, entry) => {
      invalidateAfterChange();
      toast.success(t('trash.restoredToast', { name: labelFor(entry) }));
    },
  });

  const purgeMutation = useMutation({
    mutationFn: (entry: TrashEntry) => trashService.purge(householdId!, entry.kind, entry.id),
    onSuccess: (_void, entry) => {
      invalidateAfterChange();
      setPurgeTarget(null);
      toast.success(t('trash.purgedToast', { name: labelFor(entry) }));
    },
    // Close the dialog so the error below is visible instead of hidden behind it.
    onError: () => setPurgeTarget(null),
  });

  if (!householdId) {
    return (
      <Card>
        <CardHeader title={t('trash.title')} />
        <p className="text-sm text-gray-600">{t('trash.noHousehold')}</p>
      </Card>
    );
  }

  if (trashQuery.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const listing = trashQuery.data;
  const mutationError = restoreMutation.error ?? purgeMutation.error;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={t('trash.title')}
          description={t('trash.description', { days: listing?.retentionDays ?? 30 })}
        />

        {mutationError && (
          <Alert variant="error" className="mb-4">
            {getErrorMessage(mutationError)}
          </Alert>
        )}

        {listing === undefined ? (
          <Alert variant="error">
            <p>{t('trash.loadFailed')}</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => trashQuery.refetch()}
              isLoading={trashQuery.isFetching}
            >
              {t('common.retry')}
            </Button>
          </Alert>
        ) : listing.entries.length === 0 ? (
          <EmptyState
            title={t('trash.emptyTitle')}
            description={t('trash.emptyDescription', { days: listing.retentionDays })}
          />
        ) : (
          <ul className="divide-y divide-primary-100/80" aria-label={t('trash.listLabel')}>
            {listing.entries.map((entry) => {
              const label = labelFor(entry);
              const busy =
                (restoreMutation.isPending && restoreMutation.variables?.id === entry.id) ||
                (purgeMutation.isPending && purgeMutation.variables?.id === entry.id);
              return (
                <li
                  key={`${entry.kind}:${entry.id}`}
                  className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-ink break-words">
                      {label}{' '}
                      <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-700">
                        {t(entry.kind === 'plant' ? 'trash.kindPlant' : 'trash.kindTask')}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-gray-600">
                      {t('trash.deletedBy', {
                        name: entry.deletedByName,
                        date: formatDate(entry.deletedAt),
                      })}
                    </p>
                    {entry.contents && (
                      <p className="mt-1 text-sm text-gray-600">
                        {t('trash.contents', {
                          tasks: entry.contents.tasks,
                          photos: entry.contents.photos,
                          completions: entry.contents.completions,
                        })}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-gray-600">
                      {entry.restoring
                        ? t('trash.restoringNote')
                        : t('trash.purgeOn', { date: formatDate(entry.purgeAfter) })}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => restoreMutation.mutate(entry)}
                      isLoading={
                        restoreMutation.isPending && restoreMutation.variables?.id === entry.id
                      }
                      disabled={busy}
                      leftIcon={<ArrowUturnLeftIcon className="h-4 w-4" aria-hidden="true" />}
                      aria-label={t('trash.restoreAria', { name: label })}
                    >
                      {t('trash.restore')}
                    </Button>
                    {!entry.restoring && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPurgeTarget(entry)}
                        disabled={busy}
                        leftIcon={<TrashIcon className="h-4 w-4" aria-hidden="true" />}
                        aria-label={t('trash.purgeAria', { name: label })}
                      >
                        {t('trash.purge')}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        isOpen={purgeTarget !== null}
        onClose={() => setPurgeTarget(null)}
        onConfirm={() => purgeTarget && purgeMutation.mutate(purgeTarget)}
        title={t('trash.purgeConfirmTitle')}
        message={purgeTarget ? t('trash.purgeConfirmMessage', { name: labelFor(purgeTarget) }) : ''}
        confirmLabel={t('trash.purge')}
        isLoading={purgeMutation.isPending}
      />
    </div>
  );
}
