import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PlusIcon } from '@heroicons/react/24/outline';
import { spaceService } from '@/services/spaceService';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';

interface SpacePickerProps {
  value: string;
  onChange: (spaceId: string) => void;
  error?: string;
}

export function SpacePicker({ value, onChange, error }: SpacePickerProps) {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<'inside' | 'outside'>('inside');

  const { data: spaces = [] } = useQuery({
    queryKey: ['spaces', householdId],
    queryFn: spaceService.getSpaces,
  });

  const createMutation = useMutation({
    mutationFn: () => spaceService.createSpace({ name, environment }),
    onSuccess: (space) => {
      queryClient.invalidateQueries({ queryKey: ['spaces', householdId] });
      onChange(space.id);
      setName('');
      setCreating(false);
    },
  });

  const inside = spaces.filter((space) => space.environment === 'inside');
  const outside = spaces.filter((space) => space.environment === 'outside');

  return (
    <div className="space-y-2">
      <label htmlFor="plant-space" className="label">
        {t('spaces.fieldLabel')}
      </label>
      <select
        id="plant-space"
        className="input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t('spaces.unplaced')}</option>
        {inside.length > 0 && (
          <optgroup label={t('spaces.inside')}>
            {inside.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
          </optgroup>
        )}
        {outside.length > 0 && (
          <optgroup label={t('spaces.outside')}>
            {outside.map((space) => (
              <option key={space.id} value={space.id}>
                {space.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {error && <p className="error-message">{error}</p>}

      {!creating ? (
        <button
          type="button"
          className="inline-flex min-h-touch items-center gap-1 text-sm font-medium text-primary-700 hover:underline"
          onClick={() => setCreating(true)}
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
          {t('spaces.createAction')}
        </button>
      ) : (
        <div className="rounded-lg border border-primary-100/70 bg-parchment/50 p-3 space-y-3">
          <input
            className="input"
            value={name}
            maxLength={80}
            placeholder={t('spaces.namePlaceholder')}
            aria-label={t('spaces.nameLabel')}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('spaces.environment')}>
            {(['inside', 'outside'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`min-h-touch rounded-full border px-3 py-1.5 text-sm ${
                  environment === option
                    ? 'border-primary-500 bg-primary-100 text-primary-900'
                    : 'border-primary-200 bg-paper text-gray-700'
                }`}
                aria-pressed={environment === option}
                onClick={() => setEnvironment(option)}
              >
                {t(`spaces.${option}`)}
              </button>
            ))}
          </div>
          {createMutation.isError && (
            <p className="error-message">{getErrorMessage(createMutation.error)}</p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!name.trim()}
              isLoading={createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {t('spaces.createAction')}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
