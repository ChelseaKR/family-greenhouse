/**
 * Locale-coverage measurement for the i18n string catalogs.
 *
 * "Coverage" is the share of leaf strings in a locale that have actually been
 * translated — i.e. that differ from the English source. A key that is present
 * but whose value is byte-for-byte identical to English is treated as an
 * untranslated placeholder (the normal state of a seed locale), not as
 * coverage. This intentionally undercounts the handful of strings that are
 * legitimately identical across languages (proper nouns, "OK"); erring toward
 * "not enough coverage" is the safe bias for a gate that decides whether a
 * locale is ready to ship.
 *
 * Used by `tests/unit/i18n/localeCoverage.test.ts` to refuse enabling a locale
 * below the coverage bar — the guard called for in the quality-audit risk
 * register (#3 "localization content gap").
 */

function flatten(
  tree: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {}
): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out[path] = value;
    } else if (value && typeof value === 'object') {
      flatten(value as Record<string, unknown>, path, out);
    }
  }
  return out;
}

export interface CoverageReport {
  /** Number of leaf string keys in the English source. */
  totalKeys: number;
  /** Keys present in English but absent from the target locale. */
  missingKeys: string[];
  /** Keys present in the target but whose value still equals English. */
  untranslatedKeys: string[];
  /** Keys with a value that differs from English (genuinely translated). */
  translatedKeys: number;
  /** translatedKeys / totalKeys, in [0, 1]. */
  coverage: number;
}

export function localeCoverage(
  source: Record<string, unknown>,
  target: Record<string, unknown>
): CoverageReport {
  const src = flatten(source);
  const tgt = flatten(target);
  const keys = Object.keys(src);

  const missingKeys: string[] = [];
  const untranslatedKeys: string[] = [];
  for (const key of keys) {
    if (!(key in tgt)) {
      missingKeys.push(key);
    } else if (tgt[key] === src[key]) {
      untranslatedKeys.push(key);
    }
  }

  const translatedKeys = keys.length - missingKeys.length - untranslatedKeys.length;
  return {
    totalKeys: keys.length,
    missingKeys,
    untranslatedKeys,
    translatedKeys,
    coverage: keys.length === 0 ? 1 : translatedKeys / keys.length,
  };
}
