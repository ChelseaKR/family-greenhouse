import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TrashIcon } from '@heroicons/react/24/outline';
import { spaceService } from '@/services/spaceService';
import { householdService } from '@/services/householdService';
import { getErrorMessage } from '@/services/api';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Card, CardHeader } from '@/components/Card';
import type { PlantSpace } from '@/services/plantService';

type LightLevel = NonNullable<PlantSpace['lightLevel']>;
type PetAccessChoice = '' | 'yes' | 'no';

export function SpaceManagerPanel() {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<'inside' | 'outside'>('inside');
  const [rainExposure, setRainExposure] = useState<'exposed' | 'sheltered'>('exposed');
  const [lightLevel, setLightLevel] = useState<'' | LightLevel>('');
  const [petAccess, setPetAccess] = useState<PetAccessChoice>('');
  const [defaultCaregiverId, setDefaultCaregiverId] = useState('');
  const { data: spaces = [] } = useQuery({
    queryKey: ['spaces', householdId],
    queryFn: spaceService.getSpaces,
  });
  const { data: household } = useQuery({
    queryKey: ['household', householdId],
    queryFn: () => householdService.getHousehold(householdId!),
    enabled: Boolean(householdId),
  });
  const members = household?.members ?? [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['spaces', householdId] });
  const createMutation = useMutation({
    mutationFn: () =>
      spaceService.createSpace({
        name,
        environment,
        rainExposure: environment === 'outside' ? rainExposure : 'sheltered',
        lightLevel: lightLevel || undefined,
        petAccess: petAccess === '' ? undefined : petAccess === 'yes',
        defaultCaregiverId: defaultCaregiverId || undefined,
      }),
    onSuccess: () => {
      setName('');
      setLightLevel('');
      setPetAccess('');
      setDefaultCaregiverId('');
      refresh();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: spaceService.deleteSpace,
    onSuccess: refresh,
  });
  const updateMutation = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Partial<
        Pick<PlantSpace, 'rainExposure' | 'lightLevel' | 'petAccess' | 'defaultCaregiverId'>
      >;
    }) => spaceService.updateSpace(id, input),
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <label className="space-y-1 lg:col-span-2">
          <span className="label">{t('spaces.nameLabel')}</span>
          <input
            className="input"
            maxLength={80}
            value={name}
            placeholder={t('spaces.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="label">{t('spaces.environment')}</span>
          <select
            className="input"
            value={environment}
            onChange={(event) => setEnvironment(event.target.value as 'inside' | 'outside')}
          >
            <option value="inside">{t('spaces.inside')}</option>
            <option value="outside">{t('spaces.outside')}</option>
          </select>
        </label>
        <Button
          type="button"
          disabled={!name.trim()}
          isLoading={createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          {t('spaces.createAction')}
        </Button>
        <label className="space-y-1">
          <span className="label">{t('spaces.lightLevel')}</span>
          <select
            className="input"
            value={lightLevel}
            onChange={(event) => setLightLevel(event.target.value as '' | LightLevel)}
          >
            <option value="">{t('spaces.unknown')}</option>
            <option value="low">{t('spaces.lightLow')}</option>
            <option value="medium">{t('spaces.lightMedium')}</option>
            <option value="bright">{t('spaces.lightBright')}</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="label">{t('spaces.petAccess')}</span>
          <select
            className="input"
            value={petAccess}
            onChange={(event) => setPetAccess(event.target.value as PetAccessChoice)}
          >
            <option value="">{t('spaces.unknown')}</option>
            <option value="yes">{t('spaces.petAccessYes')}</option>
            <option value="no">{t('spaces.petAccessNo')}</option>
          </select>
        </label>
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
        <label className="space-y-1 sm:col-span-2 lg:col-span-2">
          <span className="label">{t('spaces.defaultCaregiver')}</span>
          <select
            className="input"
            value={defaultCaregiverId}
            onChange={(event) => setDefaultCaregiverId(event.target.value)}
          >
            <option value="">{t('spaces.noDefaultCaregiver')}</option>
            {members.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.name}
              </option>
            ))}
          </select>
          <span className="block text-xs text-gray-600">{t('spaces.defaultCaregiverHint')}</span>
        </label>
      </div>

      {spaces.length > 0 && (
        <ul className="mt-5 divide-y divide-primary-100/60 border-t border-primary-100/60">
          {spaces.map((space) => (
            <li
              key={space.id}
              className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium text-ink">{space.name}</p>
                <p className="text-xs text-gray-600">
                  {t(`spaces.${space.environment}`)}
                  {space.environment === 'outside' &&
                    ` · ${t(`spaces.${space.rainExposure ?? 'exposed'}`)}`}
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                <select
                  className="input min-w-32 flex-1 py-2 text-sm sm:flex-none"
                  aria-label={t('spaces.lightLevelAria', { name: space.name })}
                  value={space.lightLevel ?? ''}
                  disabled={updateMutation.isPending}
                  onChange={(event) =>
                    updateMutation.mutate({
                      id: space.id,
                      input: { lightLevel: (event.target.value || null) as LightLevel | null },
                    })
                  }
                >
                  <option value="">{t('spaces.lightUnknown')}</option>
                  <option value="low">{t('spaces.lightLow')}</option>
                  <option value="medium">{t('spaces.lightMedium')}</option>
                  <option value="bright">{t('spaces.lightBright')}</option>
                </select>
                <select
                  className="input min-w-32 flex-1 py-2 text-sm sm:flex-none"
                  aria-label={t('spaces.petAccessAria', { name: space.name })}
                  value={space.petAccess == null ? '' : space.petAccess ? 'yes' : 'no'}
                  disabled={updateMutation.isPending}
                  onChange={(event) =>
                    updateMutation.mutate({
                      id: space.id,
                      input: {
                        petAccess: event.target.value === '' ? null : event.target.value === 'yes',
                      },
                    })
                  }
                >
                  <option value="">{t('spaces.petsUnknown')}</option>
                  <option value="yes">{t('spaces.petAccessYes')}</option>
                  <option value="no">{t('spaces.petAccessNo')}</option>
                </select>
                {space.environment === 'outside' && (
                  <select
                    className="input min-w-32 flex-1 py-2 text-sm sm:flex-none"
                    aria-label={t('spaces.rainExposureAria', { name: space.name })}
                    value={space.rainExposure ?? 'exposed'}
                    disabled={updateMutation.isPending}
                    onChange={(event) =>
                      updateMutation.mutate({
                        id: space.id,
                        input: {
                          rainExposure: event.target.value as 'exposed' | 'sheltered',
                        },
                      })
                    }
                  >
                    <option value="exposed">{t('spaces.exposed')}</option>
                    <option value="sheltered">{t('spaces.sheltered')}</option>
                  </select>
                )}
                <select
                  className="input min-w-40 flex-1 py-2 text-sm sm:flex-none"
                  aria-label={t('spaces.defaultCaregiverAria', { name: space.name })}
                  value={space.defaultCaregiverId ?? ''}
                  disabled={updateMutation.isPending}
                  onChange={(event) =>
                    updateMutation.mutate({
                      id: space.id,
                      input: { defaultCaregiverId: event.target.value || null },
                    })
                  }
                >
                  <option value="">{t('spaces.noDefaultCaregiver')}</option>
                  {members.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.name}
                    </option>
                  ))}
                </select>
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
