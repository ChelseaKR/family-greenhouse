import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PrinterIcon, QrCodeIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PageHeader } from '@/components/PageHeader';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { plantService } from '@/services/plantService';
import { plantTagService, type PlantTag } from '@/services/plantTagService';
import { getErrorMessage } from '@/services/api';
import { QrCode } from './QrCode';

/**
 * The members-only print sheet (ADR 0016). Two things happen here:
 *
 *   1. Choose which plants get a label — issue, re-issue (rotate the token in
 *      one click) and turn a label off.
 *   2. Print. The labels are laid out as a plain grid that fits A4 and Letter
 *      with the same CSS; `print:` variants drop every piece of app chrome so
 *      what leaves the printer is labels and nothing else. No label-printer
 *      integrations, on purpose — the brief's second risk is that printing is
 *      friction, and the fix is "works on the printer you already own".
 *
 * The QR codes are generated in the browser from the tag URLs (see ./qr.ts),
 * so no token is ever sent to an image service.
 */
export function PlantTagsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('plantTags.title'));
  const householdId = useActiveHouseholdId();
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<PlantTag | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const tagsQuery = useQuery({
    queryKey: ['plant-tags', householdId],
    queryFn: () => plantTagService.list(householdId!),
    enabled: !!householdId,
  });
  const plantsQuery = useQuery({
    queryKey: ['plants', householdId],
    queryFn: () => plantService.getPlants(),
    enabled: !!householdId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['plant-tags', householdId] });
  };

  const issueMutation = useMutation({
    mutationFn: (plantId: string) => plantTagService.issue(plantId),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(getErrorMessage(err)),
  });
  const revokeMutation = useMutation({
    mutationFn: (plantId: string) => plantTagService.revoke(plantId),
    onSuccess: () => {
      setActionError(null);
      setRevoking(null);
      invalidate();
    },
    onError: (err) => {
      setActionError(getErrorMessage(err));
      setRevoking(null);
    },
  });

  // A settled read that FAILED must never render as "you have no labels":
  // the labels in the pots keep working, and this page is the only place to
  // turn one off. See ADR 0010.
  const tagsUnavailable = !tagsQuery.isLoading && tagsQuery.data === undefined;
  const data = tagsQuery.data;
  const tags = data?.tags ?? [];
  const taggedPlantIds = new Set(tags.map((tag) => tag.plantId));
  const untagged = (plantsQuery.data ?? []).filter((plant) => !taggedPlantIds.has(plant.id));
  const allowance = data?.allowance;
  const atCap = allowance?.max !== null && allowance !== undefined && tags.length >= allowance.max;

  return (
    <div className="space-y-6">
      <div className="print:hidden">
        <PageHeader
          eyebrow={t('plantTags.eyebrow')}
          title={t('plantTags.title')}
          description={t('plantTags.description')}
          action={
            tags.length > 0 ? (
              <Button
                variant="primary"
                onClick={() => window.print()}
                leftIcon={<PrinterIcon className="h-4 w-4" aria-hidden="true" />}
              >
                {t('plantTags.print')}
              </Button>
            ) : undefined
          }
        />
      </div>

      {tagsQuery.isLoading && (
        <div className="flex items-center gap-3 text-sm text-gray-600" role="status">
          <LoadingSpinner size="sm" />
          <span>{t('plantTags.loading')}</span>
        </div>
      )}

      {tagsUnavailable && (
        <Alert variant="error" title={t('plantTags.loadFailedTitle')}>
          {t('plantTags.loadFailedBody')}
        </Alert>
      )}

      {actionError && (
        <Alert variant="error" title={t('plantTags.actionFailedTitle')}>
          {actionError}
        </Alert>
      )}

      {data && !data.allowance.enabled && (
        <Card>
          <CardHeader title={t('plantTags.lockedTitle')} description={t('plantTags.lockedBody')} />
          <Link to="/pricing" className="text-primary-700 underline hover:text-primary-800">
            {t('plantTags.lockedCta')}
          </Link>
        </Card>
      )}

      {data?.allowance.enabled && (
        <>
          <Card className="print:hidden">
            <CardHeader
              title={t('plantTags.chooseTitle')}
              description={
                allowance?.max === null
                  ? t('plantTags.allowanceUnlimited', { used: tags.length })
                  : t('plantTags.allowanceCounted', { used: tags.length, max: allowance?.max })
              }
            />
            {data.pinEnabled ? (
              <p className="mb-4 text-sm text-primary-800">{t('plantTags.pinOnNotice')}</p>
            ) : (
              <p className="mb-4 text-sm text-gray-600">{t('plantTags.pinOffNotice')}</p>
            )}
            <p className="mb-4 text-sm text-gray-600">
              <Link
                to="/settings?section=plant-tags"
                className="text-primary-700 underline hover:text-primary-800"
              >
                {t('plantTags.pinSettingsLink')}
              </Link>
            </p>

            {tags.length > 0 && (
              <ul className="mb-6 divide-y divide-primary-100/70">
                {tags.map((tag) => (
                  <li key={tag.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-gray-900">{tag.plantName}</p>
                      <p className="text-xs text-gray-600">{t('plantTags.labelReady')}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        isLoading={
                          issueMutation.isPending && issueMutation.variables === tag.plantId
                        }
                        onClick={() => issueMutation.mutate(tag.plantId)}
                        aria-label={t('plantTags.reissueAria', { plant: tag.plantName })}
                      >
                        {t('plantTags.reissue')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setRevoking(tag)}
                        leftIcon={<TrashIcon className="h-4 w-4" aria-hidden="true" />}
                        aria-label={t('plantTags.revokeAria', { plant: tag.plantName })}
                      >
                        {t('plantTags.revoke')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="mb-2 text-sm font-medium text-gray-900">{t('plantTags.addHeading')}</h3>
            {plantsQuery.isError ? (
              <Alert variant="warning" title={t('plantTags.plantsFailedTitle')}>
                {t('plantTags.plantsFailedBody')}
              </Alert>
            ) : untagged.length === 0 ? (
              <p className="text-sm text-gray-600">{t('plantTags.allTagged')}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {untagged.map((plant) => (
                  <li key={plant.id}>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={atCap}
                      isLoading={issueMutation.isPending && issueMutation.variables === plant.id}
                      onClick={() => issueMutation.mutate(plant.id)}
                      leftIcon={<QrCodeIcon className="h-4 w-4" aria-hidden="true" />}
                    >
                      {plant.name}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {atCap && <p className="mt-3 text-sm text-amber-700">{t('plantTags.atCap')}</p>}
          </Card>

          {tags.length === 0 ? (
            <p className="text-sm text-gray-600 print:hidden">{t('plantTags.empty')}</p>
          ) : (
            <section aria-label={t('plantTags.sheetLabel')}>
              <p className="mb-3 text-sm text-gray-600 print:hidden">{t('plantTags.sheetHint')}</p>
              {/* The sheet itself. Two columns on paper (and on any screen wide
                  enough); each label is a fixed-aspect card with a generous
                  quiet zone so a phone camera locks on from ~20 cm. */}
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 print:grid-cols-2 print:gap-3">
                {tags.map((tag) => (
                  <li
                    key={tag.id}
                    className="flex items-center gap-4 rounded-xl border border-gray-300 bg-white p-4 print:break-inside-avoid print:rounded-none print:border-dashed print:shadow-none"
                  >
                    <QrCode
                      value={tag.url}
                      title={t('plantTags.qrAlt', { plant: tag.plantName })}
                      size="7rem"
                      className="h-28 w-28 shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="truncate font-serif text-lg text-ink">{tag.plantName}</p>
                      {tag.plantSpecies && (
                        <p className="truncate text-xs italic text-gray-600">{tag.plantSpecies}</p>
                      )}
                      <p className="mt-2 text-sm text-gray-700">
                        {t('plantTags.labelInstruction')}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <ConfirmDialog
        isOpen={revoking !== null}
        title={t('plantTags.revokeConfirmTitle')}
        message={t('plantTags.revokeConfirmBody', { plant: revoking?.plantName ?? '' })}
        confirmLabel={t('plantTags.revoke')}
        variant="danger"
        isLoading={revokeMutation.isPending}
        onConfirm={() => revoking && revokeMutation.mutate(revoking.plantId)}
        onClose={() => setRevoking(null)}
      />
    </div>
  );
}
