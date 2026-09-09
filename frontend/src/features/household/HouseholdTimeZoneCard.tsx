/**
 * Household timezone — ADR 0025 phase 2, and only phase 2.
 *
 * Phase 1 (#586) added `PUT /households/{id}/timezone` and made the field
 * readable on `GET /households/{id}`. Nothing in the frontend called it, so a
 * household could not set the field that phase 4's cutover keys on, and phase 4
 * had nobody to go first with. This is that surface.
 *
 * **It changes no answer.** Due dates are still ISO instants compared in the
 * Lambda's own zone on every surface — the overdue filter, the 7-day upcoming
 * window, the reminder scan's rolling 24-hour cutoff, the ICS all-day date, the
 * digest's days-overdue. ADR 0025's own phase table says phase 2 changes
 * nothing, and the copy below says so to the reader rather than implying a
 * behaviour that has not shipped. Promising "your due dates now follow this
 * zone" before phase 4 would be the more comfortable sentence and would be
 * false.
 *
 * **Three states, not two.** Absent or `''` is *never set*; `'UTC'` is somebody
 * *choosing* UTC; anything else is a real zone. The backend keeps them apart by
 * removing the DynamoDB attribute rather than storing an empty string, and the
 * cutover's guarantee — a household with no zone set keeps today's behaviour
 * byte for byte — depends on it. So this card offers "clear" as a distinct
 * action from saving `UTC`, and renders the unset state in its own words
 * instead of showing a default that was never chosen.
 *
 * The browser's zone seeds the input and is never written on the user's behalf.
 * A background write would put a household into the *chosen* state without
 * anyone choosing, which is the same defect one level up.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { householdService, type Household } from '@/services/householdService';
import { getErrorMessage } from '@/services/api';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Card, CardHeader } from '@/components/Card';
import { Input } from '@/components/Input';
import { isValidTimeZone, resolveBrowserTimeZone } from '@/utils/timeZone';

interface HouseholdTimeZoneCardProps {
  householdId: string;
  household: Pick<Household, 'timezone'>;
}

export function HouseholdTimeZoneCard({ householdId, household }: HouseholdTimeZoneCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // `?? ''` collapses absent and empty deliberately: both mean "never set", and
  // the server answers with either depending on how the row was written.
  const saved = household.timezone ?? '';
  const [browserTimeZone] = useState(resolveBrowserTimeZone);
  const [draft, setDraft] = useState(saved || browserTimeZone || '');
  const [justSaved, setJustSaved] = useState<'set' | 'cleared' | null>(null);

  const mutation = useMutation({
    mutationFn: (timezone: string) => householdService.setTimeZone(householdId, timezone),
    onSuccess: (_data, timezone) => {
      setJustSaved(timezone === '' ? 'cleared' : 'set');
      queryClient.invalidateQueries({ queryKey: ['household', householdId] });
    },
  });

  const trimmed = draft.trim();
  // Client-side validation is a courtesy, not the authority — the server
  // validates again. It must not be stricter than the server, or the form
  // refuses a name the API would accept.
  const draftIsValid = trimmed !== '' && isValidTimeZone(trimmed);
  const draftIsUnchanged = trimmed === saved;

  return (
    <Card>
      <CardHeader
        title={t('household.timeZoneTitle')}
        description={t('household.timeZoneDescription')}
      />

      <div className="space-y-3">
        {saved === '' ? (
          <p className="text-sm text-gray-600">{t('household.timeZoneNotSet')}</p>
        ) : (
          <p className="text-sm">
            {t('household.timeZoneCurrent')}{' '}
            <span className="font-medium text-gray-900">{saved}</span>
          </p>
        )}

        <Alert variant="info">{t('household.timeZoneNotUsedYet')}</Alert>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draftIsValid || draftIsUnchanged) return;
            setJustSaved(null);
            mutation.mutate(trimmed);
          }}
        >
          <Input
            label={t('household.timeZoneLabel')}
            placeholder={t('household.timeZonePlaceholder')}
            value={draft}
            onChange={(e) => {
              setJustSaved(null);
              setDraft(e.target.value);
            }}
            helperText={
              browserTimeZone
                ? t('household.timeZoneBrowserHint', { zone: browserTimeZone })
                : t('household.timeZoneNoBrowserZone')
            }
            error={trimmed !== '' && !draftIsValid ? t('household.timeZoneInvalid') : undefined}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              isLoading={mutation.isPending}
              disabled={mutation.isPending || !draftIsValid || draftIsUnchanged}
            >
              {t('household.timeZoneSave')}
            </Button>
            {saved !== '' && (
              <Button
                type="button"
                variant="secondary"
                isLoading={mutation.isPending}
                disabled={mutation.isPending}
                onClick={() => {
                  setJustSaved(null);
                  setDraft('');
                  mutation.mutate('');
                }}
              >
                {t('household.timeZoneClear')}
              </Button>
            )}
          </div>
        </form>

        {justSaved === 'set' && <Alert variant="success">{t('household.timeZoneSaved')}</Alert>}
        {justSaved === 'cleared' && (
          <Alert variant="success">{t('household.timeZoneCleared')}</Alert>
        )}
        {mutation.isError && <Alert variant="error">{getErrorMessage(mutation.error)}</Alert>}
      </div>
    </Card>
  );
}
