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
 * Row shape: PK = `KIOSK#{token}`, SK = 'METADATA', mirrored onto GSI1 at
 * `HOUSEHOLD#{id}#KIOSK` so a household can find (and revoke) its own link
 * without knowing the secret. Deliberately NO DynamoDB `ttl`: a wall display
 * that stops working after N days is a broken wall display. Longevity is the
 * feature; revocation, not expiry, is the control.
 */
import { PutCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { DynamoDBItem } from '../models/types.js';

export type KioskLinkStatus = 'active' | 'revoked';

/**
 * How often the wall display re-reads the task list, in seconds.
 *
 * COST SCALING — read this before changing the default.
 *
 * Every other paid feature in the ideation brief costs money in proportion to
 * USAGE: a household that never opens the app never spends anything. The
 * kiosk is the one exception. A wall display polls whether or not anybody is
 * in the room, so its cost scales with WALL-CLOCK TIME — a screen left on in
 * an empty kitchen costs exactly as much as one somebody is using.
 *
 * The arithmetic, per household per month, at API Gateway's $1.00 per million
 * requests plus the DynamoDB eventually-consistent reads behind each poll:
 *
 *   every 300s (default) → 30d × 86400 / 300 ≈   8,640 requests → ~$0.01/mo
 *   every  60s (minimum) → 30d × 86400 /  60 ≈  43,200 requests → ~$0.05/mo
 *   every 3600s (max)    → 30d × 86400 / 3600 ≈    720 requests → ~$0.001/mo
 *
 * Five minutes is the default because plant care is not a real-time activity:
 * the worst case is that someone in another room completes a task and the
 * wall screen keeps showing it for up to five more minutes. A 60-second poll
 * multiplies the bill by five to remove four minutes of staleness from a
 * watering schedule measured in days. Faster is offered, but it is opt-in and
 * the settings card states the cost so the choice is made with the number in
 * view.
 */
export const KIOSK_DEFAULT_POLL_SECONDS = 300;

/** Floor on the configurable poll interval (see the cost note above: 60s is
 *  ~5× the default's monthly request cost). */
export const KIOSK_MIN_POLL_SECONDS = 60;

/** Ceiling on the configurable poll interval — one hour. Past this the
 *  display is stale enough to be misleading rather than merely lagging. */
export const KIOSK_MAX_POLL_SECONDS = 3600;

/**
 * How far ahead the kiosk looks, in days. The wall display answers "what
 * needs doing today", so it shows overdue work plus the next 24 hours —
 * not the sitter view's 7-day trip horizon. Named rather than inlined
 * because the sitter/kiosk difference is a product decision, not a constant.
 */
export const KIOSK_LOOKAHEAD_DAYS = 1;

export interface KioskLink {
  /** Opaque id used in the management API. NOT the secret. */
  id: string;
  /** The 256-bit secret token. Returned to the creator exactly once. */
  token: string;
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

function itemToLink(item: Record<string, unknown>): KioskLink {
  return {
    id: item.id as string,
    token: item.token as string,
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

/** Clamp a requested poll interval into the supported band. */
export function clampPollInterval(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return KIOSK_DEFAULT_POLL_SECONDS;
  return Math.min(KIOSK_MAX_POLL_SECONDS, Math.max(KIOSK_MIN_POLL_SECONDS, Math.round(seconds)));
}

/** Every kiosk link row for a household (active + revoked), newest first.
 *  Tokens are included so the service layer can act on them; the HANDLER
 *  strips them via toSummary before responding. */
export async function listKioskLinks(householdId: string): Promise<KioskLink[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `HOUSEHOLD#${householdId}#KIOSK` },
      ScanIndexForward: false,
      Limit: 100,
    })
  );
  return (result.Items ?? []).map(itemToLink);
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
        Key: { PK: `KIOSK#${link.token}`, SK: 'METADATA' },
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
 * Issue a kiosk link, revoking any existing one first.
 *
 * Re-issue is the household's remedy for a leaked token (§ THREAT MODEL), so
 * it has to actually kill the old one — otherwise "print a new code" would
 * leave the photographed one working forever. Revocation happens BEFORE the
 * new row is written: if the write then fails, the household is left with no
 * kiosk access rather than two live tokens. Fail closed.
 */
export async function issueKioskLink(input: {
  householdId: string;
  createdBy: string;
  pollIntervalSeconds?: number;
}): Promise<KioskLink> {
  await revokeKioskLinks(input.householdId);

  // 256-bit CSPRNG token — 64 hex chars, same as the sitter link. randomBytes
  // draws from the OS CSPRNG; do NOT swap this for uuid()/Math.random.
  const token = randomBytes(32).toString('hex');
  const now = new Date().toISOString();

  const link: KioskLink = {
    id: uuid(),
    token,
    householdId: input.householdId,
    createdBy: input.createdBy,
    createdAt: now,
    status: 'active',
    pollIntervalSeconds: clampPollInterval(input.pollIntervalSeconds),
  };

  const item: DynamoDBItem = {
    PK: `KIOSK#${token}`,
    SK: 'METADATA',
    // Mirrored onto GSI1 so the household can find its own link (and account
    // deletion can sweep it) without ever holding the secret.
    GSI1PK: `HOUSEHOLD#${input.householdId}#KIOSK`,
    GSI1SK: now,
    entityType: 'KioskLink',
    ...link,
    // No `ttl` on purpose — see the header note. A wall display must not stop
    // working on a timer; revocation is the control.
  };

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return link;
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

  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `KIOSK#${token}`, SK: 'METADATA' },
    })
  );
  if (!result.Item) return null;

  const link = itemToLink(result.Item);
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
