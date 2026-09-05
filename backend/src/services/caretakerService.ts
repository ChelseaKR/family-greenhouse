/**
 * Caretaker seats — named, revocable, time-boxed helper identities.
 *
 * A caretaker is NOT a household member and NOT a Cognito user. It is a
 * token-scoped identity, exactly like a sitter link (`sitterService.ts`), with
 * two differences that are the whole point of the feature:
 *
 *   1. **It has a name.** A sitter link is anonymous — every completion it
 *      makes is attributed to "a plant sitter". A caretaker's actions carry
 *      the name the household typed when they created the seat, so the
 *      activity feed and the report can say *who* did the thing.
 *   2. **Its actions accumulate into visits.** Every action a caretaker takes
 *      lands in a visit record whose `startedAt` is that visit's FIRST action
 *      — the arrival timestamp — so the household can produce a dated,
 *      itemised record of what was done, for whoever is paying for it.
 *
 * ## Why token-scoped and not Cognito
 *
 * A Cognito user costs ~$0.0055/MAU above the free tier; a caretaker seat's
 * whole lifetime here is a handful of DynamoDB writes, which is ~$0.001 per
 * household per month. "No account" is also the better product: the person
 * watering the plants opens a link, and nothing asks them to register. See
 * `docs/adr/0020-token-scoped-caretaker-seats.md`.
 *
 * ## Permission surface
 *
 * `CARETAKER_PERMISSIONS` is the complete list, and it is strictly narrower
 * than a `member`: complete a task, add a photo, add a note. Nothing else —
 * no plant editing, no member management, no billing, no household settings,
 * and no visibility of (or power over) other caretakers. The list is exported
 * and asserted in tests so widening it is a deliberate, reviewed act rather
 * than a route someone quietly adds.
 *
 * ## Security model (inherited from sitter links, unchanged)
 *
 *   - 256-bit CSPRNG token, the only credential, in the URL path.
 *   - At rest the token is HASHED, never stored (#568). `PK =
 *     CARETAKER#{scrypt(token)}`, so a lookup is still one GetItem with no
 *     enumeration surface — the property the plaintext key was chosen for
 *     survives — while a table export, a point-in-time restore, or anyone with
 *     `dynamodb:Scan` now walks away with a digest instead of a live seat.
 *     This is the same migration #551 made for sitter and kiosk links, and it
 *     costs nothing here because the seat token is returned exactly once, at
 *     creation (`handlers/caretakers/management.ts`), and is never read back
 *     for display: `listCaretakers` goes through `toSummary`, which strips it.
 *   - Rows carry a DynamoDB `ttl`, AND every read re-checks `status` and the
 *     `[startsAt, expiresAt]` window, so a not-yet-swept row is never honoured
 *     past its window.
 *   - Validation failures are generic (null) so the public endpoints can't be
 *     used as a token-existence oracle.
 *
 * ## Seats minted before #568 keep working
 *
 * A caretaker whose link stops resolving cannot ask for a new one — they are
 * not the account holder and have no account at all. So rows written before
 * #568 (keyed by the PLAINTEXT token, carrying it as a `token` attribute) are
 * still resolved: `getActiveCaretaker` falls back to a second point read on
 * the legacy key. Both reads are `GetItem` on the partition key, so the
 * fallback costs one extra point read on a miss and adds no enumeration
 * surface.
 *
 * There is deliberately no rewrite-on-read: a delete + put on an anonymous
 * public read path can leave two live rows on a partial failure. The legacy
 * generation only ever shrinks on its own — every caretaker row carries a
 * `ttl` of `expiresAt` + 3 days, and `MAX_CARETAKER_DAYS` is 180, so the last
 * plaintext row deletes itself within one engagement window with nothing to
 * run.
 *
 * ## Reads never collapse into "nothing happened"
 *
 * `listVisits` deliberately does not catch. A failed read is an error the
 * caller must surface — a proof-of-visit report that cannot load its data has
 * to say so, because "no visits" and "we could not look" are opposite claims
 * to the person being handed the report (ADR 0010).
 */
import {
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { randomBytes, scryptSync } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { DynamoDBItem } from '../models/types.js';

export type CaretakerStatus = 'active' | 'revoked';

/**
 * Everything a caretaker may do, in full. Strictly narrower than `member`.
 * Adding an entry here without an ADR update is a review failure, not a
 * refactor — the narrowness is the product promise.
 */
export const CARETAKER_PERMISSIONS = [
  'task.complete',
  'photo.add',
  'note.add',
] as const satisfies readonly string[];

export type CaretakerPermission = (typeof CARETAKER_PERMISSIONS)[number];

/**
 * Capabilities a household `member` has that a caretaker must never gain.
 * Kept as data (not prose) so a test can assert the two sets stay disjoint.
 */
export const CARETAKER_FORBIDDEN_CAPABILITIES = [
  'plant.create',
  'plant.edit',
  'plant.delete',
  'member.invite',
  'member.remove',
  'member.role',
  'billing.manage',
  'household.settings',
  'caretaker.manage',
  'sitter.manage',
  'activity.read',
  'analytics.read',
  'export.read',
] as const satisfies readonly string[];

export interface Caretaker {
  /** Opaque id used in the management API (list/revoke). NOT the secret. */
  id: string;
  /**
   * The 256-bit secret token, present ONLY on the object `createCaretaker`
   * returns — that is the one moment it exists in this system. Since #568 it
   * is not stored, so a seat read back out of DynamoDB carries `null` here
   * unless it is a pre-#568 row that still holds its plaintext.
   */
  token: string | null;
  /**
   * The row's own partition-key suffix: the token's scrypt digest on rows
   * written since #568, the plaintext token on rows written before it. It
   * exists so revocation can address the base row of either generation
   * without the household ever holding a token. NEVER put it in a response —
   * for a legacy row it IS the secret; `toSummary` is the only thing that
   * should be handed to a caller.
   */
  keyToken: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  /** The caretaker's name. This is the attribution shown on every action. */
  name: string;
  /** Start of the engagement window (ISO). */
  startsAt: string;
  /** End of the engagement window (ISO). Enforced on every public call. */
  expiresAt: string;
  status: CaretakerStatus;
}

/** A caretaker seat as shown to the household — never the token, and never
 *  `keyToken` either (on a legacy row that value IS the token). */
export type CaretakerSummary = Omit<Caretaker, 'token' | 'keyToken'>;

/** A seat as it comes back from `createCaretaker` — the one place the
 *  plaintext token exists, and the only place it is non-null. */
export type MintedCaretaker = Caretaker & { token: string };

export interface CaretakerVisitTaskEntry {
  taskId: string;
  plantId: string;
  plantName: string;
  taskType: string;
  at: string;
}

export interface CaretakerVisitPhotoEntry {
  photoId: string;
  plantId: string;
  plantName: string;
  imageUrl: string;
  at: string;
}

export interface CaretakerVisitNoteEntry {
  text: string;
  at: string;
}

/**
 * One visit: a contiguous run of caretaker actions.
 *
 * `startedAt` is the timestamp of the FIRST action of the run — the arrival
 * time, as observed rather than as claimed. The `*Count` fields are the
 * authoritative totals; the arrays are capped (see VISIT_DETAIL_CAP) so a
 * single item can never outgrow DynamoDB's 400 KB limit, which is why the
 * report compares the two and says when detail is missing rather than
 * silently reporting the shorter number.
 */
export interface CaretakerVisit {
  id: string;
  householdId: string;
  caretakerId: string;
  caretakerName: string;
  startedAt: string;
  lastActionAt: string;
  tasksCompleted: CaretakerVisitTaskEntry[];
  photos: CaretakerVisitPhotoEntry[];
  notes: CaretakerVisitNoteEntry[];
  taskCount: number;
  photoCount: number;
  noteCount: number;
}

export type CaretakerAction =
  | { kind: 'task'; entry: CaretakerVisitTaskEntry }
  | { kind: 'photo'; entry: CaretakerVisitPhotoEntry }
  | { kind: 'note'; entry: CaretakerVisitNoteEntry };

/** Longest a caretaker engagement may run. Mirrors the sitter-link ceiling. */
export const MAX_CARETAKER_DAYS = 180;

/**
 * How long a gap may be before the next action counts as a NEW visit. Six
 * hours: long enough that a caretaker who waters, goes to lunch and comes
 * back files one visit; short enough that yesterday and today are never
 * merged into one line on an invoice.
 */
export const VISIT_IDLE_MS = 6 * 60 * 60 * 1000;

/** Per-visit cap on stored detail rows of each kind (counts stay exact). */
export const VISIT_DETAIL_CAP = 100;

// Buffer past expiresAt before the TTL sweeper may drop the row, so a
// clock-skewed sweep can't delete a seat that still reads active. Reads always
// re-check expiresAt, so the buffer is invisible. Mirrors sitterService.
const TTL_BUFFER_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Deterministic, memory-hard hash of a caretaker token — the row's partition
 * key. Same construction and same reasoning as `apiKeys.hashKey`,
 * `calendarTokens.hashToken` and `sitterService.hashToken`: a per-row random
 * salt (bcrypt/argon2) would make the point read impossible, and a fixed salt
 * costs nothing here because the input is a 256-bit CSPRNG value rather than a
 * human-chosen password, so there is no precomputation to defend against.
 * scrypt rather than SHA-256 because the repo's
 * `js/insufficient-password-hash` policy rejects an unsalted digest.
 *
 * The salt is DIFFERENT from every other credential's, so a token minted for
 * one surface can never resolve on another even if it is pasted there.
 */
function hashToken(token: string): string {
  return scryptSync(token, 'family-greenhouse-caretaker-v1', 32).toString('hex');
}

/** The base row's key, addressed by its partition-key SUFFIX — the token's
 *  hash on rows written since #568, the plaintext on rows written before it.
 *  Never pass a raw token here except on the legacy read fallback. */
const caretakerPk = (keyToken: string) => `CARETAKER#${keyToken}`;
const caretakerGsiPk = (householdId: string) => `HOUSEHOLD#${householdId}#CARETAKER`;
/** Partition holding a household's visit records AND its open-visit pointers. */
export const visitPk = (householdId: string) => `HOUSEHOLD#${householdId}#CARETAKER_VISIT`;
const openVisitSk = (caretakerId: string) => `OPEN#${caretakerId}`;
const visitSk = (startedAt: string, visitId: string) => `VISIT#${startedAt}#${visitId}`;

function itemToCaretaker(item: Record<string, unknown>): Caretaker {
  // `tokenHash` on rows written since #568; the plaintext `token` on rows
  // written before it. Either way this is exactly the row's PK suffix, which
  // is all revocation needs.
  const keyToken = (item.tokenHash as string | undefined) ?? (item.token as string);
  return {
    id: item.id as string,
    token: (item.token as string | undefined) ?? null,
    keyToken,
    householdId: item.householdId as string,
    createdBy: item.createdBy as string,
    createdAt: item.createdAt as string,
    name: item.name as string,
    startsAt: item.startsAt as string,
    expiresAt: item.expiresAt as string,
    status: item.status as CaretakerStatus,
  };
}

/** Strip the secret token — and the row's key suffix, which for a pre-#568 row
 *  IS the token — before handing a seat to the household. */
export function toSummary(caretaker: Caretaker): CaretakerSummary {
  const { token: _token, keyToken: _keyToken, ...summary } = caretaker;
  void _token;
  void _keyToken;
  return summary;
}

export async function createCaretaker(input: {
  householdId: string;
  createdBy: string;
  name: string;
  startsAt: string;
  expiresAt: string;
}): Promise<MintedCaretaker> {
  // 256-bit CSPRNG token — 64 hex chars, drawn from the OS CSPRNG. Do NOT
  // swap this for uuid()/Math.random (predictable / lower entropy).
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const id = uuid();
  const now = new Date().toISOString();

  // The item is written field by field rather than spread from the seat
  // record, because the record carries the plaintext and the row must NOT
  // (#568). A spread here is exactly how the plaintext got onto the row.
  const item: DynamoDBItem = {
    PK: caretakerPk(tokenHash),
    SK: 'METADATA',
    // Mirror onto GSI1 so the household can list its seats in one query.
    GSI1PK: caretakerGsiPk(input.householdId),
    GSI1SK: now,
    entityType: 'Caretaker',
    // Both the PK suffix and the attribute every revoke path reads through.
    // The plaintext appears nowhere on the row.
    tokenHash,
    id,
    householdId: input.householdId,
    createdBy: input.createdBy,
    createdAt: now,
    name: input.name,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    status: 'active',
    ttl: Math.floor((Date.parse(input.expiresAt) + TTL_BUFFER_MS) / 1000),
  };

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return {
    id,
    token,
    keyToken: tokenHash,
    householdId: input.householdId,
    createdBy: input.createdBy,
    createdAt: now,
    name: input.name,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    status: 'active',
  };
}

async function readCaretakerRow(pk: string): Promise<Record<string, unknown> | null> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: 'METADATA' } })
  );
  return (result?.Item as Record<string, unknown> | undefined) ?? null;
}

/**
 * Resolve a token to its seat ONLY if it is currently usable: it exists, is
 * active, and now is within [startsAt, expiresAt]. Any other state returns
 * null so the caller answers one generic 404 and the endpoint can't be used
 * to probe which tokens exist.
 */
export async function getActiveCaretaker(
  token: string,
  now: Date = new Date()
): Promise<Caretaker | null> {
  // Defensive length/charset gate: a token that can't be one of ours never
  // reaches DynamoDB. 64 lowercase hex chars only.
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  // Hashed row first — that is every seat minted since #568. A miss falls back
  // to the pre-#568 plaintext-keyed row so a caretaker's existing link keeps
  // working; they have no account and cannot ask for a replacement. BOTH are
  // GetItem on the partition key, so the fallback costs one extra point read
  // on a miss and adds no enumeration surface; and nothing here writes a
  // plaintext row back, so the legacy generation only ever shrinks (every
  // caretaker row carries a TTL).
  const item =
    (await readCaretakerRow(caretakerPk(hashToken(token)))) ??
    (await readCaretakerRow(caretakerPk(token)));
  if (!item) return null;

  const caretaker = itemToCaretaker(item);
  if (caretaker.status !== 'active') return null;
  const nowIso = now.toISOString();
  if (nowIso < caretaker.startsAt) return null; // window not open yet
  if (nowIso > caretaker.expiresAt) return null; // window closed
  return caretaker;
}

/**
 * Page size for the caretaker-seat listing. A transport detail, NOT a cap:
 * `listCaretakers` follows `LastEvaluatedKey` to exhaustion.
 *
 * `revokeCaretaker` locates its target by id in this list, so a bare
 * `Limit: 100` on a newest-first query answered 404 — "no such seat" — for a
 * seat whose token still resolved.
 */
const CARETAKER_PAGE_SIZE = 100;

/** All seats for a household (active + revoked, not yet TTL-swept), newest
 *  first. Rows carry `keyToken` (the row's own PK suffix) so the service layer
 *  can revoke them; since #568 they carry no plaintext token at all, and the
 *  HANDLER strips both via toSummary before responding. */
export async function listCaretakers(householdId: string): Promise<Caretaker[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': caretakerGsiPk(householdId) },
        ScanIndexForward: false,
        Limit: CARETAKER_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items.map(itemToCaretaker);
}

/**
 * Revoke a seat by its opaque id, scoped to the household so one household
 * can never revoke another's. Returns false when no matching row exists
 * (→ 404). Idempotent: revoking an already-revoked seat succeeds.
 *
 * Revocation is immediate and total — the token stops resolving on the next
 * call. Visits already recorded are NOT deleted: they are the household's
 * record of work that actually happened.
 */
export async function revokeCaretaker(householdId: string, id: string): Promise<boolean> {
  const caretakers = await listCaretakers(householdId);
  const target = caretakers.find((c) => c.id === id);
  if (!target) return false;

  await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      // The row's own partition-key suffix — the hash on rows written since
      // #568, the plaintext on pre-#568 rows — NOT a token the row no longer
      // stores. Keying off `target.token` here would address
      // `CARETAKER#undefined` and silently fail to revoke a live seat.
      Key: { PK: caretakerPk(target.keyToken), SK: 'METADATA' },
      UpdateExpression: 'SET #status = :revoked',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':revoked': 'revoked' },
      // Guard against a row swept by TTL between the list read and this write.
      ConditionExpression: 'attribute_exists(PK)',
    })
  );
  return true;
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

interface OpenVisitPointer {
  visitId: string;
  startedAt: string;
  lastActionAt: string;
}

const ACTION_FIELDS = {
  task: { list: 'tasksCompleted', count: 'taskCount' },
  photo: { list: 'photos', count: 'photoCount' },
  note: { list: 'notes', count: 'noteCount' },
} as const;

function itemToVisit(item: Record<string, unknown>): CaretakerVisit {
  return {
    id: item.id as string,
    householdId: item.householdId as string,
    caretakerId: item.caretakerId as string,
    caretakerName: item.caretakerName as string,
    startedAt: item.startedAt as string,
    lastActionAt: item.lastActionAt as string,
    tasksCompleted: (item.tasksCompleted as CaretakerVisitTaskEntry[]) ?? [],
    photos: (item.photos as CaretakerVisitPhotoEntry[]) ?? [],
    notes: (item.notes as CaretakerVisitNoteEntry[]) ?? [],
    taskCount: (item.taskCount as number) ?? 0,
    photoCount: (item.photoCount as number) ?? 0,
    noteCount: (item.noteCount as number) ?? 0,
  };
}

/** Read the open-visit pointer, or null when there isn't one. Errors are NOT
 *  caught: the caller decides, and a failed read must not masquerade as "this
 *  caretaker has no visit in progress". */
async function getOpenVisit(
  householdId: string,
  caretakerId: string
): Promise<OpenVisitPointer | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: visitPk(householdId), SK: openVisitSk(caretakerId) },
    })
  );
  if (!result.Item) return null;
  return {
    visitId: result.Item.visitId as string,
    startedAt: result.Item.startedAt as string,
    lastActionAt: result.Item.lastActionAt as string,
  };
}

async function putOpenVisit(
  householdId: string,
  caretakerId: string,
  pointer: OpenVisitPointer
): Promise<void> {
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: visitPk(householdId),
        SK: openVisitSk(caretakerId),
        entityType: 'CaretakerOpenVisit',
        householdId,
        caretakerId,
        ...pointer,
      },
    })
  );
}

/**
 * Append one action to the caretaker's visit record, opening a new visit when
 * there is no action within VISIT_IDLE_MS.
 *
 * Returns the visit id the action landed in. Throws if the write fails —
 * callers decide whether that is fatal (a note IS the record) or reportable
 * (a completed task is already done, so the caller says the visit line could
 * not be written rather than pretending it was).
 */
export async function recordCaretakerAction(
  caretaker: Pick<Caretaker, 'id' | 'householdId' | 'name'>,
  action: CaretakerAction,
  now: Date = new Date()
): Promise<string> {
  const nowIso = now.toISOString();
  const open = await getOpenVisit(caretaker.householdId, caretaker.id);
  const isFresh = open !== null && now.getTime() - Date.parse(open.lastActionAt) <= VISIT_IDLE_MS;

  if (open && isFresh && (await appendToVisit(caretaker, open, action, nowIso))) {
    await putOpenVisit(caretaker.householdId, caretaker.id, { ...open, lastActionAt: nowIso });
    return open.visitId;
  }

  // No usable open visit — this action is an arrival. `startedAt` is its
  // timestamp, which is what makes the report's arrival time observed rather
  // than self-declared.
  const visitId = uuid();
  const visit: CaretakerVisit = {
    id: visitId,
    householdId: caretaker.householdId,
    caretakerId: caretaker.id,
    caretakerName: caretaker.name,
    startedAt: nowIso,
    lastActionAt: nowIso,
    tasksCompleted: action.kind === 'task' ? [action.entry] : [],
    photos: action.kind === 'photo' ? [action.entry] : [],
    notes: action.kind === 'note' ? [action.entry] : [],
    taskCount: action.kind === 'task' ? 1 : 0,
    photoCount: action.kind === 'photo' ? 1 : 0,
    noteCount: action.kind === 'note' ? 1 : 0,
  };
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: visitPk(caretaker.householdId),
        SK: visitSk(nowIso, visitId),
        entityType: 'CaretakerVisit',
        ...visit,
      },
    })
  );
  await putOpenVisit(caretaker.householdId, caretaker.id, {
    visitId,
    startedAt: nowIso,
    lastActionAt: nowIso,
  });
  return visitId;
}

/**
 * Append to an existing visit row. Returns false when the row is gone (the
 * caller then starts a fresh visit) — never when the detail array is simply
 * full, because the COUNT still has to be right even when the detail can no
 * longer be stored.
 */
async function appendToVisit(
  caretaker: Pick<Caretaker, 'id' | 'householdId' | 'name'>,
  open: OpenVisitPointer,
  action: CaretakerAction,
  nowIso: string
): Promise<boolean> {
  const fields = ACTION_FIELDS[action.kind];
  const key = {
    PK: visitPk(caretaker.householdId),
    SK: visitSk(open.startedAt, open.visitId),
  };
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: 'SET #list = list_append(#list, :entry), #last = :now ADD #count :one',
        ExpressionAttributeNames: {
          '#list': fields.list,
          '#count': fields.count,
          '#last': 'lastActionAt',
        },
        ExpressionAttributeValues: {
          ':entry': [action.entry],
          ':now': nowIso,
          ':one': 1,
          ':cap': VISIT_DETAIL_CAP,
        },
        ConditionExpression: 'attribute_exists(PK) AND size(#list) < :cap',
      })
    );
    return true;
  } catch (err) {
    if (!isConditionalCheckFailure(err)) throw err;
  }

  // The condition failed for one of two reasons. Try the count-only update:
  // if it succeeds the row exists and the detail array was simply full, and
  // the count stays exact (the report then says detail is missing). If it
  // fails too, the row is gone and the caller opens a new visit.
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: 'SET #last = :now ADD #count :one',
        ExpressionAttributeNames: { '#count': fields.count, '#last': 'lastActionAt' },
        ExpressionAttributeValues: { ':now': nowIso, ':one': 1 },
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
    return true;
  } catch (err) {
    if (!isConditionalCheckFailure(err)) throw err;
    return false;
  }
}

function isConditionalCheckFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/**
 * Visits whose FIRST action falls in [fromIso, toIso], oldest first.
 *
 * Deliberately not wrapped in a try/catch: a DynamoDB failure propagates so
 * the handler answers an error and the report page says it could not load.
 * Returning `[]` here would render a report claiming nobody visited.
 */
export async function listVisits(
  householdId: string,
  fromIso: string,
  toIso: string
): Promise<CaretakerVisit[]> {
  const params: QueryCommandInput = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': visitPk(householdId),
      ':from': `VISIT#${fromIso}`,
      // '￿' sorts after every character a timestamp or uuid can contain,
      // so the upper bound is inclusive of every visit that STARTED at toIso.
      ':to': `VISIT#${toIso}￿`,
    },
    ScanIndexForward: true,
  };

  const visits: CaretakerVisit[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamodb.send(new QueryCommand({ ...params, ExclusiveStartKey: lastKey }));
    for (const item of page.Items ?? []) {
      if (item.entityType !== 'CaretakerVisit') continue;
      visits.push(itemToVisit(item));
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return visits;
}
