import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router';
import { ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import { Card, CardHeader } from '@/components/Card';
import { Button } from '@/components/Button';
import { Alert } from '@/components/Alert';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { useIsHouseholdAdmin } from '@/hooks/useActiveHouseholdRole';
import { getErrorMessage } from '@/services/api';
import {
  archiveImportService,
  type ArchiveImportPreview,
  type ArchiveImportRequest,
  type ArchiveImportResult,
} from '@/services/archiveImportService';
import { formatDate } from '@/i18n/format';
import { ARCHIVE_MAX_BYTES, archiveUpload, readArchiveFile, uploadBytes } from './archiveFile';
import type { ArchiveFile, ArchiveFileError } from './archiveFile';

/**
 * Every refusal — the browser's own check of the file and the server's
 * `details.code` — onto the sentence for it (`archiveImport.errors.*`).
 */
const ERROR_KEYS: Record<ArchiveFileError | string, string> = {
  tooLarge: 'tooLarge',
  notJson: 'notJson',
  notAnArchive: 'notArchive',
  newerVersion: 'newerVersion',
  unsupportedVersion: 'version',
  noHouseholds: 'invalid',
  not_an_archive: 'notArchive',
  unknown_format: 'notArchive',
  unsupported_version: 'version',
  unsafe_content: 'invalid',
  invalid_content: 'invalid',
  duplicate_id: 'invalid',
  manifest_mismatch: 'manifest',
  household_not_found: 'invalid',
  not_empty: 'notEmpty',
  other_archive: 'otherArchive',
  archive_changed: 'changed',
  target_changed: 'changed',
  over_plan_limit: 'overLimit',
  stopped_at_plan_limit: 'stoppedAtLimit',
  interrupted: 'interrupted',
};

type Details = Record<string, unknown> & {
  landed?: { plants?: number; tasks?: number };
  expected?: { plants?: number; tasks?: number };
};

function detailsOf(error: unknown): Details {
  const data = (error as { response?: { data?: { details?: unknown } } })?.response?.data;
  return (data?.details ?? {}) as Details;
}

/**
 * Settings → Account → "Restore a household from an export" (#669).
 *
 * Choose the app's own JSON export, pick which household in it to restore,
 * check it (a server preview that writes nothing), then restore. The preview
 * lists what comes back and, as prominently, what does not: photos, spaces,
 * members, billing and every kind of link. It restores into an EMPTY household
 * only; anything else is refused with a way forward (a new household).
 */
export function ArchiveImportCard() {
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const isAdmin = useIsHouseholdAdmin();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<ArchiveFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [preview, setPreview] = useState<ArchiveImportPreview | null>(null);
  const [result, setResult] = useState<ArchiveImportResult | null>(null);

  const previewMutation = useMutation({
    mutationFn: (body: ArchiveImportRequest) => archiveImportService.preview(householdId!, body),
    onSuccess: setPreview,
  });
  const commitMutation = useMutation({
    mutationFn: ({ body, digest }: { body: ArchiveImportRequest; digest: string }) =>
      archiveImportService.commit(householdId!, body, digest),
    onSuccess: (data) => {
      setResult(data);
      // The household's name, plants, tasks and feed all changed at once.
      void queryClient.invalidateQueries();
    },
  });

  function message(code: string, values: Record<string, unknown> = {}): string {
    return t(`archiveImport.errors.${ERROR_KEYS[code] ?? 'invalid'}`, values);
  }

  function serverError(error: unknown): string {
    const d = detailsOf(error);
    const code = typeof d.code === 'string' ? d.code : '';
    if (!(code in ERROR_KEYS)) return getErrorMessage(error);
    return message(code, {
      ...d,
      active: d.activePlants,
      plants: d.landed?.plants ?? 0,
      tasks: d.landed?.tasks ?? 0,
      totalPlants: d.expected?.plants ?? 0,
      totalTasks: d.expected?.tasks ?? 0,
    });
  }

  function request(): ArchiveImportRequest | null {
    return file && sourceId
      ? { archive: archiveUpload(file, sourceId), sourceHouseholdId: sourceId }
      : null;
  }

  async function handleFile(chosen: File) {
    setFile(null);
    setPreview(null);
    setResult(null);
    previewMutation.reset();
    commitMutation.reset();
    const read =
      chosen.size > ARCHIVE_MAX_BYTES
        ? readArchiveFile('', chosen.size)
        : readArchiveFile(await chosen.text().catch(() => ''), chosen.size);
    if (!read.ok) {
      setFileError(message(read.error, { version: read.version }));
      return;
    }
    setFileError(null);
    setFile(read.file);
    setSourceId(read.file.households[0].id);
  }

  function check() {
    const body = request();
    if (!body) return;
    if (uploadBytes(body) > ARCHIVE_MAX_BYTES) {
      setFileError(message('tooLarge'));
      return;
    }
    setPreview(null);
    commitMutation.reset();
    previewMutation.mutate(body);
  }

  function restore() {
    const body = request();
    if (body && preview) commitMutation.mutate({ body, digest: preview.digest });
  }

  if (!householdId) return null;

  const header = (
    <CardHeader title={t('archiveImport.title')} description={t('archiveImport.description')} />
  );
  if (!isAdmin) {
    return (
      <Card>
        {header}
        <p className="text-sm text-gray-600">{t('archiveImport.adminOnly')}</p>
      </Card>
    );
  }

  const stopped = ['interrupted', 'stopped_at_plan_limit'].includes(
    String(detailsOf(commitMutation.error).code)
  );

  return (
    <Card>
      {header}
      <div className="space-y-4">
        <Button
          variant="secondary"
          leftIcon={<ArrowUpTrayIcon className="h-5 w-5" aria-hidden="true" />}
          onClick={() => fileInputRef.current?.click()}
        >
          {t(file ? 'archiveImport.chooseAnother' : 'archiveImport.chooseFile')}
        </Button>
        {/* Not rendered: the button above is the one control, for pointer and
            keyboard alike. A 1px sr-only input is a second, undersized control
            (responsive-ux.spec.ts's 24px target floor). */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label={t('archiveImport.chooseFile')}
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            if (chosen) void handleFile(chosen);
          }}
        />

        {fileError && <Alert variant="error">{fileError}</Alert>}

        {file && !result && (
          <div className="space-y-3">
            <label className="block">
              <span className="label">{t('archiveImport.chooseHousehold')}</span>
              <select
                className="input"
                value={sourceId}
                onChange={(e) => {
                  setSourceId(e.target.value);
                  setPreview(null);
                }}
              >
                {file.households.map((h) => (
                  <option key={h.id} value={h.id}>
                    {t('archiveImport.householdOption', {
                      name: h.name,
                      plants: h.plants,
                      tasks: h.tasks,
                    })}
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={check} isLoading={previewMutation.isPending}>
              {t('archiveImport.check')}
            </Button>
          </div>
        )}

        {previewMutation.isError && (
          <Alert variant="error">{serverError(previewMutation.error)}</Alert>
        )}
        {preview && !result && (
          <ArchivePreview
            preview={preview}
            onRestore={restore}
            restoring={commitMutation.isPending}
            again={stopped || preview.target.state === 'resumable'}
          />
        )}
        {commitMutation.isError && (
          <Alert variant="error">{serverError(commitMutation.error)}</Alert>
        )}
        {result && (
          <Alert variant="success">
            {result.status === 'already_imported'
              ? t('archiveImport.alreadyImported')
              : t('archiveImport.done', {
                  plants: result.imported.plants,
                  tasks: result.imported.tasks,
                  name: preview?.source.name ?? '',
                })}
          </Alert>
        )}
      </div>
    </Card>
  );
}

function ArchivePreview({
  preview,
  onRestore,
  restoring,
  again,
}: {
  preview: ArchiveImportPreview;
  onRestore: () => void;
  restoring: boolean;
  again: boolean;
}) {
  const { t } = useTranslation();
  const { counts, notRestored: missing, planLimit, target } = preview;
  const line = (key: string, n: number) =>
    n > 0 && <li>{t(`archiveImport.notRestored.${key}`, { n })}</li>;
  const refusal = (state: 'not_empty' | 'other_archive') =>
    t(`archiveImport.errors.${ERROR_KEYS[state]}`);

  return (
    <section
      className="space-y-3 rounded-lg border border-primary-100 p-4 text-sm"
      aria-label={t('archiveImport.preview.title')}
    >
      <h3 className="font-medium text-ink">{t('archiveImport.preview.title')}</h3>
      <p className="text-gray-600">
        {t('archiveImport.preview.from', {
          name: preview.source.name,
          date: formatDate(preview.source.exportedAt) || '—',
        })}
      </p>
      <p className="text-gray-600">
        {t(
          `archiveImport.preview.manifest.${preview.source.manifest === 'verified' ? 'verified' : 'absent'}`
        )}
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          {t('archiveImport.preview.plants', {
            n: counts.plants,
            active: counts.activePlants,
            past: counts.pastPlants,
            archived: counts.archivedPlants,
          })}
        </li>
        <li>{t('archiveImport.preview.tasks', { n: counts.tasks })}</li>
        {counts.lineageLinks > 0 && (
          <li>{t('archiveImport.preview.lineage', { n: counts.lineageLinks })}</li>
        )}
      </ul>

      <h3 className="font-medium text-ink">{t('archiveImport.notRestored.title')}</h3>
      <ul className="list-disc space-y-1 pl-5">
        {line('photos', missing.photos)}
        {line('spaces', missing.spaceAssignments)}
        {missing.unassignedTasks > 0 && (
          <li>
            {t('archiveImport.notRestored.unassigned', { n: missing.unassignedTasks })}
            <ul className="list-[circle] pl-5">
              {missing.reinvite.map((person, i) => (
                <li key={i}>
                  {t('archiveImport.notRestored.person', {
                    name: person.name ?? t('archiveImport.notRestored.unnamed'),
                    n: person.tasks,
                  })}
                </li>
              ))}
            </ul>
          </li>
        )}
        {line('orphanTasks', missing.orphanTasks)}
        {line('brokenLineage', missing.brokenLineage)}
        {line('species', missing.unverifiedSpeciesNames)}
        {['history', 'members', 'billing', 'links'].map((key) => (
          <li key={key}>{t(`archiveImport.notRestored.${key}`)}</li>
        ))}
      </ul>

      {!planLimit.fits && (
        <Alert variant="error">
          {t('archiveImport.errors.overLimit', {
            active: counts.activePlants,
            plan: planLimit.planName,
            limit: planLimit.limit,
          })}
        </Alert>
      )}
      {(target.state === 'not_empty' || target.state === 'other_archive') && (
        <Alert variant="warning">
          <p>{refusal(target.state)}</p>
          <RouterLink
            to="/onboarding?mode=add"
            className="mt-2 inline-block font-medium text-primary-700 underline"
          >
            {t('archiveImport.createHousehold')}
          </RouterLink>
        </Alert>
      )}
      {target.state === 'already_imported' && (
        <Alert variant="info">{t('archiveImport.alreadyImported')}</Alert>
      )}
      {target.state === 'resumable' && <Alert variant="info">{t('archiveImport.resumable')}</Alert>}

      {preview.canImport && (
        <Button onClick={onRestore} isLoading={restoring}>
          {t(again ? 'archiveImport.restoreAgain' : 'archiveImport.restore')}
        </Button>
      )}
    </section>
  );
}
