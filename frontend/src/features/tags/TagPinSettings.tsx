import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { plantTagService } from '@/services/plantTagService';
import { getErrorMessage } from '@/services/api';

/**
 * Household setting for plant-tag scan pages (ADR 0016): an optional 4-digit
 * PIN. It exists because a QR label in a pot is a published credential the
 * moment someone photographs the plant — the PIN is what a household that
 * posts its living room online can turn on. Enforcement is server-side and
 * rate-limited per tag; this screen only sets it, and only an admin can,
 * because it changes what every printed label in the house will do.
 */
export function TagPinSettings() {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const isAdmin = useIsHouseholdAdmin();
  const queryClient = useQueryClient();
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<'on' | 'off' | null>(null);

  const tagsQuery = useQuery({
    queryKey: ['plant-tags', householdId],
    queryFn: () => plantTagService.list(householdId!),
    enabled: !!householdId,
  });

  // A failed read must not render as "the PIN is off" — that is a security
  // claim nobody computed. See ADR 0010.
  const settingsUnavailable = !tagsQuery.isLoading && tagsQuery.data === undefined;

  const mutation = useMutation({
    mutationFn: (next: string | null) => plantTagService.setPin(householdId!, next),
    onSuccess: (result) => {
      setPin('');
      setConfirm('');
      setFormError(null);
      setSaved(result.pinEnabled ? 'on' : 'off');
      void queryClient.invalidateQueries({ queryKey: ['plant-tags', householdId] });
    },
    onError: (err) => setFormError(getErrorMessage(err)),
  });

  const digits = (value: string) => value.replace(/\D/g, '').slice(0, 4);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(null);
    if (pin.length !== 4) {
      setFormError(t('plantTags.pin.fourDigits'));
      return;
    }
    if (pin !== confirm) {
      setFormError(t('plantTags.pin.mismatch'));
      return;
    }
    mutation.mutate(pin);
  };

  return (
    <Card>
      <CardHeader title={t('plantTags.pin.title')} description={t('plantTags.pin.description')} />

      {tagsQuery.isLoading && (
        <div className="flex items-center gap-3 text-sm text-gray-600" role="status">
          <LoadingSpinner size="sm" />
          <span>{t('plantTags.pin.loading')}</span>
        </div>
      )}

      {settingsUnavailable && (
        <Alert variant="error" title={t('plantTags.pin.loadFailedTitle')}>
          {t('plantTags.pin.loadFailedBody')}
        </Alert>
      )}

      {tagsQuery.data && (
        <>
          <p className="text-sm text-gray-700">
            {tagsQuery.data.pinEnabled ? t('plantTags.pin.statusOn') : t('plantTags.pin.statusOff')}
          </p>

          {saved && (
            <Alert
              variant="success"
              className="mt-4"
              title={saved === 'on' ? t('plantTags.pin.savedOn') : t('plantTags.pin.savedOff')}
            >
              {t('plantTags.pin.savedBody')}
            </Alert>
          )}

          {formError && (
            <Alert variant="error" className="mt-4" title={t('plantTags.pin.errorTitle')}>
              {formError}
            </Alert>
          )}

          {isAdmin ? (
            <form className="mt-4 space-y-4" onSubmit={submit}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={t('plantTags.pin.newLabel')}
                  value={pin}
                  onChange={(event) => setPin(digits(event.target.value))}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                />
                <Input
                  label={t('plantTags.pin.confirmLabel')}
                  value={confirm}
                  onChange={(event) => setConfirm(digits(event.target.value))}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={4}
                />
              </div>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" variant="primary" isLoading={mutation.isPending}>
                  {tagsQuery.data.pinEnabled
                    ? t('plantTags.pin.changeCta')
                    : t('plantTags.pin.setCta')}
                </Button>
                {tagsQuery.data.pinEnabled && (
                  <Button
                    type="button"
                    variant="secondary"
                    isLoading={mutation.isPending}
                    onClick={() => {
                      setSaved(null);
                      setFormError(null);
                      mutation.mutate(null);
                    }}
                  >
                    {t('plantTags.pin.clearCta')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-gray-600">{t('plantTags.pin.help')}</p>
            </form>
          ) : (
            <p className="mt-4 text-sm text-gray-600">{t('plantTags.pin.adminOnly')}</p>
          )}

          <p className="mt-4 text-sm">
            <Link to="/tags" className="text-primary-700 underline hover:text-primary-800">
              {t('plantTags.pin.sheetLink')}
            </Link>
          </p>
        </>
      )}
    </Card>
  );
}
