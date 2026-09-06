/**
 * Kiosk links: a long-lived, household-scoped token that turns a spare tablet
 * on the kitchen wall (or an office breakroom screen) into a read-mostly view
 * of what needs doing today, with tap-to-complete and no login.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN RULE
 * ---------------------------------------------------------------------------
 * A kiosk token is a PERMANENTLY DISPLAYED credential. Everything below
 * follows from that one sentence, and any change to this file has to keep it
 * true:
 *
 *   1. The token grants exactly two operations — read today's tasks, and
 *      complete one of them. Nothing else. No plant records, no notes, no
 *      member identity, no household name, no climate location, no settings,
 *      no writes other than a task completion. If a future field would be
 *      useful on a wall display and is also useful to a stranger, it does not
 *      go here.
 *   2. The token is PII-free. It resolves to a household id, and that is all
 *      that is ever stored on the row alongside it.
 *   3. It is revocable and re-issuable in one click, and issuing a new one
 *      revokes the old one in the same call. There is at most one live kiosk
 *      token per household, so "revoke and re-print" is a single action with
 *      no leftovers.
 *   4. A failed read is never rendered as an empty task list. The public
 *      handler lets a read failure become a 5xx and the kiosk page says
 *      "couldn't load" — because on a wall display an empty list reads as
 *      "everything is done", which is the exact defect this repo names
 *      "absence rendered as a value" (ADR 0010).
 *
 * ---------------------------------------------------------------------------
 * THREAT MODEL
 * ---------------------------------------------------------------------------
 * Same class as the sitter link (`sitterService.ts`), one notch worse. A
 * sitter link is sent to one person and expires within days; a kiosk token
 * sits on a screen in a shared room, potentially for years, and anyone who
 * walks past can photograph the address bar — or the QR/URL printed next to
 * it. Assume the token WILL leak.
 *
 *   - Attacker: anyone who can see the screen. A house guest, a cleaner, an
 *     office visitor, someone in the background of a photo posted online.
 *   - What they get: the household's due/overdue plant-care tasks for the
 *     next day — plant nickname, task type, the space name and placement note
 *     the household already chose to share with sitters — and the ability to
 *     mark one of those tasks done.
 *   - Blast radius, stated honestly: a stranger can see that you own a
 *     monstera that needs watering and can falsely mark it watered, which
 *     delays the next reminder by one care interval. That is a nuisance and,
 *     for a plant, a real (small) risk — a plant whose watering is marked done
 *     when it wasn't goes thirsty for a cycle. It is NOT account access: no
 *     personal data is exposed, no plant can be deleted, no member can be
 *     added, nothing can be bought, and nothing reaches another household.
 *   - What it is not: an authentication boundary for anything else. The token
 *     cannot be exchanged for a session and shares no secret with one.
 *   - Mitigations: 256 bits of CSPRNG entropy so the token is not guessable;
 *     the token HASHED at rest (#450), so a table export, a point-in-time
 *     restore or `dynamodb:Scan` yields a scrypt digest rather than a working
 *     wall-display URL — this one matters more than for the sitter link,
 *     because a kiosk row deliberately has no TTL and so would otherwise sit
 *     in every backup, in plaintext, for as long as the display lives;
 *     a hard IP rate limit so it cannot be enumerated or scraped in volume;
 *     one-click revoke + re-issue in settings; a generic 404 on every failure
 *     mode so the endpoint is not a token-existence oracle; the completion is
 *     attributed to "the kiosk" in the activity feed, so a household can SEE
 *     that a completion came from the wall screen and revoke if it looks
 *     wrong; and an on-screen notice telling passers-by what they are looking
 *     at, because a surveillance-shaped surface should announce itself.
 *   - Accepted residual risk: a leaked token stays valid until someone
 *     revokes it. That is the price of "no login on the wall display", it is
 *     stated on the settings card, and it is why the scope above is so
 *     narrow.
 *
 * Row shape: PK = `KIOSK#{scrypt(token)}`, SK = 'METADATA', mirrored onto GSI1
 * at `HOUSEHOLD#{id}#KIOSK` so a household can find (and revoke) its own link
 * without knowing the secret. Hashing the token keeps the point-read property
 * the plaintext key was chosen for — the digest is still the partition key, so
 * a kiosk poll is still one GetItem with no enumeration surface.
 * Deliberately NO DynamoDB `ttl`: a wall display that stops working after N
 * days is a broken wall display. Longevity is the feature; revocation, not
 * expiry, is the control.
 *
 * Rows written before #450 are keyed by the PLAINTEXT token and carry it as a
 * `token` attribute; `getActiveKioskLink` still resolves them, so no wall
 * display goes dark on deploy. Because kiosk rows never expire, a legacy row
 * keeps its plaintext until the household re-issues — one click, and re-issue
 * already revokes the old link in the same call.
 */
import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes, scryptSync } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { DynamoDBItem } from '../models/types.js';
import { clampPollInterval } from '../models/kiosk.js';

// Constants live in models/kiosk.ts so the dev server can read them without
// importing this module (which pulls in the DynamoDB client). Re-exported here
// so callers of the service keep one import.
export {
  KIOSK_DEFAULT_POLL_SECONDS,
  KIOSK_MIN_POLL_SECONDS,
  KIOSK_MAX_POLL_SECONDS,
  KIOSK_LOOKAHEAD_DAYS,
  clampPollInterval,
} from '../models/kiosk.js';

export type KioskLinkStatus = 'active' | 'revoked';

export interface KioskLink {
  /** Opaque id used in the management API. NOT the secret. */
  id: string;
  /**
   * The 256-bit secret token, present ONLY on the object `issueKioskLink`
   * returns — the one moment it exists in this system. It is not stored, so a
   * link read back out of DynamoDB carries `null` here unless it is a pre-#450
   * row that still holds its plaintext.
   */
  token: string | null;
  /**
   * The row's own partition-key suffix: the token's scrypt digest on rows
   * written since #450, the plaintext token on rows written before it. It
   * exists so revocation can address the base row of either generation without
   * an admin ever holding a token. NEVER put it in a response — for a legacy
   * row it IS the secret; `toSummary` is what callers get.
   */
  keyToken: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  status: KioskLinkStatus;
  /** Seconds between polls, chosen at issue time (see the constants above). */
  pollIntervalSeconds: number;
}

/** A kiosk link as exposed to the household — never the token after issue. */
export interface KioskLinkSummary {
  id: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  status: KioskLinkStatus;
  pollIntervalSeconds: number;
}

/**
 * Deterministic, memory-hard hash of a kiosk token — the row's partition key.
 * Same construction and reasoning as `apiKeys.hashKey`, `calendarTokens.
 * hashToken` and `sitterService.hashToken`: a per-row random salt would make
 * the point read impossible; a fixed salt costs nothing because the input is a
 * 256-bit CSPRNG value, not a password; scrypt rather than SHA-256 because an
 * unsalted digest fails the repo's `js/insufficient-password-hash` policy.
 *
 * The salt is DIFFERENT from every other credential's, so a kiosk token can
 * never resolve as a sitter link (or vice versa) if one is pasted at the
 * other's URL.
 */
function hashToken(token: string): string {
  return scryptSync(token, 'family-greenhouse-kiosk-v1', 32).toString('hex');
}

function itemToLink(item: Record<string, unknown>): KioskLink {
  // `tokenHash` on rows written since #450; the plaintext `token` on rows
  // written before it. Either way this is exactly the row's PK suffix.
  const keyToken = (item.tokenHash as string | undefined) ?? (item.token as string);
  return {
    id: item.id as string,
    token: (item.token as string | undefined) ?? null,
    keyToken,
    householdId: item.householdId as string,
    createdBy: item.createdBy as string,
    createdAt: item.createdAt as string,
    status: item.status as KioskLinkStatus,
    pollIntervalSeconds: item.pollIntervalSeconds as number,
  };
}

/** Strip the secret token before handing a link back to the household. */
export function toSummary(link: KioskLink): KioskLinkSummary {
  return {
    id: link.id,
    householdId: link.householdId,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
    status: link.status,
    pollIntervalSeconds: link.pollIntervalSeconds,
  };
}

/**
 * Page size for the kiosk-link listing. A transport detail, NOT a cap:
 * `listKioskLinks` follows `LastEvaluatedKey` to exhaustion.
 *
 * `revokeKioskLinks` ("revoke everything live") and `revokeKioskLinksCreatedBy`
 * both read through this function, so a bare `Limit: 100` on a
 * `ScanIndexForward: false` query made revoke-all quietly not revoke all, and
 * returned a count that understated it. Both docstrings already promise a
 * failed read propagates rather than being reported as "there was nothing to
 * revoke"; a truncated read had been slipping past that promise, because it is
 * not a failure at all.
 */
const KIOSK_PAGE_SIZE = 100;

/** Every kiosk link row for a household (active + revoked), newest first.
 *  Rows carry `keyToken` (the row's own PK suffix) so the service layer can
 *  revoke them; since #450 they carry no plaintext token at all, and the
 *  HANDLER strips both via toSummary. */
export async function listKioskLinks(householdId: string): Promise<KioskLink[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#KIOSK` },
        ScanIndexForward: false,
        Limit: KIOSK_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items.map(itemToLink);
}

/**
 * Revoke every currently-active kiosk link for a household. Returns how many
 * rows were flipped, so "revoke" can answer 404 when there was nothing live.
 * Idempotent: revoking an already-revoked household is a no-op returning 0.
 *
 * A read failure here PROPAGATES rather than being swallowed into 0 — "we
 * could not look" must never be reported to the caller as "there was nothing
 * to revoke" (ADR 0010).
 */
export async function revokeKioskLinks(householdId: string): Promise<number> {
  const links = await listKioskLinks(householdId);
  const active = links.filter((l) => l.status === 'active');
  for (const link of active) {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `KIOSK#${link.keyToken}`, SK: 'METADATA' },
        UpdateExpression: 'SET #status = :revoked',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':revoked': 'revoked' },
        // Guard against a row deleted between the list read and this write.
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
  }
  return active.length;
}

/**
 * Revoke every currently-ACTIVE kiosk link a given member issued. Called when
 * that member is removed from the household.
 *
 * A kiosk link never expires and shows the whole household's task list, so a
 * departing member who kept the URL keeps a live window into the house from
 * anywhere. The cost of revoking is that the household's wall display stops
 * until an admin re-issues — a visible, one-call remedy, and the removal that
 * triggers it is a deliberate admin action, so the trade goes this way.
 *
 * Same fail-loud contract as revokeKioskLinks: an unreadable list propagates
 * rather than being reported as "there was nothing to revoke".
 */
export async function revokeKioskLinksCreatedBy(
  householdId: string,
  userId: string
): Promise<number> {
  const links = (await listKioskLinks(householdId)).filter(
    (link) => link.createdBy === userId && link.status === 'active'
  );
  for (const link of links) {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `KIOSK#${link.keyToken}`, SK: 'METADATA' },
        UpdateExpression: 'SET #status = :revoked',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':revoked': 'revoked' },
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
  }
  return links.length;
}

/**
 * Issue a kiosk link, revoking any existing one first.
 *
 * Re-issue is the household's remedy for a leaked token (§ THREAT MODEL), so
 * it has to actually kill the old one — otherwise "print a new code" would
 * leave the photographed one working forever. Revocation happens BEFORE the
 * new row is written: if the write then fails, the household is left with no
 * kiosk access rather than two live tokens. Fail closed.
 */
/** A link as it comes back from `issueKioskLink` — the one place the plaintext
 *  token exists, and the only place it is non-null. */
export type MintedKioskLink = KioskLink & { token: string };

export async function issueKioskLink(input: {
  householdId: string;
  createdBy: string;
  pollIntervalSeconds?: number;
}): Promise<MintedKioskLink> {
  await revokeKioskLinks(input.householdId);

  // 256-bit CSPRNG token — 64 hex chars, same as the sitter link. randomBytes
  // draws from the OS CSPRNG; do NOT swap this for uuid()/Math.random.
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const id = uuid();
  const now = new Date().toISOString();
  const pollIntervalSeconds = clampPollInterval(input.pollIntervalSeconds);

  // Written field by field rather than spread from the record: the record
  // carries the plaintext and the row must NOT (#450).
  const item: DynamoDBItem = {
    PK: `KIOSK#${tokenHash}`,
    SK: 'METADATA',
    // Mirrored onto GSI1 so the household can find its own link (and account
    // deletion can sweep it) without ever holding the secret.
    GSI1PK: `HOUSEHOLD#${input.householdId}#KIOSK`,
    GSI1SK: now,
    entityType: 'KioskLink',
    // Both the PK suffix and the attribute revocation reads through. The
    // plaintext appears nowhere on the row.
    tokenHash,
    id,
    householdId: input.householdId,
    createdBy: input.createdBy,
    createdAt: now,
    status: 'active',
    pollIntervalSeconds,
    // No `ttl` on purpose — see the header note. A wall display must not stop
    // working on a timer; revocation is the control.
  };

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return {
    id,
    token,
    keyToken: tokenHash,
    householdId: input.householdId,
    createdBy: input.createdBy,
    createdAt: now,
    status: 'active',
    pollIntervalSeconds,
  };
}

async function readLinkRow(pk: string): Promise<Record<string, unknown> | null> {
  const result = await dynamodb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: 'METADATA' } })
  );
  return (result?.Item as Record<string, unknown> | undefined) ?? null;
}

/**
 * Resolve a token to its link ONLY if it is currently usable: it exists and
 * has not been revoked. Any other state returns null so the caller answers a
 * single generic 404 and the endpoint can't be used to probe which tokens
 * exist.
 */
export async function getActiveKioskLink(token: string): Promise<KioskLink | null> {
  // Defensive length/charset gate: a token that can't be one of ours never
  // hits DynamoDB. 64 lowercase hex chars only.
  if (!/^[0-9a-f]{64}$/.test(token)) return null;

  // Hashed row first — every link issued since #450. A miss falls back to the
  // pre-#450 plaintext-keyed row, so a wall display that has been up for a
  // year does not go dark on deploy. Both are GetItem on the partition key:
  // the fallback costs one extra point read and adds no enumeration surface.
  const item =
    (await readLinkRow(`KIOSK#${hashToken(token)}`)) ?? (await readLinkRow(`KIOSK#${token}`));
  if (!item) return null;

  const link = itemToLink(item);
  if (link.status !== 'active') return null;
  return link;
}

/**
 * The household's current live kiosk link, or null when it has none.
 *
 * `null` here means "we looked and there is none" — a read failure throws and
 * the settings card renders an error instead of the no-kiosk state, because
 * "you have no wall display" and "we could not check" are different answers
 * and only one of them means nobody is watching your task list.
 */
export async function getCurrentKioskLink(householdId: string): Promise<KioskLinkSummary | null> {
  const links = await listKioskLinks(householdId);
  const active = links.find((l) => l.status === 'active');
  return active ? toSummary(active) : null;
}
