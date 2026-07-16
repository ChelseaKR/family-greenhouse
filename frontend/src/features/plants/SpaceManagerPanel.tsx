import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TrashIcon } from '@heroicons/react/24/outline';
import { spaceService } from '@/services/spaceService';
import { getErrorMessage } from '@/services/api';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Card, CardHeader } from '@/components/Card';

export function SpaceManagerPanel() {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<'inside' | 'outside'>('inside');
  const [rainExposure, setRainExposure] = useState<'exposed' | 'sheltered'>('exposed');
  const { data: spaces = [] } = useQuery({
    queryKey: ['spaces', householdId],
    queryFn: spaceService.getSpaces,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['spaces', householdId] });
  const createMutation = useMutation({
    mutationFn: () =>
      spaceService.createSpace({
        name,
        environment,
        rainExposure: environment === 'outside' ? rainExposure : 'sheltered',
      }),
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: spaceService.deleteSpace,
    onSuccess: refresh,
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, exposure }: { id: string; exposure: 'exposed' | 'sheltered' }) =>
      spaceService.updateSpace(id, { rainExposure: exposure }),
    onSuccess: refresh,
  });

  const error = createMutation.error || updateMutation.error || deleteMutation.error;

  return (
    <Card variant="paper">
      <CardHeader title={t('spaces.manageTitle')} description={t('spaces.manageDescription')} />
      {error && (
        <Alert variant="error" className="mb-4">
          {getErrorMessage(error)}
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-end">
        <label className="space-y-1">
          <span className="label">{t('spaces.nameLabel')}</span>
          <input
            className="input"
            maxLength={80}
            value={name}
            placeholder={t('spaces.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <select
          className="input"
          aria-label={t('spaces.environment')}
          value={environment}
          onChange={(event) => setEnvironment(event.target.value as 'inside' | 'outside')}
        >
          <option value="inside">{t('spaces.inside')}</option>
          <option value="outside">{t('spaces.outside')}</option>
        </select>
        {environment === 'outside' && (
          <label className="space-y-1">
            <span className="label">{t('spaces.rainExposure')}</span>
            <select
              className="input"
              value={rainExposure}
              onChange={(event) => setRainExposure(event.target.value as 'exposed' | 'sheltered')}
            >
              <option value="exposed">{t('spaces.exposed')}</option>
              <option value="sheltered">{t('spaces.sheltered')}</option>
            </select>
          </label>
        )}
        <Button
          type="button"
          disabled={!name.trim()}
          isLoading={createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          {t('spaces.createAction')}
        </Button>
      </div>

      {spaces.length > 0 && (
        <ul className="mt-5 divide-y divide-primary-100/60 border-t border-primary-100/60">
          {spaces.map((space) => (
            <li key={space.id} className="flex items-center justify-between gap-3 py-3">
              <div>
                <p className="text-sm font-medium text-ink">{space.name}</p>
                <p className="text-xs text-gray-600">
                  {t(`spaces.${space.environment}`)}
                  {space.environment === 'outside' &&
                    ` · ${t(`spaces.${space.rainExposure ?? 'exposed'}`)}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {space.environment === 'outside' && (
                  <select
                    className="input min-w-32 py-2 text-sm"
                    aria-label={t('spaces.rainExposureAria', { name: space.name })}
                    value={space.rainExposure ?? 'exposed'}
                    disabled={updateMutation.isPending}
                    onChange={(event) =>
                      updateMutation.mutate({
                        id: space.id,
                        exposure: event.target.value as 'exposed' | 'sheltered',
                      })
                    }
                  >
                    <option value="exposed">{t('spaces.exposed')}</option>
                    <option value="sheltered">{t('spaces.sheltered')}</option>
                  </select>
                )}
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  aria-label={t('spaces.deleteAria', { name: space.name })}
                  isLoading={deleteMutation.isPending && deleteMutation.variables === space.id}
                  onClick={() => deleteMutation.mutate(space.id)}
                  leftIcon={<TrashIcon className="h-4 w-4" aria-hidden="true" />}
                >
                  {t('spaces.deleteAction')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
