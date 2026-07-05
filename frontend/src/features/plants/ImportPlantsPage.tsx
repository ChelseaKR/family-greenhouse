import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeftIcon, ArrowUpTrayIcon, DocumentArrowUpIcon } from '@heroicons/react/24/outline';
import { plantService, ImportPlantData, ImportPlantsResponse } from '@/services/plantService';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import {
  detectFileKind,
  parseImportFile,
  ImportParseError,
  ParsedRow,
  IMPORT_BATCH_SIZE,
} from './importParse';

/**
 * Bulk CSV/JSON import. Flow: pick/drop a file → parse + validate
 * client-side → preview with per-row states → submit valid rows in batches
 * of ≤100 → summary (with an upgrade prompt when the plan cap stopped the
 * batch — partial success is the API contract, not all-or-nothing).
 */
export function ImportPlantsPage() {
  useDocumentTitle('Import plants');
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [summary, setSummary] = useState<ImportPlantsResponse | null>(null);

  const validRows = rows?.filter((r) => r.data !== undefined) ?? [];

  const importMutation = useMutation({
    mutationFn: async (plants: ImportPlantData[]) => {
      // The endpoint caps a request at 100 plants; submit in batches and
      // merge the summaries. A plan-limit hit stops later batches — they
      // would only burn rate-limit budget to be told the same thing.
      const merged: ImportPlantsResponse = {
        results: [],
        created: 0,
        skipped: 0,
        planLimitHit: false,
      };
      for (let offset = 0; offset < plants.length; offset += IMPORT_BATCH_SIZE) {
        const batch = plants.slice(offset, offset + IMPORT_BATCH_SIZE);
        const res = await plantService.importPlants(batch);
        merged.results.push(...res.results.map((r) => ({ ...r, index: r.index + offset })));
        merged.created += res.created;
        merged.skipped += res.skipped;
        if (res.planLimitHit) {
          merged.planLimitHit = true;
          const remaining = plants.length - (offset + batch.length);
          merged.skipped += remaining;
          break;
        }
      }
      return merged;
    },
    onSuccess: (res) => {
      setSummary(res);
      queryClient.invalidateQueries({ queryKey: ['plants', householdId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', householdId] });
    },
  });

  function reset() {
    setRows(null);
    setFileName(null);
    setParseError(null);
    setSummary(null);
    importMutation.reset();
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleFile(file: File) {
    reset();
    const kind = detectFileKind(file);
    if (!kind) {
      setParseError(t('importPlants.errors.unsupportedType'));
      return;
    }
    setFileName(file.name);
    try {
      const text = await file.text();
      setRows(parseImportFile(kind, text));
    } catch (err) {
      if (err instanceof ImportParseError) {
        setParseError(t(`importPlants.errors.${err.reason}`));
      } else {
        setParseError(t('importPlants.errors.readFailed'));
      }
      setFileName(null);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  // ---- Results view ----
  if (summary) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader t={t} />
        <Card>
          <CardHeader title={t('importPlants.results.title')} />
          <div className="space-y-4">
            <Alert variant={summary.created > 0 ? 'success' : 'warning'}>
              {t('importPlants.results.created', { count: summary.created })}
              {summary.skipped > 0 && (
                <> · {t('importPlants.results.skipped', { count: summary.skipped })}</>
              )}
            </Alert>
            {summary.planLimitHit && (
              <Alert variant="warning">
                <span>{t('importPlants.results.planLimit')}</span>{' '}
                <Link to="/settings/billing" className="font-medium underline">
                  {t('importPlants.results.upgradeCta')}
                </Link>
              </Alert>
            )}
            <div className="flex flex-wrap gap-3">
              <Button onClick={reset} variant="secondary">
                {t('importPlants.startOver')}
              </Button>
              <Link to="/plants">
                <Button>{t('importPlants.results.viewPlants')}</Button>
              </Link>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader t={t} />

      <Card>
        <CardHeader title={t('importPlants.title')} description={t('importPlants.description')} />

        {parseError && (
          <Alert variant="error" className="mb-4">
            {parseError}
          </Alert>
        )}

        {/* Drag-and-drop is a pointer-only enhancement; the fully accessible
            path is the file-picker button + input inside this region, so the
            wrapper itself is intentionally not focusable/interactive. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={onDrop}
          className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            isDragOver ? 'border-primary-500 bg-primary-50' : 'border-primary-200'
          }`}
        >
          <DocumentArrowUpIcon className="h-10 w-10 text-primary-300" aria-hidden="true" />
          <p className="text-sm text-gray-600">{t('importPlants.dropHint')}</p>
          <Button
            variant="secondary"
            leftIcon={<ArrowUpTrayIcon className="h-5 w-5" aria-hidden="true" />}
            onClick={() => fileInputRef.current?.click()}
          >
            {t('importPlants.browse')}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            className="sr-only"
            aria-label={t('importPlants.browse')}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          {fileName && <p className="text-xs text-gray-600">{fileName}</p>}
        </div>
        <p className="mt-3 text-xs text-gray-600">{t('importPlants.formatHelp')}</p>
      </Card>

      {rows && (
        <Card>
          <CardHeader
            title={t('importPlants.preview.title')}
            description={t('importPlants.preview.summary', {
              valid: validRows.length,
              total: rows.length,
            })}
          />
          {importMutation.isError && (
            <Alert variant="error" className="mb-4">
              {getErrorMessage(importMutation.error)}
            </Alert>
          )}
          <div className="max-h-96 overflow-auto">
            <table className="min-w-full divide-y divide-primary-100/60 text-sm">
              <thead>
                <tr className="text-left text-xs font-medium uppercase tracking-wide text-gray-600">
                  <th className="px-3 py-2">{t('importPlants.preview.colRow')}</th>
                  <th className="px-3 py-2">{t('importPlants.preview.colStatus')}</th>
                  <th className="px-3 py-2">{t('importPlants.preview.colName')}</th>
                  <th className="px-3 py-2">{t('importPlants.preview.colSpecies')}</th>
                  <th className="px-3 py-2">{t('importPlants.preview.colLocation')}</th>
                  <th className="px-3 py-2">{t('importPlants.preview.colTags')}</th>
                  <th className="px-3 py-2">{t('importPlants.preview.colTasks')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary-100/50">
                {rows.map((row) => (
                  <tr key={row.index} className={row.data ? '' : 'bg-red-50'}>
                    <td className="px-3 py-2 text-gray-500">{row.index + 1}</td>
                    <td className="px-3 py-2">
                      {row.data ? (
                        <span className="inline-flex rounded-full bg-primary-100 px-2 py-0.5 text-xs font-medium text-primary-800">
                          {t('importPlants.preview.ready')}
                        </span>
                      ) : (
                        <div>
                          <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                            {t('importPlants.preview.hasErrors')}
                          </span>
                          <ul className="mt-1 space-y-0.5 text-xs text-red-700">
                            {row.errors.map((err, i) => (
                              <li key={i}>
                                <span className="font-mono">{err.field}</span>: {err.message}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 font-medium text-gray-900">{row.displayName}</td>
                    <td className="px-3 py-2 text-gray-600">{row.data?.species ?? ''}</td>
                    <td className="px-3 py-2 text-gray-600">{row.data?.location ?? ''}</td>
                    <td className="px-3 py-2 text-gray-600">{row.data?.tags?.join(', ') ?? ''}</td>
                    <td className="px-3 py-2 text-gray-600">{row.data?.tasks?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {validRows.length < rows.length && (
            <p className="mt-3 text-xs text-gray-600">
              {t('importPlants.preview.invalidRowsSkipped')}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-3">
            <Button variant="secondary" onClick={reset} disabled={importMutation.isPending}>
              {t('importPlants.startOver')}
            </Button>
            <Button
              onClick={() => importMutation.mutate(validRows.map((r) => r.data!))}
              disabled={validRows.length === 0}
              isLoading={importMutation.isPending}
            >
              {importMutation.isPending
                ? t('importPlants.importing')
                : t('importPlants.submit', { count: validRows.length })}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function PageHeader({ t }: { t: (key: string) => string }) {
  return (
    <Link
      to="/plants"
      className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
    >
      <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
      {t('plants.backToPlants')}
    </Link>
  );
}
