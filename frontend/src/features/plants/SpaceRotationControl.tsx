/**
 * Care rotation for one space (ADR 0018) — "the balcony alternates between
 * Sam and Priya, weekly".
 *
 * Free on every plan: rotation is a wedge-deepener, not a paid hook, so this
 * component carries no plan check of any kind.
 *
 * "Whose turn" is always the server's derived answer (`space.rotationTurn`),
 * never re-computed here — the UI and the next occurrence's actual assignee
 * cannot disagree. A rotation whose members are all away shows that in words
 * rather than silently showing nobody.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import type { HouseholdMember } from '@/services/householdService';
import type { PlantSpace } from '@/services/plantService';
import type { RotationInput } from '@/services/spaceService';
import { Button } from '@/components/Button';

interface SpaceRotationControlProps {
  space: PlantSpace;
  members: HouseholdMember[];
  isPending: boolean;
  onSave: (rotation: RotationInput | null) => void;
}

export function SpaceRotationControl({
  space,
  members,
  isPending,
  onSave,
}: SpaceRotationControlProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>(space.rotation?.cadence ?? 'weekly');
  const [memberIds, setMemberIds] = useState<string[]>(space.rotation?.memberIds ?? []);

  const toggle = (userId: string) =>
    setMemberIds((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]
    );

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {space.rotation ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-primary-100 bg-paper px-2.5 py-1 text-xs text-gray-700">
            <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {space.rotationTurn?.turnName
              ? t('spaces.rotation.turnIs', { name: space.rotationTurn.turnName })
              : t('spaces.rotation.everyoneAway')}
          </span>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setEditing(true)}
          aria-label={t('spaces.rotation.editAria', { name: space.name })}
        >
          {space.rotation ? t('spaces.rotation.edit') : t('spaces.rotation.start')}
        </Button>
      </div>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-xl border border-primary-100 bg-paper p-3">
      <p className="text-xs text-gray-600">{t('spaces.rotation.description')}</p>
      <fieldset>
        <legend className="label">{t('spaces.rotation.membersLabel')}</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {members.map((member) => (
            <label key={member.userId} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={memberIds.includes(member.userId)}
                onChange={() => toggle(member.userId)}
              />
              {member.name}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block space-y-1">
        <span className="label">{t('spaces.rotation.cadenceLabel')}</span>
        <select
          className="input"
          value={cadence}
          onChange={(event) => setCadence(event.target.value as 'weekly' | 'monthly')}
        >
          <option value="weekly">{t('spaces.rotation.weekly')}</option>
          <option value="monthly">{t('spaces.rotation.monthly')}</option>
        </select>
      </label>
      {memberIds.length < 2 && (
        <p className="text-xs text-gray-600">{t('spaces.rotation.needTwo')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          isLoading={isPending}
          disabled={memberIds.length < 2}
          onClick={() => {
            onSave({ memberIds, cadence });
            setEditing(false);
          }}
        >
          {t('common.save')}
        </Button>
        {space.rotation && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isPending}
            onClick={() => {
              onSave(null);
              setEditing(false);
            }}
          >
            {t('spaces.rotation.stop')}
          </Button>
        )}
        <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
