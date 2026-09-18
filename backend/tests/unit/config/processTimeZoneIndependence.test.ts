import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No backend answer may depend on the zone the process happens to run in
 * (#342).
 *
 * Until this test, several did. `completeTask`'s next-due math, the snooze,
 * every "due within N days" cutoff, `getDailyCompletionCounts`' day buckets,
 * the analytics window, the seasonal-cadence month and the year-in-review
 * default year were all written with the process-LOCAL `Date` accessors
 * (`setDate`, `setHours`, `getMonth`, `getFullYear`, `new Date(y, m, d)`).
 * They were right only because the Lambdas run `TZ=UTC`, which #590 pinned in
 * `infrastructure/modules/api/main.tf` and `lambdaTimeZone.test.ts` checks.
 * ADR 0025 says in terms that the pin "makes the dependency safe to rest on;
 * it does not remove it".
 *
 * This removes it. Each of those expressions is now its explicit `UTC`
 * counterpart, which under `TZ=UTC` returns exactly what it returned before —
 * no answer changes in production — and under any other zone returns the same
 * thing, instead of silently shifting. The pin stays as defence in depth.
 *
 * ## Why a source scan
 *
 * No unit test can observe a zone dependence by running: `vitest.config.ts`
 * pins this process to UTC (and assigning `TZ` inside a worker thread is
 * inert), so every zone-dependent expression passes here by construction.
 * What a test CAN observe is whether the expression exists. The same approach
 * as `lambdaTimeZone.test.ts` and the transcription check in `dueDay.test.ts`.
 *
 * Deliberately out of scope: calendar math in a NAMED zone (`Intl` with a
 * `timeZone`, `dueDay.ts`), which is the product's actual zone model, and the
 * frontend, whose browser-local day is ADR 0025 phase 6's decision.
 */

const BACKEND_SRC = new URL('../../../src/', import.meta.url).pathname;

/**
 * Calls whose answer depends on the process zone. The `UTC` variants
 * (`setUTCDate`, `getUTCMonth`, …) do not match: the name must follow the dot
 * directly.
 */
const PROCESS_LOCAL_ACCESSOR =
  /\.(?:get|set)(?:FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)\(|\.getTimezoneOffset\(|\.to(?:Date|Time)String\(/g;

/**
 * Where process-local time is the point, with the reason. Keyed by path
 * relative to `backend/src`, valued by the exact line that is allowed, so a
 * second use in the same file is not waved through.
 */
const ALLOWED: Record<string, string[]> = {
  // Seed data for the local store-screenshot demo. "Due at 09:00" is meant to
  // read as 09:00 on the machine taking the screenshot; it never runs in a
  // Lambda and never computes a due date for a real household.
  'local-server-store-demo.ts': [
    'when.setDate(when.getDate() + days);',
    'when.setHours(hour, 0, 0, 0);',
  ],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

/** Strip `//` line comments and the body of block comments, keeping line
 *  numbers, so prose that NAMES an accessor is not mistaken for a call. */
function codeOnly(source: string): string[] {
  let inBlock = false;
  return source.split('\n').map((line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) return out;
        inBlock = false;
        i = end + 2;
        continue;
      }
      const block = line.indexOf('/*', i);
      const lineComment = line.indexOf('//', i);
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        return out + line.slice(i, lineComment);
      }
      if (block === -1) return out + line.slice(i);
      out += line.slice(i, block);
      inBlock = true;
      i = block + 2;
    }
    return out;
  });
}

/** `new Date(a, b, …)` with more than one argument builds a LOCAL wall-clock
 *  time. Found by walking to the matching paren and looking for a top-level
 *  comma, since the arguments can themselves contain calls. */
function localDateConstructors(line: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const start = line.indexOf('new Date(', from);
    if (start === -1) return found;
    let depth = 0;
    let topLevelComma = false;
    let end = start + 'new Date('.length;
    for (; end < line.length; end++) {
      const ch = line[end];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) topLevelComma = true;
    }
    if (topLevelComma) found.push(line.slice(start, end + 1));
    from = start + 1;
  }
}

function findProcessLocalDateMath(): string[] {
  const findings: string[] = [];
  for (const file of sourceFiles(BACKEND_SRC)) {
    const rel = relative(BACKEND_SRC, file);
    const allowed = ALLOWED[rel] ?? [];
    codeOnly(readFileSync(file, 'utf8')).forEach((line, index) => {
      const hits = [...(line.match(PROCESS_LOCAL_ACCESSOR) ?? []), ...localDateConstructors(line)];
      if (hits.length === 0) return;
      if (allowed.includes(line.trim())) return;
      findings.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  return findings;
}

describe('backend date math does not depend on the process zone (#342)', () => {
  it('uses no process-local Date accessor or local-time constructor outside the allowlist', () => {
    expect(
      findProcessLocalDateMath(),
      'Use the UTC accessor (setUTCDate, getUTCMonth, Date.UTC(…), …) or a named zone via ' +
        '`services/dueDay.ts`. The process zone is UTC in production only because ' +
        'infrastructure pins it; an answer that depends on it changes the moment that pin does.'
    ).toEqual([]);
  });

  it('every allowlisted line still exists, so the allowlist cannot quietly outlive its reason', () => {
    for (const [rel, lines] of Object.entries(ALLOWED)) {
      const code = codeOnly(readFileSync(join(BACKEND_SRC, rel), 'utf8')).map((l) => l.trim());
      for (const line of lines) expect(code, `${rel} no longer contains: ${line}`).toContain(line);
    }
  });

  it('the scanner sees what it is meant to see', () => {
    // The scan is only as good as its two matchers; check them on known
    // inputs so a regex that silently matches nothing cannot read as a pass.
    expect('d.setDate(d.getDate() + 1);'.match(PROCESS_LOCAL_ACCESSOR)).toHaveLength(2);
    expect('d.setHours(0, 0, 0, 0);'.match(PROCESS_LOCAL_ACCESSOR)).toHaveLength(1);
    expect('at.getMonth()'.match(PROCESS_LOCAL_ACCESSOR)).toHaveLength(1);
    expect('d.setUTCDate(d.getUTCDate() + 1);'.match(PROCESS_LOCAL_ACCESSOR)).toBeNull();
    expect(localDateConstructors('const p = new Date(y, m + 1, 1);')).toHaveLength(1);
    expect(localDateConstructors('new Date(Date.UTC(y, m, 1))')).toHaveLength(0);
    expect(localDateConstructors('new Date(Math.max(a, b))')).toHaveLength(0);
    expect(codeOnly('x(); // d.setDate(1)')[0]).toBe('x(); ');
    expect(sourceFiles(BACKEND_SRC).length).toBeGreaterThan(50);
  });
});
