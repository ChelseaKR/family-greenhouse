import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ArrowLeftIcon, ArrowUpTrayIcon, DocumentArrowUpIcon } from '@heroicons/react/24/outline';
import { plantService, ImportPlantData, ImportPlantsResponse } from '@/services/plantService';
import {
  billingService,
  readOutcome,
  resolvePlanUsage,
  type PlanUsageDetail,
  type ReadOutcome,
} from '@/services/billingService';
import { getErrorMessage } from '@/services/api';
import { Button } from '@/components/Button';
import { Card, CardHeader } from '@/components/Card';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import {
  applyMapping,
  detectFileKind,
  parseJsonImport,
  readCsvTable,
  sampleValue,
  suggestMapping,
  unmatchedColumns,
  ImportParseError,
  MAPPING_TARGETS,
  IMPORT_BATCH_SIZE,
  type ColumnMapping,
  type CsvTable,
  type MappingTarget,
  type ParsedRow,
  type ParsedRowError,
} from './importParse';

/**
 * Bulk CSV/JSON import, open to every household member. Flow: pick/drop a file →
 * (CSV only) match its columns → preview with per-row states, every column
 * or field that will NOT be imported listed, and the plan's remaining room
 * applied row by row → confirm → submit the admitted rows in batches of ≤100
 * → summary.
 *
 * There is no Planta, Greg or Vera adapter: none of them documents an export
 * file (see the "Column matching" note in importParse.ts), and the upload
 * card says so in plain words rather than implying support that isn't there.
 */
export function ImportPlantsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('importPlants.title'));
  return <ImportFlow />;
}

type Source =
  | { kind: 'csv'; table: CsvTable; mapping: ColumnMapping }
  | { kind: 'json'; rows: ParsedRow[]; notImported: string[] };

/**
 * How many more plants the household's plan admits, as a settled read (ADR
 * 0010). `unknown` is its own answer: an unreadable counter is not evidence
 * that the whole file fits, so the page says it could not check instead of
 * previewing every row as importable.
 */
type ImportRoom =
  | { kind: 'checking' }
  | { kind: 'unknown' }
  | { kind: 'unlimited' }
  | { kind: 'limited'; room: number };

function resolveImportRoom(outcome: ReadOutcome, usage?: PlanUsageDetail): ImportRoom {
  if (outcome === 'loading') return { kind: 'checking' };
  if (outcome === 'unavailable' || !usage) return { kind: 'unknown' };
  if (usage.maxPlants === null) return { kind: 'unlimited' };
  if (typeof usage.plantCount !== 'number' || !Number.isFinite(usage.plantCount)) {
    return { kind: 'unknown' };
  }
  return { kind: 'limited', room: Math.max(0, usage.maxPlants - usage.plantCount) };
}

function ImportFlow() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const householdId = useActiveHouseholdId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [source, setSource] = useState<Source | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [summary, setSummary] = useState<ImportPlantsResponse | null>(null);
  // What was actually sent, so a server row index maps back to a name, and
  // how many ready rows were held back as over the plan's limit.
  const [submittedRows, setSubmittedRows] = useState<ParsedRow[]>([]);
  const [heldOverCap, setHeldOverCap] = useState(0);

  const subQuery = useQuery({
    // Same key as Settings → Plan status: the backend resolves the ACTIVE
    // household, so the key embeds it.
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: !!householdId,
  });
  const room = resolveImportRoom(readOutcome(subQuery), resolvePlanUsage(subQuery.data));

  const rows = useMemo<ParsedRow[] | null>(() => {
    if (!source) return null;
    if (source.kind === 'json') return source.rows;
    if (source.mapping.name === null) return null;
    return applyMapping(source.table, source.mapping);
  }, [source]);

  const columnName = (table: CsvTable, column: number) =>
    table.headers[column] || t('importPlants.mapping.unnamedColumn', { n: column + 1 });

  const notImported: string[] = !source
    ? []
    : source.kind === 'json'
      ? source.notImported
      : unmatchedColumns(source.table, source.mapping).map((i) => columnName(source.table, i));

  const validRows = rows?.filter((r) => r.data !== undefined) ?? [];
  // File order decides who fits: the first `room` ready rows are admitted,
  // the rest are shown as over the limit and never sent.
  const admittedRows = room.kind === 'limited' ? validRows.slice(0, room.room) : validRows;
  const overCapRows = validRows.slice(admittedRows.length);
  const overCapIndexes = new Set(overCapRows.map((r) => r.index));

  const showMapping = source?.kind === 'csv' && (mappingOpen || source.mapping.name === null);

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
      queryClient.invalidateQueries({ queryKey: ['subscription', householdId] });
    },
  });

  function reset() {
    setSource(null);
    setMappingOpen(false);
    setFileName(null);
    setParseError(null);
    setSummary(null);
    setSubmittedRows([]);
    setHeldOverCap(0);
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
      if (kind === 'json') {
        setSource({ kind: 'json', ...parseJsonImport(text) });
      } else {
        const table = readCsvTable(text);
        const mapping = suggestMapping(table.headers);
        setSource({ kind: 'csv', table, mapping });
        // Our own export matches itself; anything else starts at the
        // matching step, because only the person knows their columns.
        setMappingOpen(mapping.name === null);
      }
    } catch (err) {
      if (err instanceof ImportParseError) {
        setParseError(t(`importPlants.errors.${err.reason}`));
      } else {
        setParseError(t('importPlants.errors.readFailed'));
      }
      setFileName(null);
    }
  }

  function setTarget(target: MappingTarget, value: string) {
    setSource((prev) =>
      prev?.kind === 'csv'
        ? { ...prev, mapping: { ...prev.mapping, [target]: value === '' ? null : Number(value) } }
        : prev
    );
  }

  function submit() {
    setSubmittedRows(admittedRows);
    setHeldOverCap(overCapRows.length);
    importMutation.mutate(admittedRows.map((r) => r.data!));
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
            {summary.skipped > 0 && (
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {t('importPlants.results.skippedRowsTitle')}
                </p>
                <ul className="mt-2 space-y-2">
                  {summary.results
                    .filter((result) => result.status === 'skipped')
                    .map((result) => {
                      // result.index is the row's position in the SUBMITTED
                      // batch, not in the file: invalid and over-limit rows
                      // are never sent, so submittedRows is the lookup.
                      const row = submittedRows[result.index];
                      return (
                        <li key={result.index} className="rounded-md bg-red-50 px-3 py-2 text-sm">
                          <p className="font-medium text-gray-900">
                            {t('importPlants.results.skippedRowLabel', {
                              row: (row?.index ?? result.index) + 1,
                              name: row?.displayName ?? `#${result.index + 1}`,
                            })}
                          </p>
                          {result.error && <p className="text-red-700">{result.error}</p>}
                        </li>
                      );
                    })}
                </ul>
              </div>
            )}
            {heldOverCap > 0 && (
              <Alert variant="warning">
                {t('importPlants.results.overCapNotSent', { count: heldOverCap })}
              </Alert>
            )}
            {summary.planLimitHit && (
              <Alert variant="warning">
                <span>{t('importPlants.results.planLimit')}</span>
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
        <div className="mt-4 rounded-md bg-primary-50 p-3 text-sm" data-testid="other-apps-note">
          <p className="font-medium text-gray-900">{t('importPlants.otherApps.title')}</p>
          <p className="mt-1 text-gray-700">{t('importPlants.otherApps.body')}</p>
        </div>
      </Card>

      {showMapping && source?.kind === 'csv' && (
        <Card>
          <CardHeader
            title={t('importPlants.mapping.title')}
            description={t('importPlants.mapping.description')}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {MAPPING_TARGETS.map((target) => {
              const id = `import-map-${target}`;
              const column = source.mapping[target];
              const sample = column === null ? undefined : sampleValue(source.table, column);
              return (
                <div key={target}>
                  <label htmlFor={id} className="label">
                    {t(`importPlants.mapping.targets.${target}`)}
                  </label>
                  <select
                    id={id}
                    className="input"
                    value={column === null ? '' : String(column)}
                    onChange={(e) => setTarget(target, e.target.value)}
                  >
                    <option value="">{t('importPlants.mapping.notInFile')}</option>
                    {source.table.headers.map((_, i) => (
                      <option key={i} value={String(i)}>
                        {columnName(source.table, i)}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-600">
                    {t(`importPlants.mapping.hints.${target}`)}
                  </p>
                  {sample !== undefined && (
                    <p className="mt-0.5 truncate text-xs text-gray-500">
                      {t('importPlants.mapping.sample', { value: sample })}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <NotImportedList t={t} kind="csv" items={notImported} />
          <div className="mt-4 flex flex-wrap justify-end gap-3">
            <Button variant="secondary" onClick={reset}>
              {t('importPlants.startOver')}
            </Button>
            <Button onClick={() => setMappingOpen(false)} disabled={source.mapping.name === null}>
              {t('importPlants.mapping.continue')}
            </Button>
          </div>
        </Card>
      )}

      {rows && !showMapping && (
        <Card>
          <CardHeader
            title={t('importPlants.preview.title')}
            description={t('importPlants.preview.summary', {
              valid: validRows.length,
              total: rows.length,
            })}
            action={
              source?.kind === 'csv' ? (
                <Button variant="secondary" size="sm" onClick={() => setMappingOpen(true)}>
                  {t('importPlants.mapping.change')}
                </Button>
              ) : undefined
            }
          />
          {importMutation.isError && (
            <Alert variant="error" className="mb-4">
              {getErrorMessage(importMutation.error)}
            </Alert>
          )}
          <NotImportedList t={t} kind={source?.kind ?? 'json'} items={notImported} />
          <RoomNotice t={t} room={room} ready={validRows.length} admitted={admittedRows.length} />
          <div className="mt-4 max-h-96 overflow-auto">
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
                        overCapIndexes.has(row.index) ? (
                          <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                            {t('importPlants.preview.overCap')}
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full bg-primary-100 px-2 py-0.5 text-xs font-medium text-primary-800">
                            {t('importPlants.preview.ready')}
                          </span>
                        )
                      ) : (
                        <div>
                          <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                            {t('importPlants.preview.hasErrors')}
                          </span>
                          <ul className="mt-1 space-y-0.5 text-xs text-red-700">
                            {row.errors.map((err, i) => (
                              <li key={i}>
                                <RowError t={t} error={err} />
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
              onClick={submit}
              disabled={admittedRows.length === 0 || room.kind === 'checking'}
              isLoading={importMutation.isPending}
            >
              {importMutation.isPending
                ? t('importPlants.importing')
                : t('importPlants.submit', { count: admittedRows.length })}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function RowError({ t, error }: { t: TFunction; error: ParsedRowError }) {
  if (error.code) {
    return <>{t(`importPlants.rowErrors.${error.code}`, { value: error.message })}</>;
  }
  return (
    <>
      <span className="font-mono">{error.field}</span>: {error.message}
    </>
  );
}

/** Everything in the file that will not be imported, listed by name. */
function NotImportedList({
  t,
  kind,
  items,
}: {
  t: TFunction;
  kind: 'csv' | 'json';
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4 rounded-md bg-gray-50 p-3 text-sm" data-testid="not-imported">
      <p className="font-medium text-gray-900">{t('importPlants.notImported.title')}</p>
      <p className="mt-1 text-gray-700">
        {t(`importPlants.notImported.${kind}`, { count: items.length })}
      </p>
      <p className="mt-1 break-words font-mono text-xs text-gray-700">{items.join(', ')}</p>
    </div>
  );
}

/** The plan's remaining room, stated before anything is sent. */
function RoomNotice({
  t,
  room,
  ready,
  admitted,
}: {
  t: TFunction;
  room: ImportRoom;
  ready: number;
  admitted: number;
}) {
  if (ready === 0) return null;
  if (room.kind === 'checking') {
    return <p className="mt-4 text-sm text-gray-600">{t('importPlants.room.checking')}</p>;
  }
  if (room.kind === 'unknown') {
    return (
      <Alert variant="warning" className="mt-4">
        {t('importPlants.room.unknown')}
      </Alert>
    );
  }
  if (room.kind === 'unlimited' || admitted === ready) return null;
  const seePlan = (
    <Link to="/settings/billing" className="font-medium underline">
      {t('importPlants.room.seePlan')}
    </Link>
  );
  if (room.room === 0) {
    return (
      <Alert variant="warning" title={t('importPlants.room.fullTitle')} className="mt-4">
        <p>{t('importPlants.room.fullBody')}</p>
        <p className="mt-2">{seePlan}</p>
      </Alert>
    );
  }
  return (
    <Alert
      variant="warning"
      title={t('importPlants.room.overTitle', { admitted, ready })}
      className="mt-4"
    >
      <p>{t('importPlants.room.overBody', { count: room.room })}</p>
      <p className="mt-2">{seePlan}</p>
    </Alert>
  );
}

function PageHeader({ t }: { t: TFunction }) {
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
