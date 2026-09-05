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
 * …and every INDEX INTO THE CATALOG, `PLANS[…]`:
 *
 *   - `PLANS[h?.planId ?? 'seedling']` is `getPlan` with the fallback written
 *     out by hand. It reaches the identical wrong answer while naming none of
 *     the functions above, so it was invisible here until local-server was
 *     converted — which is how `src/local-server.ts` came to mirror the
 *     production defect at twenty sites while this gate reported green. A
 *     control that cannot see a shape does not constrain it.
 *
 * The first three answer "which tier is on file", which is not the same
 * question as "may this household do this right now"; the catalog index
 * answers it with one less function call. `getEntitledPlanForIssuedGrant`
 * answers the right question the lenient way, which is a product decision
 * each time and must not spread by copy-paste — a new site that quietly keeps
 * a `past_due` household entitled is exactly the defect #476 is about,
 * pointed the other way.
 *
 * `getEntitledPlan(…)` is NOT a finding. It is the answer.
 *
 * Only the SUBSCRIPT form `PLANS[expr]` is a finding. `PLANS.garden` and
 * `PLANS.seedling` name one fixed tier in the source text and cannot carry a
 * household's plan id — they are the upgrade target in a message
 * (`services/sitterPlanGate.ts`) and the free-tier floor — and
 * `Object.values(PLANS)` is the catalog itself. The line is syntactic on
 * purpose: it is the expression between the brackets that decides whose tier
 * this is, and that expression is what gets pinned as `arg`.
 *
 * ## What it deliberately does NOT look for
 *
 *   - `models/plans.ts` itself — the module that defines all of the above.
 *   - A bare comparison against the plan row, `sub.planId === 'greenhouse'`.
 *     This is the shape that remains invisible, and it is stated here rather
 *     than left to be discovered: `.planId` is read legitimately all over the
 *     codebase (the truthful tier `/billing/me` publishes, the tier a checkout
 *     is buying, the id passed INTO `getEntitledPlan`), so matching on it
 *     would produce a baseline of mechanical entries that nobody reads. The
 *     two sites that compared it to decide entitlement — `apiKeys` in
 *     production (#540) and its local-server mirror — now go through
 *     `getEntitledPlan`, and a new one would be caught in review, not here.
 *   - `strongestPlan(ids)` — the per-USER homes cap resolves the strongest
 *     tier across every household a person belongs to, from plan ROWS, in
 *     `services/homesGate.ts` and its local-server mirror. #476 did not
 *     convert it and neither does the local-server pass: whether one
 *     household's failing card should shrink a DIFFERENT household's homes
 *     allowance is an unasked product question, and a gate entry that says
 *     "pending a decision" is the hand-maintained list this file exists to
 *     replace. Adding it here is the first step of answering it, not a
 *     substitute for it.
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
 * So each entry also records `arg`: the source text of the first argument —
 * or, for a `PLANS[…]` finding, of the index expression, which is the same
 * thing one syntax down — whitespace-normalised. The gate fails when it no
 * longer matches. That is the cheap, syntactic, falsifiable half of the
 * reason.
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
/**
 * The catalog itself. `PLANS[expr]` is `getPlan(expr)` with the unknown-id
 * fallback inlined, so it reads the plan ROW and is a finding for exactly the
 * same reason — see the header for why only the subscript form counts.
 */
const CATALOG = 'PLANS';
/** The synthetic callee name a catalog index is recorded under. */
const CATALOG_INDEX = 'PLANS[]';

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

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);

/**
 * `GET /sitter/:token` for a handler passed straight to an Express route —
 * `app.get('/sitter/:token', authMiddleware, (req, res) => …)`.
 *
 * Without this every gate in `local-server.ts` keys as `<anonymous>`, and the
 * repeats inside one file take `#2`, `#3`, … suffixes that renumber whenever
 * an unrelated route is inserted above them. A baseline whose keys move when
 * untouched code moves is a baseline that gets updated without being read.
 *
 * Guarded so it cannot fire on an ordinary callback: the function must NOT be
 * the first argument (`list.map((x) => …)`), the first argument must be a
 * string literal, and the method must be an HTTP verb.
 */
function expressRouteName(fn) {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call)) return null;
  if (call.arguments.length < 2 || call.arguments[0] === fn) return null;
  if (!call.arguments.includes(fn)) return null;
  const target = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(target)) return null;
  const method = target.name.text;
  if (!HTTP_METHODS.has(method)) return null;
  const path = call.arguments[0];
  if (!ts.isStringLiteral(path)) return null;
  return `${method.toUpperCase()} ${path.text}`;
}

function functionName(fn) {
  if (!fn) return '<module>';
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return fn.name.getText();
  }
  const route = expressRouteName(fn);
  if (route) return route;
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

/** Source text of one expression, whitespace-collapsed. */
function exprText(node) {
  if (!node) return '';
  return node.getText().replace(/\s+/g, ' ').trim();
}

/** The first argument's source text, whitespace-collapsed. */
function argText(call) {
  return exprText(call.arguments[0]);
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

  /** Record one occurrence. Repeats inside one function get a `#n` suffix. */
  const record = (node, callee, arg) => {
    const fn = functionName(enclosingFunction(node));
    const base = `${rel}::${fn}::${callee}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const key = count === 1 ? base : `${base}#${count}`;
    findings.set(key, {
      key,
      rel,
      fn,
      callee,
      arg,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    });
  };

  walkDeep(sourceFile, (n) => {
    // `PLANS[…]`. Property access (`PLANS.garden`) is deliberately not a
    // finding: it names one fixed tier and cannot carry a household's plan id.
    if (ts.isElementAccessExpression(n)) {
      if (calleeName(n.expression) === CATALOG) {
        record(n, CATALOG_INDEX, exprText(n.argumentExpression));
      }
      return true;
    }
    if (!ts.isCallExpression(n)) return true;
    const name = calleeName(n.expression);
    if (!name) return true;
    if (!PLAN_ROW_READERS.has(name) && name !== ISSUED_GRANT_READER) return true;

    record(n, name, argText(n));
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

const addedRow = added.filter(
  (f) => f.callee !== ISSUED_GRANT_READER && f.callee !== CATALOG_INDEX
);
const addedLenient = added.filter((f) => f.callee === ISSUED_GRANT_READER);
const addedCatalog = added.filter((f) => f.callee === CATALOG_INDEX);

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

if (addedCatalog.length > 0) {
  console.error(
    'A paid-feature decision resolved by INDEXING THE PLAN CATALOG.\n' +
      "`PLANS[h?.planId ?? 'seedling']` is `getPlan(h?.planId)` with the unknown-id\n" +
      'fallback written out by hand. It reads which tier the household is ON and\n' +
      'cannot see whether that tier is being PAID for, and it cannot see a lifetime\n' +
      'purchase either — the same two failures as `getPlan(sub.planId)`, reached\n' +
      'without naming any function this gate watches. That is how `local-server.ts`\n' +
      'mirrored the production defect at twenty sites while this gate stayed green.\n'
  );
  for (const f of addedCatalog) {
    console.error(`  - ${f.key}  (line ${f.line}: PLANS[${f.arg}])`);
  }
  console.error(
    '\nResolve it through the same two entry points as everything else:\n' +
      '`getEntitledPlan(sub)` for what a household MAY START, or\n' +
      '`getEntitledPlanForIssuedGrant(sub)` for what an already-issued, unexpired\n' +
      'grant KEEPS. Both take the subscription, not the plan id, precisely so the\n' +
      'question has to be named.\n' +
      'If it is not entitlement at all — a catalog lookup on an id that is already\n' +
      'resolved, a price table, an upsell target — add the entry to\n' +
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
