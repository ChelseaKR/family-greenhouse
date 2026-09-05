#!/usr/bin/env node
/**
 * Settled-read-state gate — a RATCHET, not a hard zero. Run by
 * `npm run reads:check` (root `npm run verify`) and CI's Lint job.
 * The rule it enforces is [ADR 0010](../../docs/adr/0010-settled-read-states.md).
 *
 * ## What it looks for
 *
 * Two syntactic shapes. The first is the shape that produced #350 and #351 and
 * half the fixes in #339 / #341 / #347 / #348 (`silent-guard`):
 *
 *   const { data } = useQuery(...);   // no isError / error / status bound
 *   ...
 *   if (!data) return null;           // or `data === undefined`
 *
 * A component written that way renders nothing in THREE different situations
 * — the read is still in flight, the read settled empty, and the read failed —
 * and the reader cannot tell which. When the component carries a warning
 * (a frost alert, a pet-toxicity banner, a live API key), its absence reads as
 * an all-clear that nobody computed.
 *
 * The second (`default-literal`, added 2026-09-04 for #456):
 *
 *   const { data: spaces = [] } = useQuery(...);   // no outcome field bound
 *
 * Same collapse, and strictly harder to see: it happens ONCE, at the
 * declaration, and is invisible at every one of the dozens of use sites
 * downstream — there is no `if (!data)` to notice, because the default made
 * one unnecessary. Seven components read the household's rooms this way, so a
 * failed `GET /spaces` reached `spaceOverview` as an empty map and filed EVERY
 * plant under "Unplaced": a household that had spent months organising its
 * plants into rooms was told, with no error and no hint, that it had organised
 * nothing. Only a LITERAL default counts — `data: x = fallbackFromProps` is a
 * deliberate choice with a name attached.
 *
 * ## What it deliberately does NOT look for
 *
 * This gate is narrow on purpose, because a noisy gate gets baselined into
 * irrelevance and stops being a gate at all.
 *
 *   - It does not require an `isError` branch. The codebase's own idiom is
 *     often `data === undefined ? unknown : value` AFTER the loading guard
 *     (AnalyticsPage, DashboardPage), which reads no error field at all and
 *     is correct. Demanding `isError` would flag already-correct code.
 *   - It does not catch the coalescing shape at a USE site
 *     (`query.data?.length ?? 0`, `(plants ?? []).length`) that produced #348
 *     and #349. Detecting that without false positives needs type information
 *     this scanner does not have. The declaration-site form of the same idea
 *     (`data: x = []`) IS caught, because that one is purely syntactic. The
 *     rest remain a review concern; ADR 0010 states the rule for them.
 *   - It does not judge consequence. Whether a vanished card is a safety
 *     signal or a decorative one is a human call — which is exactly what the
 *     baseline's per-entry reason records.
 *
 * ## The ratchet
 *
 * `settled-read-states-baseline.json` pins the accepted occurrences, each with
 * the reason its absence is not a false all-clear. The gate fails when
 *
 *   - a finding is not in the baseline (new debt), or
 *   - a baseline entry no longer matches a finding (stale entry — remove it in
 *     the same PR that fixed it, so the baseline can only shrink).
 *
 * Failing in BOTH directions is the point: a baseline that only ever grows is
 * a guardrail that cannot fail.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const FRONTEND_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * `--src <dir>` scans a different tree and `--baseline <file>` diffs against a
 * different baseline. Both exist so the gate's OWN tests
 * (`tests/unit/scripts/checkSettledReadStates.test.ts`) can run the real
 * script against fixtures — a gate with no failing test is a report with a
 * green tick. Same flags as the backend half.
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--src') out.src = argv[++i];
    else if (argv[i] === '--baseline') out.baseline = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SRC = args.src ? path.resolve(args.src) : path.join(FRONTEND_DIR, 'src');
const BASELINE_PATH = args.baseline
  ? path.resolve(args.baseline)
  : path.join(FRONTEND_DIR, 'scripts', 'settled-read-states-baseline.json');

/**
 * Destructured names that mean the component reads the query's outcome, not
 * only its payload. Any one of them takes the call site out of scope: the
 * author is already distinguishing states, and how they render them is a
 * review question, not a syntax one.
 */
const OUTCOME_KEYS = new Set(['isError', 'error', 'status', 'isSuccess', 'failureReason']);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(abs);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield abs;
  }
}

/** The nearest enclosing function-ish node, whose body we search for the guard. */
function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * `if (<mentions data>) return null;` with no else branch.
 *
 * The mention has to be of the binding ITSELF. `!data.configured` reads a
 * field of a payload the component already has in hand — a genuine emptiness
 * test, not a swallowed read — so the lookahead rejects a following `.`, `[`
 * or `(`.
 */
function findSilentGuard(fn, local, sourceFile) {
  const mentionsData = new RegExp(
    `(^|[^\\w$])!\\s*${local}(?![\\w$.[(])|(^|[^\\w$.])${local}\\s*===\\s*undefined`
  );
  let hit = null;
  const scan = (node) => {
    if (hit) return;
    if (ts.isIfStatement(node) && !node.elseStatement) {
      const body = node.thenStatement.getText().trim();
      const returnsNull = /^\{?\s*return null;?\s*\}?$/.test(body);
      if (returnsNull && mentionsData.test(node.expression.getText())) {
        hit = {
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          condition: node.expression.getText(),
        };
        return;
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(fn.body ?? fn);
  return hit;
}

/**
 * `const { data: x = [] } = useQuery(...)` — a literal default bound at the
 * destructure. ADR 0010 named `?? []` as out of scope; this form is the same
 * idea and strictly harder to see, because the coalescing happens ONCE at the
 * declaration and is invisible at every use site downstream.
 *
 * Only a literal counts. `data: x = fallbackFromProps` is a deliberate,
 * reviewable choice with a name attached; `= []` is the reflex.
 */
function isLiteralDefault(init) {
  if (!init) return false;
  return (
    ts.isArrayLiteralExpression(init) ||
    ts.isObjectLiteralExpression(init) ||
    ts.isNumericLiteral(init) ||
    ts.isStringLiteral(init) ||
    ts.isNoSubstitutionTemplateLiteral(init) ||
    init.kind === ts.SyntaxKind.TrueKeyword ||
    init.kind === ts.SyntaxKind.FalseKeyword ||
    init.kind === ts.SyntaxKind.NullKeyword
  );
}

/** rel path -> findings */
const findings = new Map();
let scanned = 0;

for (const file of sourceFiles(SRC)) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('useQuery(')) continue;
  scanned += 1;
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );

  const walk = (node) => {
    const isUseQueryDecl =
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'useQuery' &&
      ts.isObjectBindingPattern(node.name);

    if (isUseQueryDecl) {
      const elements = node.name.elements;
      const bound = elements.map((el) => (el.propertyName ?? el.name).getText());
      const dataElement = elements.find((el) => (el.propertyName ?? el.name).getText() === 'data');
      if (dataElement && !bound.some((name) => OUTCOME_KEYS.has(name))) {
        const local = dataElement.name.getText();
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (isLiteralDefault(dataElement.initializer)) {
          const key = `${rel}::${local}::default-literal`;
          if (!findings.has(key)) {
            findings.set(key, {
              key,
              line,
              rule: 'default-literal',
              detail: `data: ${local} = ${dataElement.initializer.getText()}`,
            });
          }
        } else {
          const fn = enclosingFunction(node);
          const guard = fn && findSilentGuard(fn, local, sourceFile);
          if (guard) {
            const key = `${rel}::${local}::silent-guard`;
            if (!findings.has(key)) {
              findings.set(key, {
                ...guard,
                key,
                rule: 'silent-guard',
                detail: `if (${guard.condition}) return null`,
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const accepted = baseline.accepted ?? {};

const added = [...findings.values()].filter((f) => !(f.key in accepted));
const stale = Object.keys(accepted).filter((key) => !findings.has(key));

if (added.length === 0 && stale.length === 0) {
  console.log(
    `Settled-read-state gate passed: ${scanned} files scanned, ` +
      `${findings.size} accepted occurrences (baseline ${Object.keys(accepted).length}, ratchet-only).`
  );
  process.exit(0);
}

const addedGuards = added.filter((f) => f.rule === 'silent-guard');
const addedDefaults = added.filter((f) => f.rule === 'default-literal');

if (addedGuards.length > 0) {
  console.error(
    'A query result is read as data only, and a falsy `data` renders nothing.\n' +
      'Still-in-flight, settled-empty, and failed then look identical to the reader,\n' +
      'and a card that carries a warning goes missing without saying so. See ADR 0010\n' +
      '(docs/adr/0010-settled-read-states.md).\n'
  );
  for (const f of addedGuards) console.error(`  - ${f.key}  (line ${f.line}: ${f.detail})`);
  console.error(
    '\nEither give the three states distinct renderings, or add the entry to\n' +
      'frontend/scripts/settled-read-states-baseline.json with the reason its\n' +
      'absence cannot be mistaken for an all-clear.\n'
  );
}

if (addedDefaults.length > 0) {
  console.error(
    'A query result is defaulted to a literal at the destructure, with no outcome\n' +
      'field bound. A failed read then reaches every use site as an empty list (or a\n' +
      'zero, or a false) that a genuine empty result also produces — and the collapse\n' +
      'is invisible at all of them, because it happened once at the declaration.\n' +
      'This is the shape that told a household with seven rooms that every plant was\n' +
      '"Unplaced" (#456). See ADR 0010.\n'
  );
  for (const f of addedDefaults) console.error(`  - ${f.key}  (line ${f.line}: ${f.detail})`);
  console.error(
    '\nBind the outcome — `isError` / `status` / `error` — and render the settled-failed\n' +
      'state in words, or read through a hook that returns a discriminated result (see\n' +
      '`src/hooks/useSpaces.ts`). If the emptiness genuinely asserts nothing, add the\n' +
      'entry to frontend/scripts/settled-read-states-baseline.json with the reason.\n'
  );
}

if (stale.length > 0) {
  console.error(
    'Baseline entries that no longer match anything. Remove them in the same PR —\n' +
      'the baseline may only shrink, and a stale entry silently re-admits the defect:\n'
  );
  for (const key of stale) console.error(`  - ${key}`);
}

process.exit(1);
