import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { searchSpecies, SpeciesEntry, speciesCatalog } from '@/utils/species';
import { speciesService, type PerenualSpeciesSummary } from '@/services/speciesService';

interface SpeciesComboboxProps {
  value: string;
  onChange: (value: string) => void;
  /** When the user picks a catalog entry, called with both common + scientific so the form can mirror them. */
  onPick?: (entry: SpeciesEntry) => void;
  /** When the user picks a Perenual-backed suggestion, the parent can latch
   *  the species id so it's persisted on the plant for downstream care
   *  enrichment. Static-catalog picks pass `null`. */
  onPerenualPick?: (id: number | null) => void;
  label?: string;
  error?: string;
  helperText?: string;
  placeholder?: string;
}

/** Finds the Perenual result (if any) matching `val` by scientific or common
 *  name, shared by the input's synchronous onChange check and the effect
 *  that re-checks once debounced results land. */
function matchPerenual(results: PerenualSpeciesSummary[] | undefined, val: string): number | null {
  const hit = (results ?? []).find(
    (r) =>
      r.scientificName.toLowerCase() === val.toLowerCase() ||
      r.commonName.toLowerCase() === val.toLowerCase()
  );
  return hit ? hit.id : null;
}

/**
 * Free-text species input backed by the native <datalist> element. Browsers
 * render their own dropdown UI and handle keyboard nav + a11y.
 *
 * Suggestions come from two sources:
 *  - The static catalog (`utils/species`) — instant, offline, ~245 entries.
 *  - Perenual species search — broader coverage (10k+ species), debounced
 *    300ms, falls back to static-only if the API is disabled, errored, or
 *    over budget. We never block on the network: the static results render
 *    immediately while Perenual loads in.
 *
 * `onPick` fires whenever the typed value matches an entry exactly — useful
 * for autofilling related fields (e.g. plant name).
 */
export function SpeciesCombobox({
  value,
  onChange,
  onPick,
  onPerenualPick,
  label = 'Species',
  error,
  helperText,
  placeholder = 'e.g. Monstera deliciosa',
}: SpeciesComboboxProps) {
  const id = useId();
  const listId = `${id}-list`;
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;

  // Debounce the query that gets sent to Perenual — typeahead spam burns
  // through our daily budget without offering better suggestions.
  const [debouncedQuery, setDebouncedQuery] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(value), 300);
    return () => clearTimeout(t);
  }, [value]);

  const { data: perenual } = useQuery({
    queryKey: ['species', 'search', debouncedQuery.trim().toLowerCase()],
    queryFn: () => speciesService.search(debouncedQuery),
    enabled: debouncedQuery.trim().length >= 2,
    staleTime: 5 * 60 * 1000,
  });

  // The debounced network results only reflect the exact keystroke that was
  // typed when onChange fired — 300ms later, once Perenual actually answers,
  // nothing re-checks it against what's currently typed. Re-run the same
  // match here whenever fresh results arrive.
  //
  // Gate on `perenual` actually being loaded (not just changed): firing this
  // while a query is merely in flight would report a false `null` for a
  // value that already has a confirmed match (e.g. a plant's previously-
  // linked species, shown on mount before the first search round-trip
  // completes) — the onChange handler already covers the "unconfirmed yet"
  // case for live edits.
  useEffect(() => {
    if (!onPerenualPick || perenual === undefined) return;
    onPerenualPick(matchPerenual(perenual.results, value));
  }, [perenual, value, onPerenualPick]);

  // Local catalog suggestions are instant; Perenual layers on top, deduped by
  // scientific name to avoid showing the same plant twice.
  //
  // When the input is empty the user is browsing — show the full local
  // catalog (~245 entries) so they can scroll. While they're typing we cap
  // the merged set at 24 to keep the native dropdown snappy.
  const merged = useMemo(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return speciesCatalog;

    const local = searchSpecies(value, 12);
    // `perenual` reflects debouncedQuery, which lags the live input by
    // 300ms — while a request for the current text is in flight (or hasn't
    // started), remote still holds the PREVIOUS query's results. Only mix
    // them in once the query that produced them matches what's now typed.
    const queryIsCurrent = debouncedQuery.trim().toLowerCase() === value.trim().toLowerCase();
    const remote: SpeciesEntry[] = queryIsCurrent
      ? (perenual?.results ?? []).map((r: PerenualSpeciesSummary) => ({
          common: r.commonName,
          scientific: r.scientificName,
        }))
      : [];
    const seen = new Set<string>();
    const out: SpeciesEntry[] = [];
    for (const entry of [...local, ...remote]) {
      const key = entry.scientific.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
      if (out.length >= 24) break;
    }
    return out;
  }, [value, perenual, debouncedQuery]);

  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        list={listId}
        type="text"
        autoComplete="off"
        spellCheck={false}
        className={clsx('input', error && 'input-error')}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next);
          if (onPick) {
            const exact = speciesCatalog.find(
              (entry) =>
                entry.scientific.toLowerCase() === next.toLowerCase() ||
                entry.common.toLowerCase() === next.toLowerCase()
            );
            if (exact) onPick(exact);
          }
          if (onPerenualPick) {
            // Pass the id when we recognize the value, otherwise null so a
            // user backspacing away from a known species clears the link.
            // `perenual` here is almost always stale (debounced 300ms behind
            // `next`) — the effect above re-checks once fresh results land.
            onPerenualPick(matchPerenual(perenual?.results, next));
          }
        }}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : helperText ? helperId : undefined}
      />
      <datalist id={listId}>
        {merged.map((entry) => (
          // The visible label is the scientific name (the canonical value we
          // store); the `label` attribute lets browsers like Firefox render
          // the common name beside it.
          // The catalog can hold two entries with the same scientific name
          // (e.g. "Bell pepper" / "Hot pepper" are both Capsicum annuum), so
          // the key needs the common name too to stay unique.
          <option
            key={`${entry.scientific}|${entry.common}`}
            value={entry.scientific}
            label={entry.common}
          />
        ))}
      </datalist>
      {error ? (
        <p id={errorId} className="error-message">
          {error}
        </p>
      ) : helperText ? (
        <p id={helperId} className="mt-1 text-sm text-gray-500">
          {helperText}
        </p>
      ) : null}
    </div>
  );
}
