/**
 * A small in-memory DynamoDB document store for the real-handler integration
 * suite (see ./invokeHandler.ts and ../README.md).
 *
 * WHY THIS EXISTS
 * ---------------
 * The unit tests mock the *service* modules (taskService, plantService, …)
 * wholesale, so they never exercise the real DynamoDB access code. The
 * real-handler integration tests want the opposite trade: run the REAL
 * handlers, the REAL middy middleware chain, AND the REAL services, with only
 * the AWS SDK boundary faked. This store backs `dynamodb.send(command)` with a
 * faithful-enough single-table implementation so that real service code
 * (single-table keys, GSIs, conditional writes, transactions) runs unchanged.
 *
 * SCOPE / FIDELITY
 * ----------------
 * This is deliberately NOT a general DynamoDB emulator. It implements exactly
 * the command + expression dialect the services in this repo use:
 *   - Get / Put / Delete / Update / Query / Scan / TransactWrite / BatchWrite
 *   - KeyConditionExpression: `PK = :pk [AND begins_with(SK, :sk)
 *       | AND SK <= :v | AND SK BETWEEN :a AND :b]`, and the same against the
 *       GSI hash/range attributes via IndexName.
 *   - FilterExpression: `attr = :v` (single equality — used by the household scan).
 *   - ConditionExpression: attribute_exists / attribute_not_exists, `#a = :v`,
 *       numeric `<` / `>`, and OR/AND combinations of those.
 *   - UpdateExpression: `SET ... [REMOVE ...]` with `if_not_exists(attr, :base)`
 *       and `+`/`-` arithmetic; references to other live attributes (`= #other`).
 *
 * Anything outside that dialect throws a loud `UnsupportedExpressionError`
 * rather than silently mis-evaluating — if a service grows a new expression
 * form, the integration test fails with a clear pointer instead of a false pass.
 *
 * Conditional failures are surfaced exactly as the SDK would: a single-item
 * write throws `ConditionalCheckFailedException`; a transaction throws
 * `TransactionCanceledException` carrying per-item `CancellationReasons`, which
 * is precisely what the services pattern-match on.
 */

const GSIS = {
  GSI1: { pk: 'GSI1PK', sk: 'GSI1SK' },
  GSI2: { pk: 'GSI2PK', sk: 'GSI2SK' },
} as const;

type Item = Record<string, unknown>;

export class UnsupportedExpressionError extends Error {
  constructor(message: string) {
    super(`[inMemoryDynamo] unsupported expression: ${message}`);
    this.name = 'UnsupportedExpressionError';
  }
}

function ddbError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name, ...extra });
}

function keyStr(pk: unknown, sk: unknown): string {
  return `${String(pk)}\u0000${String(sk)}`;
}

/** Substitute #name placeholders from ExpressionAttributeNames. */
function resolveName(token: string, names: Record<string, string> | undefined): string {
  if (token.startsWith('#')) {
    const real = names?.[token];
    if (!real) throw new UnsupportedExpressionError(`unknown name placeholder ${token}`);
    return real;
  }
  return token;
}

interface CommandLike {
  constructor: { name: string };
  input: Record<string, unknown>;
}

export interface InMemoryDynamo {
  /** The drop-in replacement for the real `dynamodb` document client. */
  client: { send: (command: CommandLike) => Promise<unknown> };
  /** Reset all rows (call in beforeEach). */
  reset: () => void;
  /** Raw row access for seeding/inspection in tests. */
  put: (item: Item) => void;
  all: () => Item[];
}

export function createInMemoryDynamo(): InMemoryDynamo {
  // PK\0SK -> item
  const table = new Map<string, Item>();

  function getItem(pk: unknown, sk: unknown): Item | undefined {
    return table.get(keyStr(pk, sk));
  }

  // --- ConditionExpression evaluation ---------------------------------------
  // Supports the small grammar the services use: attribute_exists(X),
  // attribute_not_exists(X), `#a = :v`, `#a < :v`, `#a > :v`, parenthesized
  // groups, and AND / OR between them. Returns true when the condition holds.
  function evalCondition(
    expr: string,
    item: Item | undefined,
    names: Record<string, string> | undefined,
    values: Record<string, unknown> | undefined
  ): boolean {
    const trimmed = expr.trim();

    // Split on top-level OR first (lowest precedence), then AND.
    const orParts = splitTopLevel(trimmed, 'OR');
    if (orParts.length > 1) {
      return orParts.some((p) => evalCondition(p, item, names, values));
    }
    const andParts = splitTopLevel(trimmed, 'AND');
    if (andParts.length > 1) {
      return andParts.every((p) => evalCondition(p, item, names, values));
    }

    // Single comparator. Strip a wrapping paren group.
    let atom = trimmed;
    if (atom.startsWith('(') && atom.endsWith(')')) {
      atom = atom.slice(1, -1).trim();
      return evalCondition(atom, item, names, values);
    }

    let m = atom.match(/^attribute_exists\(\s*([#\w]+)\s*\)$/);
    if (m) {
      const attr = resolveName(m[1], names);
      return item !== undefined && item[attr] !== undefined;
    }
    m = atom.match(/^attribute_not_exists\(\s*([#\w]+)\s*\)$/);
    if (m) {
      const attr = resolveName(m[1], names);
      return item === undefined || item[attr] === undefined;
    }
    m = atom.match(/^([#\w]+)\s*(<=|>=|<|>|=)\s*(:[\w]+)$/);
    if (m) {
      const attr = resolveName(m[1], names);
      const op = m[2];
      const val = values?.[m[3]];
      const actual = item?.[attr];
      if (op === '=') return actual === val;
      if (actual === undefined || val === undefined) return false;
      const a = actual as number;
      const b = val as number;
      if (op === '<') return a < b;
      if (op === '>') return a > b;
      if (op === '<=') return a <= b;
      if (op === '>=') return a >= b;
    }
    throw new UnsupportedExpressionError(`condition atom "${atom}"`);
  }

  // --- KeyConditionExpression evaluation ------------------------------------
  // Returns a predicate for a Query against the base table or a GSI. Supports
  // `PK = :pk` optionally ANDed with a single SK predicate.
  function buildKeyMatcher(
    expr: string,
    names: Record<string, string> | undefined,
    values: Record<string, unknown> | undefined
  ): (item: Item) => boolean {
    const parts = splitTopLevel(expr.trim(), 'AND');
    const predicates: Array<(item: Item) => boolean> = [];
    for (const partRaw of parts) {
      const part = partRaw.trim();
      let m = part.match(/^([#\w]+)\s*=\s*(:[\w]+)$/);
      if (m) {
        const attr = resolveName(m[1], names);
        const val = values?.[m[2]];
        predicates.push((item) => item[attr] === val);
        continue;
      }
      m = part.match(/^begins_with\(\s*([#\w]+)\s*,\s*(:[\w]+)\s*\)$/);
      if (m) {
        const attr = resolveName(m[1], names);
        const val = values?.[m[2]] as string;
        predicates.push(
          (item) => typeof item[attr] === 'string' && (item[attr] as string).startsWith(val)
        );
        continue;
      }
      m = part.match(/^([#\w]+)\s*(<=|>=|<|>)\s*(:[\w]+)$/);
      if (m) {
        const attr = resolveName(m[1], names);
        const op = m[2];
        const val = values?.[m[3]] as string;
        predicates.push((item) => {
          const a = item[attr] as string;
          if (a === undefined) return false;
          if (op === '<') return a < val;
          if (op === '>') return a > val;
          if (op === '<=') return a <= val;
          return a >= val;
        });
        continue;
      }
      m = part.match(/^([#\w]+)\s+BETWEEN\s+(:[\w]+)\s+AND\s+(:[\w]+)$/);
      if (m) {
        const attr = resolveName(m[1], names);
        const lo = values?.[m[2]] as string;
        const hi = values?.[m[3]] as string;
        predicates.push((item) => {
          const a = item[attr] as string;
          return a !== undefined && a >= lo && a <= hi;
        });
        continue;
      }
      throw new UnsupportedExpressionError(`key condition part "${part}"`);
    }
    return (item) => predicates.every((p) => p(item));
  }

  // --- UpdateExpression application ------------------------------------------
  function applyUpdate(
    existing: Item | undefined,
    key: { PK: unknown; SK: unknown },
    updateExpr: string,
    names: Record<string, string> | undefined,
    values: Record<string, unknown> | undefined
  ): Item {
    const item: Item = existing ? { ...existing } : { ...key };

    // Split into SET ... and REMOVE ... clauses (the only two used).
    const setMatch = updateExpr.match(/SET\s+(.+?)(?:\s+REMOVE\s+|$)/i);
    const removeMatch = updateExpr.match(/REMOVE\s+(.+)$/i);

    if (setMatch) {
      for (const assignRaw of splitTopLevel(setMatch[1], ',')) {
        const assign = assignRaw.trim();
        const eq = assign.indexOf('=');
        if (eq === -1) throw new UnsupportedExpressionError(`SET clause "${assign}"`);
        const lhs = resolveName(assign.slice(0, eq).trim(), names);
        const rhs = assign.slice(eq + 1).trim();
        item[lhs] = evalUpdateValue(rhs, item, names, values);
      }
    }
    if (removeMatch) {
      for (const attrRaw of removeMatch[1].split(',')) {
        const attr = resolveName(attrRaw.trim(), names);
        delete item[attr];
      }
    }
    return item;
  }

  function evalUpdateValue(
    rhs: string,
    item: Item,
    names: Record<string, string> | undefined,
    values: Record<string, unknown> | undefined
  ): unknown {
    // if_not_exists(attr, :base) [+ :one] | [- :one]
    const inf = rhs.match(/^if_not_exists\(\s*([#\w]+)\s*,\s*(:[\w]+)\s*\)\s*([+-])\s*(:[\w]+)$/);
    if (inf) {
      const attr = resolveName(inf[1], names);
      const base = item[attr] !== undefined ? (item[attr] as number) : (values?.[inf[2]] as number);
      const operand = values?.[inf[4]] as number;
      return inf[3] === '+' ? base + operand : base - operand;
    }
    const infOnly = rhs.match(/^if_not_exists\(\s*([#\w]+)\s*,\s*(:[\w]+)\s*\)$/);
    if (infOnly) {
      const attr = resolveName(infOnly[1], names);
      return item[attr] !== undefined ? item[attr] : values?.[infOnly[2]];
    }
    // `:value`
    if (/^:[\w]+$/.test(rhs)) {
      if (!values || !(rhs in values)) throw new UnsupportedExpressionError(`value ${rhs}`);
      return values[rhs];
    }
    // reference to another live attribute, e.g. `GSI2SK = #nextDue`
    if (/^[#\w]+$/.test(rhs)) {
      const attr = resolveName(rhs, names);
      return item[attr];
    }
    throw new UnsupportedExpressionError(`SET rhs "${rhs}"`);
  }

  // --- command dispatch ------------------------------------------------------
  async function send(command: CommandLike): Promise<unknown> {
    const name = command.constructor.name;
    const input = command.input;
    const names = input.ExpressionAttributeNames as Record<string, string> | undefined;
    const values = input.ExpressionAttributeValues as Record<string, unknown> | undefined;

    if (name === 'GetCommand') {
      const key = input.Key as { PK: unknown; SK: unknown };
      const item = getItem(key.PK, key.SK);
      return { Item: item ? { ...item } : undefined };
    }

    if (name === 'PutCommand') {
      const item = input.Item as Item;
      const cond = input.ConditionExpression as string | undefined;
      if (cond) {
        const existing = getItem(item.PK, item.SK);
        if (!evalCondition(cond, existing, names, values)) {
          throw ddbError('ConditionalCheckFailedException', 'The conditional request failed');
        }
      }
      table.set(keyStr(item.PK, item.SK), { ...item });
      return {};
    }

    if (name === 'DeleteCommand') {
      const key = input.Key as { PK: unknown; SK: unknown };
      const cond = input.ConditionExpression as string | undefined;
      const existing = getItem(key.PK, key.SK);
      if (cond && !evalCondition(cond, existing, names, values)) {
        throw ddbError('ConditionalCheckFailedException', 'The conditional request failed');
      }
      table.delete(keyStr(key.PK, key.SK));
      return {};
    }

    if (name === 'UpdateCommand') {
      const key = input.Key as { PK: unknown; SK: unknown };
      const cond = input.ConditionExpression as string | undefined;
      const existing = getItem(key.PK, key.SK);
      if (cond && !evalCondition(cond, existing, names, values)) {
        throw ddbError('ConditionalCheckFailedException', 'The conditional request failed');
      }
      const updated = applyUpdate(existing, key, input.UpdateExpression as string, names, values);
      table.set(keyStr(key.PK, key.SK), updated);
      const ret = input.ReturnValues as string | undefined;
      return ret === 'ALL_NEW' ? { Attributes: { ...updated } } : {};
    }

    if (name === 'QueryCommand') {
      const indexName = input.IndexName as keyof typeof GSIS | undefined;
      const { pk: hashAttr, sk: rangeAttr } = indexName ? GSIS[indexName] : { pk: 'PK', sk: 'SK' };
      const matcher = buildKeyMatcher(input.KeyConditionExpression as string, names, values);
      let items = [...table.values()].filter((item) => {
        // GSI membership: an item only appears in a GSI when its hash key
        // attribute is present (sparse index) — mirrors real DynamoDB.
        if (indexName && item[hashAttr] === undefined) return false;
        return matcher(item);
      });
      // Optional FilterExpression applied AFTER key match.
      const filter = input.FilterExpression as string | undefined;
      if (filter) {
        items = items.filter((item) => evalCondition(filter, item, names, values));
      }
      // Sort by range attribute (string compare); honor ScanIndexForward.
      items.sort((a, b) => {
        const av = String(a[rangeAttr] ?? '');
        const bv = String(b[rangeAttr] ?? '');
        return av < bv ? -1 : av > bv ? 1 : 0;
      });
      if (input.ScanIndexForward === false) items.reverse();
      return { Items: items.map((i) => ({ ...i })) };
    }

    if (name === 'ScanCommand') {
      let items = [...table.values()];
      const filter = input.FilterExpression as string | undefined;
      if (filter) {
        items = items.filter((item) => evalCondition(filter, item, names, values));
      }
      return { Items: items.map((i) => ({ ...i })) };
    }

    if (name === 'TransactWriteCommand') {
      const transactItems = input.TransactItems as Array<Record<string, Record<string, unknown>>>;
      // Two-phase: evaluate every condition against the CURRENT table first.
      // Any failure cancels the whole transaction with per-item reasons —
      // exactly the shape the services pattern-match on.
      const reasons: Array<{ Code?: string }> = [];
      let anyFailed = false;
      for (const ti of transactItems) {
        const op = Object.keys(ti)[0];
        const body = ti[op];
        const cond = body.ConditionExpression as string | undefined;
        let ok = true;
        if (cond) {
          const key =
            (body.Key as { PK: unknown; SK: unknown }) ??
            (body.Item as { PK: unknown; SK: unknown });
          const existing = getItem(key.PK, key.SK);
          ok = evalCondition(
            cond,
            existing,
            body.ExpressionAttributeNames as never,
            body.ExpressionAttributeValues as never
          );
        }
        reasons.push(ok ? { Code: 'None' } : { Code: 'ConditionalCheckFailed' });
        if (!ok) anyFailed = true;
      }
      if (anyFailed) {
        throw ddbError('TransactionCanceledException', 'Transaction cancelled', {
          CancellationReasons: reasons,
        });
      }
      // Commit phase.
      for (const ti of transactItems) {
        const op = Object.keys(ti)[0];
        const body = ti[op];
        if (op === 'Put') {
          const item = body.Item as Item;
          table.set(keyStr(item.PK, item.SK), { ...item });
        } else if (op === 'Delete') {
          const key = body.Key as { PK: unknown; SK: unknown };
          table.delete(keyStr(key.PK, key.SK));
        } else if (op === 'Update') {
          const key = body.Key as { PK: unknown; SK: unknown };
          const existing = getItem(key.PK, key.SK);
          const updated = applyUpdate(
            existing,
            key,
            body.UpdateExpression as string,
            body.ExpressionAttributeNames as never,
            body.ExpressionAttributeValues as never
          );
          table.set(keyStr(key.PK, key.SK), updated);
        } else {
          throw new UnsupportedExpressionError(`transact op "${op}"`);
        }
      }
      return {};
    }

    if (name === 'BatchWriteCommand') {
      const req = input.RequestItems as Record<
        string,
        Array<Record<string, Record<string, unknown>>>
      >;
      for (const writes of Object.values(req)) {
        for (const w of writes) {
          if (w.DeleteRequest) {
            const key = w.DeleteRequest.Key as { PK: unknown; SK: unknown };
            table.delete(keyStr(key.PK, key.SK));
          } else if (w.PutRequest) {
            const item = w.PutRequest.Item as Item;
            table.set(keyStr(item.PK, item.SK), { ...item });
          }
        }
      }
      return {};
    }

    throw new UnsupportedExpressionError(`command ${name}`);
  }

  return {
    client: { send },
    reset: () => table.clear(),
    put: (item: Item) => table.set(keyStr(item.PK, item.SK), { ...item }),
    all: () => [...table.values()].map((i) => ({ ...i })),
  };
}

/**
 * Split `expr` on a top-level boolean keyword / separator, ignoring any that
 * appear inside parentheses. `sep` is one of 'AND' | 'OR' | ','.
 */
function splitTopLevel(expr: string, sep: 'AND' | 'OR' | ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  let i = 0;
  const isWord = sep !== ',';
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0) {
      if (!isWord && ch === ',') {
        out.push(buf);
        buf = '';
        i++;
        continue;
      }
      if (isWord) {
        // Match the keyword on a word boundary, surrounded by whitespace.
        const ahead = expr.slice(i);
        const re = new RegExp(`^\\s+${sep}\\s+`, 'i');
        const m = ahead.match(re);
        if (m) {
          out.push(buf);
          buf = '';
          i += m[0].length;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}
