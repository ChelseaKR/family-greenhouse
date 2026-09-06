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
 * …and every COMPARISON THAT NAMES A TIER, `plan.id === 'seedling'` (#592),
 * recorded under the synthetic callee `PlanId===`:
 *
 * That shape asks which tier a household is on, where a gate wants to know
 * whether the tier INCLUDES the feature. Those are different questions with
 * the same answer for every tier that exists today, so a gate written this way
 * is never wrong on the day it is written — which is why review keeps letting
 * it through. It becomes wrong when a tier is added BETWEEN two existing ones:
 * the new tier's `features` row is authored deliberately in `models/plans.ts`
 * beside the others, and a comparison naming one id ignores it. Nothing
 * reports the result, because a tier receiving a feature it was not granted
 * produces no error and no log line — just a working feature.
 *
 * Three gates were written this way while the rest of the codebase read flags:
 * chat on `plan.id === 'seedling'`, and both halves of API keys on
 * `id !== 'greenhouse'`. Each sat beside a `PlanFeatures` flag that already
 * held the answer, and chat spends Bedrock tokens per turn, so the leak would
 * have had a direct marginal cost.
 *
 * Naming a tier is not always a gate — a price rule, an upsell target, a
 * lifecycle event and an ordering test all legitimately name one. Those are
 * baselined with the reason, like every other entry here.
 *
 * The ids come from `PLAN_ORDER` in `models/plans.ts`, never from a list in
 * this file: see readPlanIds().
 *
 * …and every `PlanFeatures` FLAG THAT NO GATE READS (#605). Not a ratchet
 * entry — a hard zero, checked separately below:
 *
 * The three shapes above all catch a gate that decides the RIGHT thing the
 * WRONG way. This one catches the opposite: a capability the catalog declares,
 * `planSummary` publishes to every client, and no line of server code ever
 * consults. `PlanFeatures`' own docstring already forbids it — "a public
 * surface must not advertise a flag it cannot point at working code for" — and
 * the codebase had three violations at once. `chat` (#592) was gated on a tier
 * name; `apiKeys` (#605) had zero readers in either half while three sites
 * spelled `id !== 'greenhouse'`; `awayKit` (#605) had zero readers while the
 * FRONTEND read the flag and gated the whole recap query on it, so client and
 * server were answering two different questions about the same feature.
 *
 * A `PlanId===` finding and an unread flag are the same defect seen from its
 * two ends, which is why they live in one gate: the tier comparison is what a
 * gate reaches for when the flag beside it is not being read, and the unread
 * flag is what is left over afterwards. Catching only the first leaves the
 * second — `apiKeys` sat unread for as long as the comparisons did.
 *
 * A read is `<expr>.features.<flag>` or a by-name accessor with the flag as a
 * string literal. It is NOT the declaration, NOT the authored value, and NOT
 * `plan.features[key]` — see scanFlagReads(). Reads inside `planSummary` do
 * not count either: publishing a flag is the thing being complained about.
 *
 * Unlike the finding classes, this one scans `models/plans.ts` too, because
 * that is where the small accessors live (`hasHouseholdToolkit`,
 * `plantTagAllowance`, `planIncludesAwayKit`) and an accessor read by gates
 * elsewhere is enforcement.
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
 *   - A bare READ of `.planId`. It is read legitimately all over the codebase
 *     (the truthful tier `/billing/me` publishes, the tier a checkout is
 *     buying, the id passed INTO `getEntitledPlan`), so matching the read
 *     would produce a baseline of mechanical entries that nobody reads.
 *
 *     This bullet used to say the same about the COMPARISON,
 *     `sub.planId === 'greenhouse'`, and left it to review. #592 is what that
 *     cost: review had let three of them through, and the note here predicted
 *     "a new one would be caught in review, not here" one issue before a new
 *     one was not. The comparison is a far narrower shape than the read — ten
 *     occurrences in the whole tree, each with a real reason — so it is now
 *     matched; see `PlanId===` above. The read still is not.
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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
/**
 * The synthetic callee name a tier-naming comparison is recorded under. Both
 * `===` and `!==` (and their loose forms) record here; `arg` carries the whole
 * comparison, operator included, so the baseline reason can be argued about
 * the actual expression.
 */
const PLAN_ID_COMPARISON = 'PlanId===';
/** Operators whose operands are being compared for identity. */
const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

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

/**
 * The tier ids, read out of `PLAN_ORDER` in `models/plans.ts`.
 *
 * Deliberately NOT a list in this file. The case this finding class exists for
 * is a FOURTH tier (#592) — and a checker carrying its own copy of the three
 * current ids would not recognise the new one, so it would stay green through
 * exactly the scenario it was written to catch. Rebuilding the defect inside
 * the control is worse than not having the control.
 *
 * Always read from the real backend tree, never from `--src`: the plan catalog
 * is this repository's, not the scanned fixture's.
 */
function readPlanIds() {
  const abs = path.join(BACKEND_DIR, 'src', 'models', 'plans.ts');
  const text = readFileSync(abs, 'utf8');
  const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const ids = new Set();
  walkDeep(sourceFile, (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'PLAN_ORDER' &&
      n.initializer
    ) {
      const array = unwrap(n.initializer);
      if (ts.isArrayLiteralExpression(array)) {
        for (const element of array.elements) {
          if (ts.isStringLiteral(element)) ids.add(element.text);
        }
      }
    }
    return true;
  });
  if (ids.size === 0) {
    // Scanning for an empty set would report green over every tier comparison
    // in the tree — "found nothing" rendered as "nothing to find", which is
    // this repository's named defect class. Refuse instead.
    console.error(
      'Could not read any plan id from PLAN_ORDER in models/plans.ts.\n' +
        'The tier-comparison check would then match nothing and report green,\n' +
        'so this gate refuses to run rather than pass vacuously. If PLAN_ORDER\n' +
        'moved or changed shape, update readPlanIds() in this file.'
    );
    process.exit(2);
  }
  return ids;
}

const PLAN_IDS = readPlanIds();

/**
 * The `PlanFeatures` flag names, read out of the interface declaration in
 * `models/plans.ts` — never a list in this file, for the same reason
 * `readPlanIds` is not one. A tenth flag added tomorrow is exactly the case
 * this check exists for, and a checker carrying today's nine would report
 * green through it.
 *
 * Always read from the real backend tree, like `readPlanIds`: the catalog is
 * this repository's, not the scanned fixture's.
 */
function readFeatureFlags() {
  const abs = path.join(BACKEND_DIR, 'src', 'models', 'plans.ts');
  const text = readFileSync(abs, 'utf8');
  const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const flags = new Set();
  walkDeep(sourceFile, (n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === 'PlanFeatures') {
      for (const member of n.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
          flags.add(member.name.text);
        }
      }
    }
    return true;
  });
  if (flags.size === 0) {
    // Same refusal as readPlanIds, for the same reason: a check that looks for
    // nothing finds nothing and renders it as "nothing to find".
    console.error(
      'Could not read any flag from `interface PlanFeatures` in models/plans.ts.\n' +
        'The unenforced-flag check would then have nothing to look for and would\n' +
        'report green over every published flag, so this gate refuses to run\n' +
        'rather than pass vacuously. If PlanFeatures moved or changed shape,\n' +
        'update readFeatureFlags() in this file.'
    );
    process.exit(2);
  }
  return flags;
}

const FEATURE_FLAGS = readFeatureFlags();

/** The accessors that take a flag NAME as their second argument. */
const FLAG_BY_NAME_READERS = new Set(['featureOf', 'planHasFeature', 'hasFeature']);

/**
 * Functions whose job is to PUBLISH the flag map rather than act on it. A read
 * inside one of these enforces nothing: `planSummary` serialising
 * `plan.features.householdToolkit` to the client is the very shape #605 names
 * ("published to every client and enforced by neither"), so counting it as a
 * reader would let the check pass on exactly the defect it looks for.
 */
const FLAG_PUBLISHERS = new Set(['planSummary']);

/**
 * Where each flag is READ by something that could act on it.
 *
 * A read is `<expr>.features.<flag>`, or `featureOf` / `planHasFeature` /
 * `hasFeature` with the flag as a string literal. Deliberately NOT the
 * DECLARATION (`awayKit: boolean;`) nor the AUTHORED VALUE (`awayKit: true,`):
 * those are what every unenforced flag already has, so counting them would
 * make the check vacuous. And deliberately not `plan.features[key]` — the
 * generic subscript in `featureOf`'s own body names no flag, and must not
 * count as a reader of all of them.
 */
function scanFlagReads(flags) {
  const reads = new Map([...flags].map((f) => [f, []]));
  for (const abs of sourceFiles(SRC)) {
    const rel = path.relative(SRC, abs);
    const text = readFileSync(abs, 'utf8');
    const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
    const note = (node, flag) => {
      const fn = functionName(enclosingFunction(node));
      if (FLAG_PUBLISHERS.has(fn)) return;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      reads.get(flag).push(`${rel}:${line} (${fn})`);
    };
    walkDeep(sourceFile, (n) => {
      if (ts.isPropertyAccessExpression(n)) {
        const owner = unwrap(n.expression);
        if (
          ts.isPropertyAccessExpression(owner) &&
          owner.name.text === 'features' &&
          flags.has(n.name.text)
        ) {
          note(n, n.name.text);
        }
        return true;
      }
      if (ts.isCallExpression(n)) {
        const name = calleeName(n.expression);
        if (name && FLAG_BY_NAME_READERS.has(name)) {
          const arg = unwrap(n.arguments[1]);
          if (arg && ts.isStringLiteral(arg) && flags.has(arg.text)) note(n, arg.text);
        }
      }
      return true;
    });
  }
  return reads;
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
    // `plan.id === 'seedling'` — a tier NAMED IN THE SOURCE TEXT. Matched on
    // the literal side only: the other operand is whatever holds the id, and
    // matching THAT would drag in every legitimate `.planId` read (see the
    // header). Property access on the catalog (`PLANS.garden.id === x`) is not
    // special-cased; it lands here through the literal like everything else.
    if (ts.isBinaryExpression(n) && EQUALITY_OPERATORS.has(n.operatorToken.kind)) {
      const namesATier = [n.left, n.right]
        .map(unwrap)
        .some((side) => ts.isStringLiteral(side) && PLAN_IDS.has(side.text));
      if (namesATier) record(n, PLAN_ID_COMPARISON, exprText(n));
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

/**
 * The unenforced-flag check needs the WHOLE product tree to answer honestly:
 * "no gate reads this flag" is only true if every gate is in front of us. A
 * `--src` fixture is a slice, so the check is SKIPPED there and says so out
 * loud rather than reporting a green it did not earn. The catalog's presence
 * is the test for "this is the product tree".
 */
const scanIsWholeTree = existsSync(path.join(SRC, 'models', 'plans.ts'));
const unenforcedFlags = scanIsWholeTree
  ? [...scanFlagReads(FEATURE_FLAGS)].filter(([, sites]) => sites.length === 0).map(([f]) => f)
  : [];

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

if (
  added.length === 0 &&
  stale.length === 0 &&
  drifted.length === 0 &&
  malformed.length === 0 &&
  unenforcedFlags.length === 0
) {
  console.log(
    `Entitlement-gate ratchet passed: ${scanned} files scanned, ` +
      `${findings.size} accepted occurrences (baseline ${Object.keys(accepted).length}, ` +
      'ratchet-only), arguments unchanged.'
  );
  console.log(
    scanIsWholeTree
      ? `Published-flag check passed: all ${FEATURE_FLAGS.size} PlanFeatures flags are read by a gate.`
      : 'Published-flag check SKIPPED: --src is a fixture, not the product tree, ' +
          'so "no gate reads this flag" could not be answered.'
  );
  process.exit(0);
}

const addedRow = added.filter(
  (f) =>
    f.callee !== ISSUED_GRANT_READER &&
    f.callee !== CATALOG_INDEX &&
    f.callee !== PLAN_ID_COMPARISON
);
const addedLenient = added.filter((f) => f.callee === ISSUED_GRANT_READER);
const addedCatalog = added.filter((f) => f.callee === CATALOG_INDEX);
const addedComparison = added.filter((f) => f.callee === PLAN_ID_COMPARISON);

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

if (addedComparison.length > 0) {
  console.error(
    'A paid-feature decision made by NAMING A TIER in the source text.\n' +
      "`plan.id === 'seedling'` asks which tier a household is on. A gate wants to\n" +
      'know whether that tier INCLUDES the feature, which is a different question\n' +
      'with the same answer only for the tiers that exist right now. It stops being\n' +
      'the same answer the day a tier is added between two existing ones: the new\n' +
      "tier's `features` row is authored deliberately in models/plans.ts, and a\n" +
      'comparison naming one id ignores it. Nothing reports that — the tier just\n' +
      'gets a working feature, spending whatever the feature spends (#592).\n'
  );
  for (const f of addedComparison) {
    console.error(`  - ${f.key}  (line ${f.line}: ${f.arg})`);
  }
  console.error(
    '\nIf a PlanFeatures flag covers it, read the flag:\n' +
      "  featureOf(getEntitledPlan(sub), 'chat')\n" +
      'The Plan-taking form, so the gate still says WHICH plan it means.\n' +
      '(`planHasFeature(plan.id, …)` reaches the same answer by putting an already\n' +
      'resolved plan back through the plan ROW, and is a finding above for exactly\n' +
      'that reason — it is not the way out of this one.)\n' +
      'If it is not entitlement at all — a price rule, an upsell target, a lifecycle\n' +
      'event, an ordering test — add the entry to\n' +
      'backend/scripts/entitlement-gates-baseline.json with that reason.\n'
  );
}

if (unenforcedFlags.length > 0) {
  console.error(
    'A PlanFeatures flag is published to every client and read by no gate.\n' +
      '`planSummary` serialises the whole `features` map on GET /billing/plans, and\n' +
      "the interface's own docstring says a public surface must not advertise a flag\n" +
      'it cannot point at working code for. A flag nothing reads is not a capability;\n' +
      'it is a claim. Whatever enforces the feature is deciding by some OTHER value —\n' +
      'a tier name, a rank comparison — which agrees with the flag only for the tiers\n' +
      'that exist today, and drifts silently on the next one (#592, #605).\n'
  );
  for (const flag of unenforcedFlags) console.error(`  - features.${flag}`);
  console.error(
    '\nTwo ways out, and both are fine:\n' +
      "  - Gate on it: `featureOf(getEntitledPlan(sub), 'awayKit')`, or a named\n" +
      '    accessor in models/plans.ts that reads `plan.features.<flag>` and is\n' +
      '    called by the gates — that counts, and keeps one choke point.\n' +
      '  - Stop publishing it: remove the flag from PlanFeatures, so no client can\n' +
      '    read a value the server ignores.\n' +
      'What is NOT a way out is leaving the flag authored on every tier while the\n' +
      'enforcement asks a different question. That is the defect, not the workaround.\n' +
      '(A read inside `planSummary` does not count: publishing it is the complaint.)\n'
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
