#!/usr/bin/env node
/**
 * Entitlement-gate ratchet — #476, direction 4.
 *
 * Run by `npm run entitlements:check` (root `npm run verify` and CI's required
 * Lint job). Enforces the rule PR #364 introduced: **entitlement must consult
 * payment status, not just `planId`.**
 *
 * ## Why this exists
 *
 * #364 introduced `getEntitledPlan(sub)` and converted every call site that
 * existed when it was written. Then the rule silently stopped applying to code
 * written after it. By the time #476 was filed, roughly a dozen new gates
 * resolved paid features off `getPlan(sub.planId)` again — and while #476 was
 * open, `handlers/caretakers/management.ts` added one more, so the issue's own
 * table was stale before anyone worked it. A hand-maintained list of gates is
 * not a control; it is a snapshot.
 *
 * ## What it looks for
 *
 * Every call in `backend/src` to one of:
 *
 *   - `getPlan(…)`             — resolves the plan a household is ON
 *   - `planLimits(…)`          — the same, for caps
 *   - `planHasFeature(…)`      — the same, for feature flags
 *   - `getEntitledPlanForIssuedGrant(…)` — the deliberate LENIENCY: what an
 *     already-issued, unexpired grant keeps while the card is failing
 *
 * The first three answer "which tier is on file", which is not the same
 * question as "may this household do this right now". The fourth answers the
 * right question the lenient way, which is a product decision each time and
 * must not spread by copy-paste — a new site that quietly keeps a `past_due`
 * household entitled is exactly the defect #476 is about, pointed the other
 * way.
 *
 * `getEntitledPlan(…)` is NOT a finding. It is the answer.
 *
 * ## What it deliberately does NOT look for
 *
 *   - `models/plans.ts` itself — the module that defines all of the above.
 *   - `src/local-server.ts` — the in-memory dev server resolves plans by
 *     indexing the catalog directly (`PLANS[h?.planId ?? 'seedling']`) at ~20
 *     sites, a shape this gate cannot see. It mirrors the production defect
 *     and is tracked in #476; it is not production code, and converting it is
 *     a separate change. Its two calls that DO use the named helpers are
 *     baselined below like any other.
 *   - `PLANS[…]` index expressions anywhere. Same blind spot, stated once.
 *   - Whether a converted site chose the RIGHT one of the two entry points.
 *     That is a product question — which is why every accepted entry records
 *     the reason in prose, and why the argument it was called with is pinned.
 *
 * ## Every entry pins its argument
 *
 * A baseline key is `file::function::callee`. The reason beside it is prose,
 * and nothing re-validates prose — so a later PR could change WHAT is passed
 * without changing the key, turning "the plan being purchased" into "the
 * household's own subscription" while the gate stayed green.
 *
 * So each entry also records `arg`: the source text of the first argument,
 * whitespace-normalised. The gate fails when it no longer matches. That is
 * the cheap, syntactic, falsifiable half of the reason.
 *
 * ## The ratchet
 *
 * `entitlement-gates-baseline.json` pins the accepted occurrences. The gate
 * fails when
 *
 *   - a finding is not in the baseline (new debt), or
 *   - a baseline entry no longer matches a finding (stale — remove it in the
 *     same PR that fixed it, so the baseline can only shrink), or
 *   - a baseline entry's recorded `arg` no longer matches the code (drift —
 *     re-read the reason, then update it or fix the call).
 *
 * Failing in all three directions is the point: a baseline that only ever
 * grows is a guardrail that cannot fail.
 *
 * Flags: `--src <dir>` scans a different tree and `--baseline <file>` diffs
 * against a different baseline (both for the gate's own tests); `--print`
 * prints every finding as a baseline skeleton, which is how a new entry gets
 * written.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const BACKEND_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--src') out.src = argv[++i];
    else if (argv[i] === '--baseline') out.baseline = argv[++i];
    else if (argv[i] === '--print') out.print = true;
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SRC = args.src ? path.resolve(args.src) : path.join(BACKEND_DIR, 'src');
const BASELINE_PATH = args.baseline
  ? path.resolve(args.baseline)
  : path.join(BACKEND_DIR, 'scripts', 'entitlement-gates-baseline.json');

/**
 * The plan-row readers. `getEntitledPlan` is absent on purpose: it is the
 * rule, not a violation of it.
 */
const PLAN_ROW_READERS = new Set(['getPlan', 'planLimits', 'planHasFeature']);
/** The deliberate leniency, baselined for the same reason (see the header). */
const ISSUED_GRANT_READER = 'getEntitledPlanForIssuedGrant';

/** Files that define these helpers, or that this gate cannot usefully see. */
const EXCLUDED = new Set([
  // The module that declares every symbol above.
  path.join('models', 'plans.ts'),
]);

// ---------------------------------------------------------------------------
// AST helpers (same shapes as check-settled-read-states.mjs)
// ---------------------------------------------------------------------------

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(abs);
    else if (/\.ts$/.test(entry.name) && !/\.(test|spec|d)\.ts$/.test(entry.name)) yield abs;
  }
}

function walkDeep(node, visit) {
  const rec = (n) => {
    if (visit(n) === false) return;
    ts.forEachChild(n, rec);
  };
  ts.forEachChild(node, rec);
}

/** Strip parentheses, `as`, `satisfies`, `!`, `<T>` casts around a value. */
function unwrap(e) {
  let cur = e;
  for (;;) {
    if (!cur) return cur;
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur)) cur = cur.expression;
    else if (ts.isTypeAssertionExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isSatisfiesExpression && ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

/**
 * The called name. Property access counts (`plans.getPlan(…)`) so a namespace
 * import cannot slip past; the declaring module is excluded by path instead.
 */
function calleeName(callee) {
  const c = unwrap(callee);
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
}

function enclosingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

function functionName(fn) {
  if (!fn) return '<module>';
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return fn.name.getText();
  }
  let cur = fn.parent;
  while (cur) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (ts.isPropertyAssignment(cur)) return cur.name.getText();
    if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) {
      return cur.name ? cur.name.getText() : '<anonymous>';
    }
    if (ts.isSourceFile(cur)) break;
    cur = cur.parent;
  }
  return '<anonymous>';
}

/** The first argument's source text, whitespace-collapsed. */
function argText(call) {
  const first = call.arguments[0];
  if (!first) return '';
  return first.getText().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const findings = new Map();
let scanned = 0;

for (const abs of sourceFiles(SRC)) {
  const rel = path.relative(SRC, abs);
  if (EXCLUDED.has(rel)) continue;
  scanned += 1;

  const text = readFileSync(abs, 'utf8');
  const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const seen = new Map();

  walkDeep(sourceFile, (n) => {
    if (!ts.isCallExpression(n)) return true;
    const name = calleeName(n.expression);
    if (!name) return true;
    if (!PLAN_ROW_READERS.has(name) && name !== ISSUED_GRANT_READER) return true;

    const fn = functionName(enclosingFunction(n));
    const base = `${rel}::${fn}::${name}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const key = count === 1 ? base : `${base}#${count}`;
    findings.set(key, {
      key,
      rel,
      fn,
      callee: name,
      arg: argText(n),
      line: sourceFile.getLineAndCharacterOfPosition(n.getStart()).line + 1,
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const accepted = baseline.accepted ?? {};

if (args.print) {
  const out = {};
  for (const f of [...findings.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    out[f.key] = { reason: `TODO (line ${f.line})`, arg: f.arg };
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const added = [...findings.values()].filter((f) => !(f.key in accepted));
const stale = Object.keys(accepted).filter((key) => !findings.has(key));

const malformed = [];
const drifted = [];
for (const key of Object.keys(accepted)) {
  if (!findings.has(key)) continue; // already reported as stale
  const entry = accepted[key];
  if (typeof entry !== 'object' || entry === null || typeof entry.arg !== 'string') {
    malformed.push(key);
    continue;
  }
  const actual = findings.get(key).arg;
  if (actual !== entry.arg) drifted.push({ key, recorded: entry.arg, actual });
}

if (added.length === 0 && stale.length === 0 && drifted.length === 0 && malformed.length === 0) {
  console.log(
    `Entitlement-gate ratchet passed: ${scanned} files scanned, ` +
      `${findings.size} accepted occurrences (baseline ${Object.keys(accepted).length}, ` +
      'ratchet-only), arguments unchanged.'
  );
  process.exit(0);
}

const addedRow = added.filter((f) => f.callee !== ISSUED_GRANT_READER);
const addedLenient = added.filter((f) => f.callee === ISSUED_GRANT_READER);

if (addedRow.length > 0) {
  console.error(
    'A paid-feature decision resolved from the plan ROW rather than from ENTITLEMENT.\n' +
      '`planId` says which tier a household is ON, not whether it is PAYING. Stripe does\n' +
      'not cancel on a failed charge — it retries for weeks — so a past_due household\n' +
      'keeps everything resolved this way for the whole dunning window, and a household\n' +
      'that bought a tier outright loses it when an unrelated subscription is cancelled\n' +
      '(the lifetime floor). See #364, #476 and docs/billing.md.\n'
  );
  for (const f of addedRow) {
    console.error(`  - ${f.key}  (line ${f.line}: ${f.callee}(${f.arg}))`);
  }
  console.error(
    '\nIf this resolves what a household MAY DO, use `getEntitledPlan(sub)`.\n' +
      'If it resolves what an already-issued, unexpired grant KEEPS — a sitter link in\n' +
      "someone else's hands, a Move Day claimed mid-season — use\n" +
      '`getEntitledPlanForIssuedGrant(sub)` and say why in the baseline.\n' +
      'If it is not entitlement at all — a plan being purchased, a tier named in an\n' +
      'email, an upsell target — add the entry to\n' +
      'backend/scripts/entitlement-gates-baseline.json with that reason.\n'
  );
}

if (addedLenient.length > 0) {
  console.error(
    'A new site grants a household mid-dunning the plan it is not paying for.\n' +
      '`getEntitledPlanForIssuedGrant` is a deliberate exception, not a default: it\n' +
      'exists because the person holding an already-issued grant is usually not the\n' +
      'buyer and cannot fix the card. Every use is a product decision (#476).\n'
  );
  for (const f of addedLenient) {
    console.error(`  - ${f.key}  (line ${f.line}: ${f.callee}(${f.arg}))`);
  }
  console.error(
    '\nAdd the entry to backend/scripts/entitlement-gates-baseline.json naming the\n' +
      'grant, who holds it, and what bounds it — or use `getEntitledPlan(sub)`.\n'
  );
}

if (stale.length > 0) {
  console.error(
    'Baseline entries that no longer match anything. Remove them in the same PR —\n' +
      'the baseline may only shrink, and a stale entry silently re-admits the defect:\n'
  );
  for (const key of stale) console.error(`  - ${key}`);
  console.error('');
}

if (malformed.length > 0) {
  console.error(
    'Baseline entries with no recorded argument. Each entry must be\n' +
      '{ "reason": "…", "arg": "…" } — the reason is about WHAT is passed, so the\n' +
      'argument has to be pinned or the reason is unfalsifiable:\n'
  );
  for (const key of malformed) console.error(`  - ${key}`);
  console.error('');
}

if (drifted.length > 0) {
  console.error(
    'The argument to a baselined plan read has changed. Its recorded reason is an\n' +
      'argument about that expression, and nothing else re-checks it — this is how\n' +
      '"the plan being purchased" quietly becomes "the household\'s own subscription"\n' +
      'while the key never moves.\n\n' +
      'Re-read the reason. If it still holds, update `arg` in the same PR. If it does\n' +
      'not, resolve the call through `getEntitledPlan`.\n'
  );
  for (const d of drifted) {
    console.error(`  - ${d.key}`);
    console.error(`      recorded: ${d.recorded}`);
    console.error(`      actual:   ${d.actual}`);
  }
  console.error('\n`--print` prints a baseline skeleton for every current finding.\n');
}

process.exit(1);
