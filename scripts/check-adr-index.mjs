#!/usr/bin/env node
/**
 * Derives the ADR index in `docs/adr/README.md` from the ADR files themselves.
 *
 * Why this exists (issue #475). The index was a hand-maintained markdown table
 * with one row per ADR, and every PR carrying a decision appended a row to the
 * same place — #415, #418, #413, #432, #424, #433, #430, #420, #401, #391,
 * #405, #359, #318 and #309 all touched it. A one-line-of-context edit at the
 * bottom of a table, made by every branch in flight, is the canonical shape of
 * a merge conflict a reviewer learns nothing from, and the mechanical
 * resolution is easy to get wrong: dropping someone else's row is a silent
 * loss that nothing would have caught.
 *
 * This repo has retired the same shape twice — `check-api-spec.mjs` for the
 * handler-route count (#435) and `check-docs-testing.mjs` for the test counts
 * (#410). This is the third and last instance.
 *
 * ## What is derived, and what is not
 *
 * Only the table (and the "numbers not in use" line under it) between the
 * `ADR-INDEX` markers. The Format and "When to write one" sections, and the
 * note about earlier decisions documented inline in `architecture.md` /
 * `strategy-review.md`, are hand-written prose that lives OUTSIDE the markers
 * and is never touched — the same marker convention `check-docs-testing.mjs`
 * uses for `TEST-COUNTS` and `COVERAGE-THRESHOLDS`.
 *
 * Each row's three columns all come from the file:
 *
 *   #       the filename, which is also the link target
 *   Title   the `# ` heading, minus its `NNNN — ` / `NNNN. ` prefix
 *   Status  the `**Status:**` line, reduced to the keyword
 *
 * Titles are therefore the ADRs' REAL titles, which are longer than the
 * abbreviations the hand-maintained table carried. That is the point: an
 * abbreviation is another hand-maintained field that can drift from the
 * document it names.
 *
 * ## Two things the hand-maintained table could not catch
 *
 *   1. **A missing or renamed file.** The old index and the files happened to
 *      agree; nothing enforced it, so an ADR added without a row was invisible
 *      and a renamed file left a dead link. Now the files ARE the index.
 *   2. **Numbering gaps.** `0001` is not in use. That is almost certainly a
 *      number claimed on a branch that never landed, and the deliberate
 *      choice here (per #475) is to state the gaps rather than assert
 *      contiguity or fabricate rows for them — a reader could not previously
 *      tell a deliberate gap from a lost file, and now the line saying which
 *      numbers are unused is generated rather than remembered.
 *
 * ## Status parsing
 *
 * `README.md`'s own Format section defines the vocabulary: Proposed,
 * Accepted, or `Superseded by NNNN`. An ADR whose Status line does not start
 * with one of those fails the gate by name, which makes this a format check
 * as well as an index generator. Anything after the keyword (ADR 0000's
 * `(2026-06-10)`, ADR 0008's paragraph about which bullet 0009 amended) is
 * deliberately dropped: it belongs in the ADR, not in a summary table.
 *
 * Usage:
 *   node scripts/check-adr-index.mjs            # verify (CI + `npm run verify`)
 *   node scripts/check-adr-index.mjs --write    # regenerate the marked block
 *   node scripts/check-adr-index.mjs --print    # print the table, change nothing
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADR_DIR = 'docs/adr';
const DOC_PATH = `${ADR_DIR}/README.md`;
const BEGIN = '<!-- BEGIN:ADR-INDEX -->';
const END = '<!-- END:ADR-INDEX -->';

/** `NNNN-some-slug.md`. README.md and anything else is not an ADR. */
const ADR_FILE = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;

/** The statuses `docs/adr/README.md`'s Format section defines. */
const STATUS = /^(Accepted|Proposed|Deprecated|Rejected|Superseded by \d{4})/u;

const errors = [];

/**
 * Read one ADR into an index row.
 *
 * Returns `{ number, file, title, status }`, or pushes a named error and
 * returns null. It never guesses a missing field: an ADR with no heading is
 * reported as such rather than indexed under its filename, because a row
 * invented from a filename is precisely the "absence rendered as a value"
 * this repo keeps having to unwind.
 */
function readAdr(file) {
  const number = ADR_FILE.exec(file)[1];
  const source = readFileSync(join(ROOT, ADR_DIR, file), 'utf8');

  const heading = /^#\s+(.+?)\s*$/mu.exec(source);
  if (!heading) {
    errors.push(`${ADR_DIR}/${file}: no \`# \` heading, so the index has no title to show.`);
    return null;
  }
  // `# 0021. HTML email…`, `# 0008 — Unit-aware…`, `# 0003 - Single-table…`
  const title = heading[1].replace(/^\d{4}\s*(?:[—–-]|\.)\s*/u, '').trim();
  if (title === '') {
    errors.push(`${ADR_DIR}/${file}: the heading is only its number — give it a title.`);
    return null;
  }

  const statusLine = /^\*\*Status:?\*\*:?\s*(.+?)\s*$/mu.exec(source);
  if (!statusLine) {
    errors.push(
      `${ADR_DIR}/${file}: no \`**Status:**\` line. Every ADR carries one — see the Format section of ${DOC_PATH}.`
    );
    return null;
  }
  const status = STATUS.exec(statusLine[1]);
  if (!status) {
    errors.push(
      `${ADR_DIR}/${file}: Status is "${statusLine[1]}", which does not start with one of Proposed / Accepted / Deprecated / Rejected / "Superseded by NNNN" (the vocabulary ${DOC_PATH} defines).`
    );
    return null;
  }

  return { number, file, title, status: status[1] };
}

/** Pad a table the way Prettier does, so `format:check` stays green. */
function renderTable(rows) {
  const header = ['#', 'Title', 'Status'];
  const body = rows.map((row) => [
    `[${row.number}](${row.file})`,
    // A literal pipe would split the cell. No current ADR has one; a future
    // title might, and a silently broken table is worse than an escaped bar.
    row.title.replaceAll('|', '\\|'),
    row.status,
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((r) => r[column].length))
  );
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(header), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...body.map(line)];
}

/**
 * Which numbers between the lowest and highest ADR are unused.
 *
 * Stated rather than asserted away: #475 settled on surfacing gaps over
 * either failing on them (they are legitimate — a number can be claimed on a
 * branch that never lands) or staying silent (a reader then cannot tell a
 * deliberate gap from a lost file).
 */
function missingNumbers(rows) {
  if (rows.length === 0) return [];
  const present = new Set(rows.map((row) => Number(row.number)));
  const lowest = Math.min(...present);
  const highest = Math.max(...present);
  const gaps = [];
  for (let n = lowest; n <= highest; n += 1) {
    if (!present.has(n)) gaps.push(String(n).padStart(4, '0'));
  }
  return gaps;
}

function render(rows) {
  const gaps = missingNumbers(rows);
  return [
    BEGIN,
    '',
    ...renderTable(rows),
    '',
    gaps.length > 0
      ? `> Numbers not in use: ${gaps.join(', ')}. Gaps are expected — a number can be claimed on a branch that never lands — and this line is generated, so a file that goes missing shows up here instead of silently.`
      : '> Every ADR number from the first to the last is in use.',
    '',
    END,
  ].join('\n');
}

/**
 * Compare two marked blocks by content, not by whitespace.
 *
 * Prettier owns the padding inside a markdown table, and this script only
 * imitates it. Comparing trimmed cells means a Prettier change to table
 * layout cannot fail this gate for a reason that has nothing to do with the
 * index being correct.
 */
function normalize(block) {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) =>
      line.startsWith('|')
        ? line
            .split('|')
            .map((cell) => (/^-+$/u.test(cell.trim()) ? '-' : cell.trim()))
            .join('|')
        : line
    )
    .join('\n');
}

const files = readdirSync(join(ROOT, ADR_DIR))
  .filter((file) => ADR_FILE.test(file))
  .sort();

if (files.length === 0) {
  console.error(`${ADR_DIR}/ contains no NNNN-*.md files — the index would be empty.`);
  process.exit(1);
}

const rows = files.map(readAdr).filter((row) => row !== null);
const expected = render(rows);

if (process.argv.includes('--print')) {
  console.log(expected);
  process.exit(errors.length > 0 ? 1 : 0);
}

const doc = readFileSync(join(ROOT, DOC_PATH), 'utf8');
const begin = doc.indexOf(BEGIN);
const end = doc.indexOf(END);

if (begin === -1 || end === -1 || end < begin) {
  errors.push(
    `${DOC_PATH}: the ${BEGIN} / ${END} markers are missing or out of order, so there is nowhere to put the generated index. Restore them around the Index table.`
  );
} else if (process.argv.includes('--write')) {
  if (errors.length === 0) {
    writeFileSync(
      join(ROOT, DOC_PATH),
      doc.slice(0, begin) + expected + doc.slice(end + END.length)
    );
    console.log(`${DOC_PATH}: regenerated the index (${rows.length} ADRs).`);
    process.exit(0);
  }
} else {
  const actual = doc.slice(begin, end + END.length);
  if (normalize(actual) !== normalize(expected)) {
    errors.push(
      `${DOC_PATH}: the Index block does not match the ADR files. Run \`node scripts/check-adr-index.mjs --write && npx prettier --write ${DOC_PATH}\`.`
    );
    const actualRows = new Set(normalize(actual).split('\n'));
    const expectedRows = new Set(normalize(expected).split('\n'));
    for (const line of expectedRows) {
      if (!actualRows.has(line)) errors.push(`  missing from the doc: ${line}`);
    }
    for (const line of actualRows) {
      if (!expectedRows.has(line)) errors.push(`  in the doc but not derivable: ${line}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`${DOC_PATH} is out of sync with ${ADR_DIR}/:\n`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error('');
  process.exit(1);
}

console.log(`${DOC_PATH} matches ${ADR_DIR}/ (${rows.length} ADRs, index derived).`);
