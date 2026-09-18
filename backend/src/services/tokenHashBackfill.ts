/**
 * One-time backfill for #450: re-key every credential row still stored under
 * its PLAINTEXT token so the table holds only digests.
 *
 * Five surfaces keyed their rows by the plaintext token before they were
 * hashed: plant tags, kiosk links, sitter links, caretaker seats and cutting
 * shares. Their read paths already resolve both generations (`readTokenRow` in
 * `utils/tokenHash.ts`), so this backfill is not what keeps anything working.
 * It is what ENDS the legacy generation, which otherwise never ends for two of
 * them: a plant tag and a kiosk link carry no expiry, so a label printed in
 * June or a wall display set up in August would sit in plaintext in every
 * backup for as long as it stays in use. (Sitter links, caretaker seats and
 * shares carry a TTL and would age out on their own; the backfill just stops
 * waiting for that.)
 *
 * WHY THE SAME TOKEN KEEPS WORKING. Re-keying computes the digest of the token
 * the row already holds and moves the row to `{PREFIX}#{digest}`, which is
 * exactly the key `getActiveTag` (and its siblings) read FIRST. The credential
 * itself does not change, so a printed QR code, a link in someone's messages
 * and a kiosk's bookmarked URL all resolve to the same row as before — through
 * the hashed read instead of the fallback. Nothing has to be reprinted, re-sent
 * or re-paired, which is the whole reason to backfill rather than rotate.
 *
 * WHY EACH ROW IS ONE TRANSACTION. The re-keyed copy is written and the
 * legacy row is deleted in a single `TransactWriteItems`, with two conditions:
 *   - the copy's key must not already exist (never overwrite a hashed row);
 *   - the legacy row must still exist and every attribute a live request can
 *     change on it (`status`, the PIN lockout, the photo count, …) must still
 *     hold the value this run read.
 * So a revocation that lands between the scan and the write cancels that
 * row's move instead of resurrecting the tag as active under its new key, and
 * a row deleted in between (a departing member's share, an erased account) is
 * not re-created. A cancelled row is counted as `raced` and left exactly as it
 * was; the backfill is idempotent, so running it again picks it up.
 *
 * WHAT IT NEVER DOES. It never prints a token (a legacy row's PK IS the
 * token, so rows are identified by id and household only). It never touches a
 * row it cannot prove is a legacy row of the surface it is scanning (see
 * `classifyRow`). And for cutting shares it also drops the free-text
 * `plantSnapshot.notes` that shares minted before #741 still carry at rest —
 * the read path already refuses to serve it; this removes the copy.
 *
 * The CLI is `src/scripts/backfillTokenHashes.ts`: dry run by default.
 */
import { ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { hashCapabilityToken, type TokenHashSurface } from '../utils/tokenHash.js';

export type BackfillSurfaceName =
  'plantTag' | 'kioskLink' | 'sitterLink' | 'caretakerSeat' | 'plantShare';

export interface LegacySurface {
  name: BackfillSurfaceName;
  /** Which salt in `TOKEN_HASH_SALTS` — must match the service's read path. */
  surface: TokenHashSurface;
  /** Partition-key prefix, including the `#`. */
  prefix: string;
  /** Where a legacy row kept its plaintext (the records were spread on). */
  plaintextAttribute: 'token' | 'code';
  /** Where a hashed row keeps its digest (the services' `keyToken` source). */
  hashAttribute: 'tokenHash' | 'codeHash';
  /** The shape every token of this surface was minted in. */
  tokenPattern: RegExp;
  /**
   * Every attribute a live request can change on the base row. The legacy
   * delete is conditioned on each still holding the value read, so a
   * concurrent change cancels the move rather than being lost by it.
   */
  mutableAttributes: readonly string[];
  /** Anything else that must not survive the move. */
  scrub?: (item: Record<string, unknown>) => Record<string, unknown>;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The registry. Salts and prefixes are restated from each service rather than
 * imported, because the services do not export them — and
 * `tests/unit/services/tokenHashBackfill.test.ts` proves each entry against
 * the service's OWN read path (a row this backfill writes must resolve through
 * `getActiveTag`, `getActiveLink`, …), so a drift fails there.
 */
export const LEGACY_SURFACES: Record<BackfillSurfaceName, LegacySurface> = {
  plantTag: {
    name: 'plantTag',
    surface: 'plantTag',
    prefix: 'PLANTTAG#',
    plaintextAttribute: 'token',
    hashAttribute: 'tokenHash',
    tokenPattern: HEX64,
    // revokeRow, bumpFailures, lockTag, clearFailures (plantTagService.ts).
    mutableAttributes: ['status', 'revokedAt', 'ttl', 'pinFailures', 'pinLockedUntil'],
  },
  kioskLink: {
    name: 'kioskLink',
    surface: 'kioskLink',
    prefix: 'KIOSK#',
    plaintextAttribute: 'token',
    hashAttribute: 'tokenHash',
    tokenPattern: HEX64,
    mutableAttributes: ['status'],
  },
  sitterLink: {
    name: 'sitterLink',
    surface: 'sitterLink',
    prefix: 'SITTER#',
    plaintextAttribute: 'token',
    hashAttribute: 'tokenHash',
    tokenPattern: HEX64,
    // Revocation, and the photo-back quota (sitterPhotoService.ts).
    mutableAttributes: ['status', 'photoCount'],
  },
  caretakerSeat: {
    name: 'caretakerSeat',
    surface: 'caretakerSeat',
    prefix: 'CARETAKER#',
    plaintextAttribute: 'token',
    hashAttribute: 'tokenHash',
    tokenPattern: HEX64,
    mutableAttributes: ['status'],
  },
  plantShare: {
    name: 'plantShare',
    surface: 'plantShare',
    prefix: 'SHARE#',
    plaintextAttribute: 'code',
    hashAttribute: 'codeHash',
    tokenPattern: /^[0-9a-f]{32}$/,
    // A share is never updated in place — only deleted, which the
    // `attribute_exists(PK)` half of the condition covers.
    mutableAttributes: [],
    scrub: (item) => {
      const snapshot = item.plantSnapshot;
      if (!snapshot || typeof snapshot !== 'object' || !('notes' in snapshot)) return item;
      // The pre-#741 residue: the source plant's private free-text notes.
      const rest: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
      delete rest.notes;
      return { ...item, plantSnapshot: rest };
    },
  },
};

export const BACKFILL_SURFACE_NAMES = Object.keys(LEGACY_SURFACES) as BackfillSurfaceName[];

export type RowClassification =
  { kind: 'legacy'; token: string } | { kind: 'skip'; reason: string };

/**
 * Is this scanned row a legacy plaintext row of `surface` that the backfill may
 * re-key? Every condition is required, and any doubt is a skip — a row this
 * cannot account for is reported, never guessed at.
 */
export function classifyRow(
  surface: LegacySurface,
  item: Record<string, unknown>
): RowClassification {
  if (typeof item.PK !== 'string' || !item.PK.startsWith(surface.prefix)) {
    return { kind: 'skip', reason: 'not this surface' };
  }
  if (item.SK !== 'METADATA') return { kind: 'skip', reason: 'not a credential row' };
  if (item[surface.hashAttribute] !== undefined) return { kind: 'skip', reason: 'already hashed' };
  const token = item[surface.plaintextAttribute];
  if (typeof token !== 'string') return { kind: 'skip', reason: 'no plaintext on the row' };
  if (!surface.tokenPattern.test(token)) {
    return { kind: 'skip', reason: 'plaintext is not a token of this surface' };
  }
  // The row must be keyed by its OWN plaintext. Anything else is not the
  // shape this migration is for.
  if (item.PK !== `${surface.prefix}${token}`) {
    return { kind: 'skip', reason: 'partition key is not the row’s own token' };
  }
  return { kind: 'legacy', token };
}

/** The hashed replacement: same attributes, digest key, no plaintext. */
export function rekeyedItem(
  surface: LegacySurface,
  item: Record<string, unknown>,
  token: string
): Record<string, unknown> {
  const digest = hashCapabilityToken(surface.surface, token);
  const rest: Record<string, unknown> = { ...item };
  delete rest[surface.plaintextAttribute];
  const scrubbed = surface.scrub ? surface.scrub(rest) : rest;
  return { ...scrubbed, PK: `${surface.prefix}${digest}`, [surface.hashAttribute]: digest };
}

/**
 * The legacy delete's condition: the row still exists, and each mutable
 * attribute is exactly as read — present with the same value, or still absent.
 * A `null` is compared by type, because DynamoDB's `=` does not match NULL.
 */
export function unchangedCondition(
  surface: LegacySurface,
  item: Record<string, unknown>
): {
  ConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
} {
  const clauses = ['attribute_exists(PK)'];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  surface.mutableAttributes.forEach((attribute, index) => {
    const name = `#m${index}`;
    names[name] = attribute;
    const value = item[attribute];
    if (value === undefined) {
      clauses.push(`attribute_not_exists(${name})`);
    } else if (value === null) {
      values[`:m${index}`] = 'NULL';
      clauses.push(`attribute_type(${name}, :m${index})`);
    } else {
      values[`:m${index}`] = value;
      clauses.push(`${name} = :m${index}`);
    }
  });
  return {
    ConditionExpression: clauses.join(' AND '),
    ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
  };
}

/** How a row is named in output. NEVER the PK — for a legacy row it is the
 *  token. */
export function rowRef(item: Record<string, unknown>): string {
  const id = typeof item.id === 'string' ? item.id : '-';
  const household = typeof item.householdId === 'string' ? item.householdId : '-';
  return `id=${id} household=${household}`;
}

export interface SurfaceReport {
  surface: BackfillSurfaceName;
  /** Legacy rows found (in a dry run: would be re-keyed). */
  legacy: number;
  /** Re-keyed and the plaintext row deleted, atomically. */
  rekeyed: number;
  /** Changed or deleted by a live request between read and write; left as
   *  they were. Re-run to pick them up. */
  raced: number;
  /** Rows under the prefix this backfill will not touch, with the reason. */
  skipped: Array<{ ref: string; reason: string }>;
}

function isTransactionCancelled(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'TransactionCanceledException' || err.name === 'ConditionalCheckFailedException')
  );
}

/** Every row under the prefix that still carries a plaintext attribute. */
async function scanCandidates(surface: LegacySurface): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamodb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(PK, :prefix) AND attribute_exists(#plain)',
        ExpressionAttributeNames: { '#plain': surface.plaintextAttribute },
        ExpressionAttributeValues: { ':prefix': surface.prefix },
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

/**
 * Re-key one row, atomically. Resolves to `rekeyed` or `raced`; anything
 * other than a cancelled condition propagates, because "we could not write"
 * must not be reported as "there was nothing to do".
 */
export async function rekeyRow(
  surface: LegacySurface,
  item: Record<string, unknown>,
  token: string
): Promise<'rekeyed' | 'raced'> {
  const replacement = rekeyedItem(surface, item, token);
  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: replacement,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Delete: {
              TableName: TABLE_NAME,
              Key: { PK: item.PK, SK: item.SK },
              ...unchangedCondition(surface, item),
            },
          },
        ],
      })
    );
    return 'rekeyed';
  } catch (err) {
    if (isTransactionCancelled(err)) return 'raced';
    throw err;
  }
}

/**
 * Backfill one surface. `apply: false` (the default everywhere) reads and
 * reports only.
 */
export async function backfillSurface(
  surface: LegacySurface,
  options: { apply: boolean }
): Promise<SurfaceReport> {
  const report: SurfaceReport = {
    surface: surface.name,
    legacy: 0,
    rekeyed: 0,
    raced: 0,
    skipped: [],
  };
  for (const item of await scanCandidates(surface)) {
    const verdict = classifyRow(surface, item);
    if (verdict.kind === 'skip') {
      report.skipped.push({ ref: rowRef(item), reason: verdict.reason });
      continue;
    }
    report.legacy += 1;
    if (!options.apply) continue;
    const outcome = await rekeyRow(surface, item, verdict.token);
    report[outcome] += 1;
  }
  return report;
}
