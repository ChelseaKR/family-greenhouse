#!/usr/bin/env node
/**
 * Settled-read-state gate for the backend — a RATCHET, not a hard zero. Run
 * by `npm run reads:check` (root `npm run verify`, which fans out to both
 * workspaces) and CI's Lint job. The rule it enforces is
 * [ADR 0010](../../docs/adr/0010-settled-read-states.md); the frontend half
 * lives in `frontend/scripts/check-settled-read-states.mjs`.
 *
 * ## Why a backend half exists
 *
 * The frontend gate shipped first and the backend stayed enforced by hand.
 * That is how `identifyBudget.getUsage` was fixed (a failed DynamoDB read
 * returns `null`, "we do not know") while its next-door neighbour
 * `leafHealthBudget.getUsage` kept returning `0` from the same catch — the
 * number a household that has spent nothing this month also gets — and was
 * only noticed by chance in #388. A ratchet exists so the second one does not
 * depend on someone remembering the first.
 *
 * ## What it looks for
 *
 * A READ (see `READ_COMMANDS` / `READ_CALLEE` below: a DynamoDB / S3 / SSM /
 * Cognito get-style command, a counter read-back via `UpdateCommand` with
 * `ReturnValues`, a `fetch(`, or an awaited `getX()` / `listX()` / `lookupX()`
 * -shaped call) whose failure is caught and handed back as a value that a
 * genuine empty result also produces. Four syntactic shapes:
 *
 *   1. `catch-returns-empty` — the catch clause's terminal statement is
 *      `return 0` / `[]` / `{}` / `false` / `''` / `undefined` / bare `return`;
 *      or `return null` when the try block itself produces `null` on a
 *      success path (`?? null`, `: null`, `return null`); or any other literal
 *      the try block also uses as a default (`member?.name || 'Someone'` and
 *      then `return 'Someone'` in the catch); or an object literal none of
 *      whose properties names the failure (every value is an empty literal
 *      or a pass-through identifier, and no property is a literal the try
 *      block never produces — `available: false` against `available: true`
 *      counts as naming it; `blocked: false` against `blocked: used > limit`
 *      does not).
 *
 *   2. `catch-swallows-into-default` — the catch neither returns, throws,
 *      nor assigns anything, and the try assigns a `let` whose initializer
 *      is a literal. On failure the variable keeps its default and the
 *      function proceeds as though it had read that.
 *
 *   3. `catch-swallows-then-shared-return` — the try returns on the found
 *      path and falls through on the empty one, the catch swallows, and one
 *      `return` after the try serves both "nothing there" and "could not
 *      look".
 *
 *   4. `promise-catch-returns-empty` — `.catch(() => [])` (or `0`, `false`,
 *      `undefined`, `{}`, a no-op block) chained onto a read; `.catch(() =>
 *      null)` only when the chain itself also yields `null` on success.
 *
 * ## What it deliberately does NOT look for
 *
 *   - `result.Item?.used ?? 0` INSIDE a try. A missing row is a real zero;
 *     that default is the codebase's correct idiom (`identifyBudget.getUsage`).
 *   - A catch that ends in `throw`. Anything it returns before that is a
 *     specific, recognised condition (`ConditionalCheckFailedException` →
 *     `null` = "was not there"), and the unrecognised failures propagate.
 *   - A catch that returns a NAMED state — `{ status: 'unavailable' }`,
 *     `{ ok: false, reason: 'upstream_error' }`, `{ plantCount: null }` where
 *     the success path never writes `null`. The author has distinguished the
 *     outcome; whether the caller honours it is a review question.
 *   - Writes. A failed `PutCommand` reported as `false` is a different rule.
 *   - Consequence. Whether the collapsed value is a display name or a safety
 *     count is a human call — which is what the baseline's per-entry reason
 *     records, exactly as the frontend gate does.
 *
 * ## The ratchet
 *
 * `settled-read-states-baseline.json` pins the accepted occurrences, each with
 * the reason its collapse is not a false all-clear. The gate fails when
 *
 *   - a finding is not in the baseline (new debt), or
 *   - a baseline entry no longer matches a finding (stale entry — remove it in
 *     the same PR that fixed it, so the baseline can only shrink).
 *
 * Failing in BOTH directions is the point: a baseline that only ever grows is
 * a guardrail that cannot fail.
 *
 * Flags (for the gate's own tests): `--src <dir>` scans a different tree,
 * `--baseline <file>` diffs against a different baseline.
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
  : path.join(BACKEND_DIR, 'scripts', 'settled-read-states-baseline.json');

/**
 * SDK command constructors whose result is a read. `UpdateCommand` is added
 * dynamically when the call carries `ReturnValues` (the atomic-counter
 * read-back every budget in this codebase uses).
 */
const READ_COMMANDS = new Set([
  // DynamoDB (lib-dynamodb + client-dynamodb spellings)
  'GetCommand',
  'QueryCommand',
  'ScanCommand',
  'BatchGetCommand',
  'TransactGetCommand',
  'GetItemCommand',
  'BatchGetItemCommand',
  'TransactGetItemsCommand',
  // S3
  'GetObjectCommand',
  'HeadObjectCommand',
  'ListObjectsV2Command',
  'ListObjectVersionsCommand',
  // SSM / Secrets Manager
  'GetParameterCommand',
  'GetParametersCommand',
  'GetSecretValueCommand',
  // Cognito
  'AdminGetUserCommand',
  'GetUserCommand',
  'ListUsersCommand',
]);

/**
 * Awaited calls whose NAME says they read. Only awaited calls count: a read
 * that can fail in ADR 0010's sense is asynchronous, and restricting to
 * `await` keeps pure sync helpers (`isValidTimeZone(...)` inside a
 * `try { … } catch { return false }`) out of scope.
 */
const READ_CALLEE =
  /^(get|list|query|scan|find|fetch|read|lookup|load|count|search|resolve|check|is|has|exists|evaluate)([A-Z0-9_]|$)/;

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(abs);
    else if (/\.ts$/.test(entry.name) && !/\.(test|spec|d)\.ts$/.test(entry.name)) yield abs;
  }
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

/** `0`, `[]`, `{}`, `false`, `''`, `undefined`, `void 0`, or no expression. */
function isEmptyLiteral(e) {
  if (!e) return true;
  e = unwrap(e);
  if (ts.isNumericLiteral(e)) return Number(e.text) === 0;
  if (ts.isArrayLiteralExpression(e)) return e.elements.length === 0;
  if (ts.isObjectLiteralExpression(e)) return e.properties.length === 0;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text === '';
  if (ts.isIdentifier(e)) return e.text === 'undefined';
  if (ts.isVoidExpression(e)) return true;
  return false;
}

function isNullLiteral(e) {
  e = unwrap(e);
  return Boolean(e) && e.kind === ts.SyntaxKind.NullKeyword;
}

/** A scalar literal that is NOT empty: `'unavailable'`, `true`, `7`. */
function isNamedLiteral(e) {
  e = unwrap(e);
  if (!e) return false;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text !== '';
  if (ts.isNumericLiteral(e)) return Number(e.text) !== 0;
  return e.kind === ts.SyntaxKind.TrueKeyword;
}

/** Canonical text for comparing literals across the try and catch blocks. */
function literalKey(e) {
  e = unwrap(e);
  if (!e) return 'undefined';
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return `str:${e.text}`;
  if (ts.isNumericLiteral(e)) return `num:${Number(e.text)}`;
  if (e.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (e.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (e.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (ts.isIdentifier(e) && e.text === 'undefined') return 'undefined';
  if (ts.isVoidExpression(e)) return 'undefined';
  if (ts.isArrayLiteralExpression(e) && e.elements.length === 0) return '[]';
  if (ts.isObjectLiteralExpression(e) && e.properties.length === 0) return '{}';
  return null; // not a literal
}

/**
 * The leaves a value expression can evaluate to, looking through `??`, `||`,
 * and `?:`. `member?.name || 'Someone'` yields [member?.name, 'Someone'].
 */
function leaves(e, out = []) {
  e = unwrap(e);
  if (!e) return out;
  if (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    leaves(e.left, out);
    leaves(e.right, out);
  } else if (ts.isConditionalExpression(e)) {
    leaves(e.whenTrue, out);
    leaves(e.whenFalse, out);
  } else {
    out.push(e);
  }
  return out;
}

/** Walk `node` without descending into nested function bodies. */
function walkShallow(node, visit) {
  const rec = (n) => {
    if (visit(n) === false) return;
    ts.forEachChild(n, (child) => {
      if (ts.isFunctionLike(child)) return;
      rec(child);
    });
  };
  ts.forEachChild(node, (child) => {
    if (ts.isFunctionLike(child)) return;
    rec(child);
  });
}

/** Walk `node` including nested functions. */
function walkDeep(node, visit) {
  const rec = (n) => {
    if (visit(n) === false) return;
    ts.forEachChild(n, rec);
  };
  ts.forEachChild(node, rec);
}

function calleeName(callee) {
  callee = unwrap(callee);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function isReadNode(n) {
  if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
    if (READ_COMMANDS.has(n.expression.text)) return true;
    if (n.expression.text === 'UpdateCommand' && /\bReturnValues\b/.test(n.getText())) return true;
    return false;
  }
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'fetch') {
    return true;
  }
  if (ts.isAwaitExpression(n)) {
    const inner = unwrap(n.expression);
    if (ts.isCallExpression(inner)) {
      const name = calleeName(inner.expression);
      if (name && READ_CALLEE.test(name)) return true;
    }
  }
  return false;
}

/** Does this subtree perform a read (see the header for what counts)? */
function containsRead(node) {
  let hit = false;
  walkDeep(node, (n) => {
    if (hit) return false;
    if (isReadNode(n)) {
      hit = true;
      return false;
    }
    return true;
  });
  return hit;
}

/** For a promise chain: does the chain root read? */
function chainReads(receiver) {
  const text = receiver.getText();
  for (const cmd of READ_COMMANDS) if (text.includes(`new ${cmd}(`)) return true;
  if (/\bnew UpdateCommand\(/.test(text) && /\bReturnValues\b/.test(text)) return true;
  if (/\bfetch\(/.test(text)) return true;
  // Walk down `.then(...)` / `.finally(...)` to the root call.
  let cur = unwrap(receiver);
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const method = cur.expression.name.text;
    if (method === 'then' || method === 'finally' || method === 'catch') {
      cur = unwrap(cur.expression.expression);
      continue;
    }
    const name = calleeName(cur.expression);
    return Boolean(name && READ_CALLEE.test(name));
  }
  if (ts.isCallExpression(cur)) {
    const name = calleeName(cur.expression);
    return Boolean(name && READ_CALLEE.test(name));
  }
  return false;
}

/** The catch (or handler) block's terminal statement. */
function terminalOf(block) {
  const stmts = block.statements;
  if (stmts.length === 0) return { kind: 'fallthrough' };
  const last = stmts[stmts.length - 1];
  if (ts.isReturnStatement(last)) return { kind: 'return', expr: last.expression ?? null };
  if (ts.isThrowStatement(last)) return { kind: 'throw' };
  return { kind: 'fallthrough' };
}

function isAssignment(n) {
  if (ts.isBinaryExpression(n)) {
    const k = n.operatorToken.kind;
    return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
    return (
      n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken
    );
  }
  return false;
}

function assignedIdentifiers(node) {
  const names = new Set();
  walkShallow(node, (n) => {
    if (isAssignment(n)) {
      const target = ts.isBinaryExpression(n) ? unwrap(n.left) : unwrap(n.operand);
      if (ts.isIdentifier(target)) names.add(target.text);
    }
    return true;
  });
  return names;
}

/** Literal keys the try block can hand back as a value on a non-throwing path. */
function tryLiteralKeys(tryBlock) {
  const keys = new Set();
  const record = (e) => {
    for (const leaf of leaves(e)) {
      const key = literalKey(leaf);
      if (key !== null) keys.add(key);
    }
  };
  walkShallow(tryBlock, (n) => {
    if (ts.isReturnStatement(n)) record(n.expression);
    else if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      record(n.right);
    } else if (ts.isConditionalExpression(n)) {
      record(n.whenTrue);
      record(n.whenFalse);
    }
    return true;
  });
  return keys;
}

/** property name -> array of literal keys or 'expr', for every object literal in the try. */
function tryObjectProps(tryBlock) {
  const props = new Map();
  walkShallow(tryBlock, (n) => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) {
          const name = p.name.getText();
          const list = props.get(name) ?? [];
          for (const leaf of leaves(p.initializer)) list.push(literalKey(leaf) ?? 'expr');
          props.set(name, list);
        } else if (ts.isShorthandPropertyAssignment(p)) {
          const list = props.get(p.name.text) ?? [];
          list.push('expr');
          props.set(p.name.text, list);
        }
      }
    }
    return true;
  });
  return props;
}

/**
 * Is `expr` (returned from a catch) indistinguishable from a value the try
 * block produces on success? Returns a short reason string, or null.
 */
function collapseReason(expr, tryBlock, fnReturnsVoid) {
  const e = unwrap(expr);
  if (!e || (ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e)) {
    // A void function has no value to collapse; the swallow is a different
    // rule's business.
    return fnReturnsVoid ? null : 'returns undefined on failure';
  }
  if (isEmptyLiteral(e)) return `returns ${e.getText()} on failure`;
  const tryKeys = tryLiteralKeys(tryBlock);
  if (isNullLiteral(e)) {
    return tryKeys.has('null')
      ? 'returns null on failure, and the try block also yields null'
      : null;
  }
  if (isNamedLiteral(e)) {
    const key = literalKey(e);
    return tryKeys.has(key)
      ? `returns ${e.getText()} on failure, the same default the try block uses`
      : null;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const tryProps = tryObjectProps(tryBlock);
    let emptyProps = 0;
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) continue; // shorthand / spread: pass-through
      const name = p.name.getText();
      const v = unwrap(p.initializer);
      const key = literalKey(v);
      if (key === null) continue; // expression: pass-through
      const seen = tryProps.get(name) ?? [];
      if (isNamedLiteral(v)) return null; // a named state
      if (isNullLiteral(v)) {
        if (!seen.includes('null')) return null; // null means "unknown" here
        emptyProps += 1;
        continue;
      }
      // Empty literal: discriminates only if the try always writes a
      // different literal for this property (`available: true`).
      if (seen.length > 0 && seen.every((s) => s !== 'expr' && s !== key)) return null;
      emptyProps += 1;
    }
    // An object built entirely from expressions (an error response, say) is
    // not "empty-looking"; only one that writes a zero / false / [] somewhere is.
    if (emptyProps === 0) return null;
    return `returns ${e.getText().replace(/\s+/g, ' ')} on failure, which the success path can also produce`;
  }
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

function returnsVoid(fn) {
  return Boolean(fn && fn.type && /\bvoid\b/.test(fn.type.getText()));
}

/** `let x = <literal>` declared in `fn` before `beforeNode`. */
function literalLets(fn, beforeNode) {
  const out = new Map();
  if (!fn || !fn.body) return out;
  walkShallow(fn.body, (n) => {
    if (n.pos >= beforeNode.pos) return false;
    if (ts.isVariableDeclarationList(n) && n.flags & ts.NodeFlags.Let) {
      for (const d of n.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && literalKey(d.initializer) !== null) {
          out.set(d.name.text, d.initializer.getText());
        }
      }
    }
    return true;
  });
  return out;
}

function laterSiblings(tryStmt) {
  const parent = tryStmt.parent;
  if (!parent || !ts.isBlock(parent)) return [];
  const at = parent.statements.indexOf(tryStmt);
  return at === -1 ? [] : parent.statements.slice(at + 1);
}

function laterSiblingReturns(tryStmt) {
  return laterSiblings(tryStmt).some((s) => ts.isReturnStatement(s));
}

/**
 * Is the defaulted variable rejected rather than proceeded on? `let applied =
 * false; try { … applied = … } catch {} if (!applied) throw err;` keeps the
 * default only long enough to throw on it — that is a settled failure, not
 * a collapse.
 */
function defaultLeadsToThrow(tryStmt, name) {
  const mentions = new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`);
  return laterSiblings(tryStmt).some((s) => {
    if (ts.isThrowStatement(s)) return true;
    if (ts.isIfStatement(s) && mentions.test(s.expression.getText())) {
      let throws = false;
      walkShallow(s.thenStatement, (n) => {
        if (ts.isThrowStatement(n)) throws = true;
        return !throws;
      });
      if (ts.isThrowStatement(s.thenStatement)) throws = true;
      return throws;
    }
    return false;
  });
}

function tryHasReturnAndFallsThrough(tryBlock) {
  let hasReturn = false;
  walkShallow(tryBlock, (n) => {
    if (ts.isReturnStatement(n)) hasReturn = true;
    return true;
  });
  if (!hasReturn) return false;
  const term = terminalOf(tryBlock);
  return term.kind === 'fallthrough';
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** key -> finding */
const findings = new Map();
let scanned = 0;

function addFinding(rel, fn, rule, line, why) {
  const base = `${rel}::${functionName(fn)}::${rule}`;
  let key = base;
  for (let i = 2; findings.has(key); i += 1) key = `${base}#${i}`;
  findings.set(key, { key, line, why });
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function scanFile(file) {
  const text = readFileSync(file, 'utf8');
  if (!/\bcatch\b/.test(text)) return;
  scanned += 1;
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  walkDeep(sourceFile, (node) => {
    if (ts.isTryStatement(node) && node.catchClause) {
      if (!containsRead(node.tryBlock)) return true;
      const fn = enclosingFunction(node);
      const catchBlock = node.catchClause.block;
      const term = terminalOf(catchBlock);
      const line = lineOf(sourceFile, node);

      if (term.kind === 'return') {
        const why = collapseReason(term.expr, node.tryBlock, returnsVoid(fn));
        if (why) addFinding(rel, fn, 'catch-returns-empty', line, why);
      } else if (term.kind === 'fallthrough') {
        const catchAssigns = assignedIdentifiers(catchBlock);
        if (catchAssigns.size === 0) {
          const tryAssigns = assignedIdentifiers(node.tryBlock);
          const lets = literalLets(fn, node);
          const defaulted = [...tryAssigns].find(
            (name) => lets.has(name) && !defaultLeadsToThrow(node, name)
          );
          if (defaulted) {
            addFinding(
              rel,
              fn,
              'catch-swallows-into-default',
              line,
              `\`${defaulted}\` keeps its initial ${lets.get(defaulted)} when the read fails`
            );
          } else if (tryHasReturnAndFallsThrough(node.tryBlock) && laterSiblingReturns(node)) {
            addFinding(
              rel,
              fn,
              'catch-swallows-then-shared-return',
              line,
              'the return after the try serves both "nothing there" and "could not look"'
            );
          }
        }
      }
      return true;
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch' &&
      node.arguments.length > 0
    ) {
      const receiver = node.expression.expression;
      if (!chainReads(receiver)) return true;
      const handler = unwrap(node.arguments[0]);
      if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return true;
      let expr;
      let fallthrough = false;
      if (ts.isBlock(handler.body)) {
        const term = terminalOf(handler.body);
        if (term.kind === 'throw') return true;
        if (term.kind === 'return') expr = term.expr;
        else fallthrough = true;
      } else {
        expr = handler.body;
      }
      const fn = enclosingFunction(node);
      const line = lineOf(sourceFile, node.expression.name);
      let why = null;
      if (fallthrough) why = 'the handler resolves the chain to undefined';
      else if (isEmptyLiteral(expr))
        why = `resolves to ${expr ? expr.getText() : 'undefined'} on failure`;
      else if (isNullLiteral(expr) && /(\?\?|\|\||:)\s*null\b/.test(receiver.getText())) {
        why = 'resolves to null on failure, and the chain also yields null on success';
      }
      if (why) addFinding(rel, fn, 'promise-catch-returns-empty', line, why);
    }
    return true;
  });
}

for (const file of sourceFiles(SRC)) scanFile(file);

// ---------------------------------------------------------------------------
// The ratchet
// ---------------------------------------------------------------------------

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const accepted = baseline.accepted ?? {};

const added = [...findings.values()].filter((f) => !(f.key in accepted));
const stale = Object.keys(accepted).filter((key) => !findings.has(key));

if (added.length === 0 && stale.length === 0) {
  console.log(
    `Settled-read-state gate (backend) passed: ${scanned} files scanned, ` +
      `${findings.size} accepted occurrences (baseline ${Object.keys(accepted).length}, ratchet-only).`
  );
  process.exit(0);
}

if (added.length > 0) {
  console.error(
    'A read that can fail hands back the same value a genuine empty result produces.\n' +
      'Downstream code then proceeds on a number, list, or default nobody actually read —\n' +
      'a DynamoDB blip becomes "0 used this month", "no keys", "not configured". See\n' +
      'ADR 0010 (docs/adr/0010-settled-read-states.md).\n'
  );
  for (const f of added) console.error(`  - ${f.key}  (line ${f.line}: ${f.why})`);
  console.error(
    '\nEither return a distinct settled-failed value (`number | null`, a discriminated\n' +
      'result) and make the fail-open / fail-closed decision explicit and logged at the\n' +
      'call site, or add the entry to backend/scripts/settled-read-states-baseline.json\n' +
      'with the reason its collapse cannot be mistaken for an all-clear.\n'
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
