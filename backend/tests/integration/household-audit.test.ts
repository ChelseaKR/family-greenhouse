/**
 * Real-handler integration tests for the household audit log (#675).
 *
 * Every producer is driven through its REAL handler and the REAL middy chain
 * against the in-memory single table, and the assertions read the rows the
 * handlers actually wrote to `HOUSEHOLD#{id}#AUDIT` — then read them back the
 * way an admin does, through `GET /households/{id}/audit`.
 *
 * The negative control is the point of the file. Each credential-minting
 * handler returns its secret exactly once; the test collects every one of
 * them (and, for the hashed ones, the digest the credential row is keyed by),
 * plus a non-member's email address and a plant's private note, and asserts
 * that
 *
 *   1. the secret really was in hand — present in a handler response or a
 *      credential row, so the check below is not vacuous, and
 *   2. it appears nowhere in any audit row, nor in the audit page an admin
 *      reads.
 *
 * Every address here is `example.invalid`; every string is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDynamo } from './support/inMemoryDynamo.js';
import { invokeHandler } from './support/invokeHandler.js';
import { seedHousehold, setHouseholdPlan } from './support/seed.js';

const store = createInMemoryDynamo();
vi.mock('../../src/utils/dynamodb.js', () => ({
  dynamodb: store.client,
  TABLE_NAME: 'test-table',
}));
vi.mock('../../src/services/cognitoUsers.js', () => ({
  getUserName: async (_id: string, email: string) => email.split('@')[0],
  getUserEmail: async () => null,
  getUsersByIds: async () => new Map(),
  getHouseholdClaims: async () => ({ householdId: null, role: null }),
  setHouseholdClaims: async () => undefined,
  clearHouseholdClaims: async () => undefined,
  deleteUser: async () => undefined,
}));
// Outbound mail is not what these tests are about; every sender is stubbed so
// nothing reaches for SES.
vi.mock('../../src/services/inviteEmail.js', async (orig) => ({
  ...(await orig<typeof import('../../src/services/inviteEmail.js')>()),
  sendInviteEmail: async () => 'accepted',
}));
vi.mock('../../src/services/welcomeEmail.js', async (orig) => ({
  ...(await orig<typeof import('../../src/services/welcomeEmail.js')>()),
  sendWelcomeEmail: async () => undefined,
}));
vi.mock('../../src/services/householdEmails.js', async (orig) => ({
  ...(await orig<typeof import('../../src/services/householdEmails.js')>()),
  notifyMemberJoined: async () => undefined,
  notifyMemberLeft: async () => undefined,
  sendLeaveConfirmation: async () => undefined,
}));
vi.mock('../../src/services/billingEmails.js', async (orig) => ({
  ...(await orig<typeof import('../../src/services/billingEmails.js')>()),
  sendAccountDeletionEmail: async () => true,
}));

const ADMIN = { userId: 'user-admin', email: 'admin@example.invalid', name: 'Ada Admin' };
const MEMBER = { userId: 'user-member', email: 'member@example.invalid', name: 'Mel Member' };
const JOINER = { userId: 'user-joiner', email: 'joiner@example.invalid', name: 'Jo Joiner' };
const INVITEE_EMAIL = 'not-a-member-yet@example.invalid';
const PRIVATE_NOTE = 'PRIVATE-NOTE-the-cat-chews-this-one';
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString();

beforeEach(async () => {
  store.reset();
  vi.clearAllMocks();
  vi.stubEnv('FRONTEND_URL', 'https://app.example.invalid');
  const { __resetMembershipCacheForTests } = await import('../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { __resetRateLimitForTests } = await import('../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
  const { __resetAuditGapsForTests } = await import('../../src/services/householdAudit.js');
  __resetAuditGapsForTests();
});

const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
  vi.unstubAllEnvs();
});

/**
 * Every audit row the handlers wrote, oldest first. Two entries written in the
 * same millisecond sort by their random id, so assertions that care about
 * order between CONSECUTIVE writes compare sets instead.
 */
function auditRows(householdId: string): Array<Record<string, unknown>> {
  return store
    .all()
    .filter((r) => r.PK === `HOUSEHOLD#${householdId}#AUDIT`)
    .sort((a, b) => (String(a.SK) < String(b.SK) ? -1 : 1));
}

function kinds(householdId: string): string[] {
  return auditRows(householdId).map((r) => String(r.kind));
}

async function readLog(householdId: string, identity: { userId: string; email: string }) {
  const households = await import('../../src/handlers/households/handler.js');
  return invokeHandler(households.getHouseholdAuditLog, {
    method: 'GET',
    routeKey: 'GET /households/{id}/audit',
    pathParameters: { id: householdId },
    identity: { ...identity, householdId },
  });
}

describe('household audit log — producers, through the real handlers', () => {
  it('records every credential a member mints, and never the credential', async () => {
    const plantService = await import('../../src/services/plantService.js');
    const households = await import('../../src/handlers/households/handler.js');
    const kioskLink = await import('../../src/handlers/households/kioskLink.js');
    const caretakers = await import('../../src/handlers/caretakers/management.js');
    const tags = await import('../../src/handlers/plantTags/handler.js');
    const plants = await import('../../src/handlers/plants/handler.js');
    const apiKeys = await import('../../src/handlers/apiKeys/handler.js');

    const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });
    await setHouseholdPlan(store, householdId, 'greenhouse');
    const admin = { ...ADMIN, householdId };
    const plant = await plantService.createPlant(
      { name: 'Monstera', notes: PRIVATE_NOTE },
      householdId,
      ADMIN.userId,
      5000
    );

    const invite = await invokeHandler(households.createInvite, {
      method: 'POST',
      routeKey: 'POST /households/{id}/invites',
      pathParameters: { id: householdId },
      identity: admin,
    });
    const emailed = await invokeHandler(households.emailInvite, {
      method: 'POST',
      routeKey: 'POST /households/{id}/invites/email',
      pathParameters: { id: householdId },
      identity: admin,
      body: { email: INVITEE_EMAIL },
    });
    const sitter = await invokeHandler(households.createSitterLink, {
      method: 'POST',
      routeKey: 'POST /households/{id}/sitter-links',
      pathParameters: { id: householdId },
      identity: admin,
      body: { expiresAt: inDays(7), label: 'Trip to Oaxaca' },
    });
    const kiosk = await invokeHandler(kioskLink.issueKioskLink, {
      method: 'POST',
      routeKey: 'POST /households/{id}/kiosk-link',
      pathParameters: { id: householdId },
      identity: admin,
    });
    const seat = await invokeHandler(caretakers.createCaretaker, {
      method: 'POST',
      routeKey: 'POST /households/{id}/caretakers',
      pathParameters: { id: householdId },
      identity: admin,
      body: { name: 'Carmen Caretaker', expiresAt: inDays(10) },
    });
    const tag = await invokeHandler(tags.issuePlantTag, {
      method: 'POST',
      routeKey: 'POST /plants/{plantId}/tag',
      pathParameters: { plantId: plant.id },
      identity: admin,
    });
    const share = await invokeHandler(plants.sharePlant, {
      method: 'POST',
      routeKey: 'POST /plants/{id}/share',
      pathParameters: { id: plant.id },
      identity: admin,
    });
    const key = await invokeHandler(apiKeys.createKey, {
      method: 'POST',
      routeKey: 'POST /api-keys',
      identity: admin,
      body: { label: 'Home Assistant', scopes: ['read:plants', 'write:tasks'] },
    });
    for (const res of [invite, emailed, sitter, kiosk, seat, tag, share, key]) {
      expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
    }

    const sitterBody = sitter.body as { id: string; token: string };
    const kioskBody = kiosk.body as { id: string; token: string };
    const seatBody = seat.body as { id: string; token: string };
    const tagBody = tag.body as { token: string };
    const keyBody = key.body as { record: { id: string; last4: string }; plaintext: string };

    // Revocations, through their own handlers.
    const revokes = await Promise.all([
      invokeHandler(households.revokeSitterLink, {
        method: 'DELETE',
        routeKey: 'DELETE /households/{id}/sitter-links/{linkId}',
        pathParameters: { id: householdId, linkId: sitterBody.id },
        identity: admin,
      }),
      invokeHandler(kioskLink.revokeKioskLink, {
        method: 'DELETE',
        routeKey: 'DELETE /households/{id}/kiosk-link',
        pathParameters: { id: householdId },
        identity: admin,
      }),
      invokeHandler(caretakers.revokeCaretaker, {
        method: 'DELETE',
        routeKey: 'DELETE /households/{id}/caretakers/{caretakerId}',
        pathParameters: { id: householdId, caretakerId: seatBody.id },
        identity: admin,
      }),
      invokeHandler(tags.revokePlantTag, {
        method: 'DELETE',
        routeKey: 'DELETE /plants/{plantId}/tag',
        pathParameters: { plantId: plant.id },
        identity: admin,
      }),
      invokeHandler(apiKeys.revokeKey, {
        method: 'DELETE',
        routeKey: 'DELETE /api-keys/{id}',
        pathParameters: { id: keyBody.record.id },
        identity: admin,
      }),
    ]);
    for (const res of revokes) expect(res.statusCode).toBe(204);

    expect([...kinds(householdId)].sort()).toEqual(
      [
        'invite.created',
        'invite.created',
        'sitter_link.created',
        'kiosk_link.created',
        'caretaker_seat.created',
        'plant_tag.created',
        'share_link.created',
        'api_key.created',
        'sitter_link.revoked',
        'kiosk_link.revoked',
        'caretaker_seat.revoked',
        'plant_tag.revoked',
        'api_key.revoked',
      ].sort()
    );

    const byKind = (k: string) => auditRows(householdId).filter((r) => r.kind === k);
    expect(
      byKind('invite.created')
        .map((r) => (r.details as { channel: string }).channel)
        .sort()
    ).toEqual(['email', 'link']);
    expect(byKind('api_key.created')[0].details).toEqual({
      keyId: keyBody.record.id,
      last4: keyBody.record.last4,
      scopes: 'read:plants,write:tasks',
    });
    expect(byKind('sitter_link.created')[0].details).toMatchObject({ linkId: sitterBody.id });
    expect(byKind('kiosk_link.created')[0].details).toEqual({ linkId: kioskBody.id });
    expect(byKind('caretaker_seat.revoked')[0].details).toEqual({ seatId: seatBody.id });

    // ---- The negative control ------------------------------------------
    const secrets: Record<string, string> = {
      inviteCode: (invite.body as { code: string }).code,
      emailedInviteCode: (emailed.body as { code: string }).code,
      sitterToken: sitterBody.token,
      kioskToken: kioskBody.token,
      caretakerToken: seatBody.token,
      tagToken: tagBody.token,
      shareCode: (share.body as { code: string }).code,
      apiKey: keyBody.plaintext,
      inviteeEmail: INVITEE_EMAIL,
      privateNote: PRIVATE_NOTE,
      sitterLabel: 'Trip to Oaxaca',
      caretakerName: 'Carmen Caretaker',
      apiKeyLabel: 'Home Assistant',
    };
    // The at-rest digests the hashed credentials are keyed by (#811). They
    // are read off the credential rows themselves, so the check below covers
    // whatever hashing the services actually do.
    const digests = store
      .all()
      .flatMap((r) => [r.PK, r.GSI1PK, r.codeHash, r.tokenHash])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.replace(/^(SITTER|KIOSK|PLANTTAG|SHARE|CARETAKER|APIKEY_HASH)#/, ''))
      .filter((v) => /^[0-9a-f]{64}$/.test(v));
    expect(digests.length).toBeGreaterThanOrEqual(5);
    digests.forEach((d, i) => (secrets[`digest${i}`] = d));

    // 1. The sabotage landed: every secret was really in hand.
    const everywhere =
      JSON.stringify([invite, emailed, sitter, kiosk, seat, tag, share, key]) +
      JSON.stringify(store.all().filter((r) => !String(r.PK).endsWith('#AUDIT')));
    for (const [name, value] of Object.entries(secrets)) {
      expect(value.length, name).toBeGreaterThan(3);
      if (name !== 'inviteeEmail') expect(everywhere, name).toContain(value);
    }

    // 2. None of it is in the log — at rest, or as served to the admin.
    const stored = JSON.stringify(auditRows(householdId));
    const page = await readLog(householdId, ADMIN);
    expect(page.statusCode).toBe(200);
    const served = JSON.stringify(page.body);
    for (const [name, value] of Object.entries(secrets)) {
      expect(stored, name).not.toContain(value);
      expect(served, name).not.toContain(value);
    }
    // Nor any member's email address.
    for (const email of [ADMIN.email, MEMBER.email]) {
      expect(stored).not.toContain(email);
      expect(served).not.toContain(email);
    }
  });

  it('records a role change, a removal with its revocation cascade, and names the removed member as a former member', async () => {
    const households = await import('../../src/handlers/households/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });
    await setHouseholdPlan(store, householdId, 'greenhouse');
    const admin = { ...ADMIN, householdId };

    // A credential the member mints, so the removal has something to revoke.
    const sitter = await invokeHandler(households.createSitterLink, {
      method: 'POST',
      routeKey: 'POST /households/{id}/sitter-links',
      pathParameters: { id: householdId },
      identity: { ...MEMBER, householdId },
      body: { expiresAt: inDays(3) },
    });
    expect(sitter.statusCode).toBe(201);

    const promoted = await invokeHandler(households.updateMemberRole, {
      method: 'PUT',
      routeKey: 'PUT /households/{householdId}/members/{userId}/role',
      pathParameters: { householdId, userId: MEMBER.userId },
      identity: admin,
      body: { role: 'admin' },
    });
    expect(promoted.statusCode).toBe(200);
    const demoted = await invokeHandler(households.updateMemberRole, {
      method: 'PUT',
      routeKey: 'PUT /households/{householdId}/members/{userId}/role',
      pathParameters: { householdId, userId: MEMBER.userId },
      identity: admin,
      body: { role: 'member' },
    });
    expect(demoted.statusCode).toBe(200);

    // Read while Mel is still a member: named.
    const before = (await readLog(householdId, ADMIN)).body as {
      items: Array<{ kind: string; actor: unknown; target: unknown; details: unknown }>;
    };
    const roleEntry = before.items.find((i) => i.kind === 'member.role_changed');
    expect(roleEntry).toMatchObject({
      actor: { type: 'member', name: ADMIN.name },
      target: { type: 'member', name: MEMBER.name },
    });

    const removal = await invokeHandler(households.removeMember, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{householdId}/members/{userId}',
      pathParameters: { householdId, userId: MEMBER.userId },
      identity: admin,
    });
    expect(removal.statusCode).toBe(204);

    const removed = auditRows(householdId).filter((r) => r.kind === 'member.removed');
    expect(removed).toHaveLength(1);
    expect(removed[0].details).toMatchObject({ role: 'member', sitterLinks: 1 });

    const after = (await readLog(householdId, ADMIN)).body as {
      items: Array<{ kind: string; actor: unknown; target: unknown; details: unknown }>;
      nextCursor: string | null;
      retentionDays: number;
    };
    expect(after.retentionDays).toBe(30);
    expect(after.nextCursor).toBeNull();
    // Newest first: nothing was written after the removal.
    expect(after.items[0]).toMatchObject({
      kind: 'member.removed',
      actor: { type: 'member', name: ADMIN.name },
      target: { type: 'former_member' },
    });
    const times = after.items.map((i) => (i as unknown as { occurredAt: string }).occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    // And the earlier entries that named Mel now say former member too.
    for (const item of after.items.filter((i) => i.kind === 'member.role_changed')) {
      expect(item.target).toEqual({ type: 'former_member' });
    }
    // Mel's own sitter link: the actor is a former member now.
    expect(after.items.find((i) => i.kind === 'sitter_link.created')?.actor).toEqual({
      type: 'former_member',
    });
    // The log never carried Mel's user id or email to begin with.
    const stored = JSON.stringify(auditRows(householdId));
    expect(stored).not.toContain(MEMBER.userId);
    expect(stored).not.toContain(MEMBER.email);
  });

  it('records a join through an invite, a leave, and a departure by account deletion', async () => {
    const households = await import('../../src/handlers/households/handler.js');
    const me = await import('../../src/handlers/me/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });
    await setHouseholdPlan(store, householdId, 'greenhouse');

    const invite = await invokeHandler(households.createInvite, {
      method: 'POST',
      routeKey: 'POST /households/{id}/invites',
      pathParameters: { id: householdId },
      identity: { ...ADMIN, householdId },
    });
    const code = (invite.body as { code: string }).code;
    const joined = await invokeHandler(households.joinHousehold, {
      method: 'POST',
      routeKey: 'POST /households/join/{inviteCode}',
      pathParameters: { inviteCode: code },
      identity: JOINER,
    });
    expect(joined.statusCode).toBe(200);

    const left = await invokeHandler(households.leaveHousehold, {
      method: 'POST',
      routeKey: 'POST /households/{id}/leave',
      pathParameters: { id: householdId },
      identity: { ...JOINER, householdId },
      body: {},
    });
    expect(left.statusCode).toBe(200);

    const deleted = await invokeHandler(me.deleteMe, {
      method: 'DELETE',
      routeKey: 'DELETE /me',
      identity: { ...MEMBER, householdId },
    });
    expect(deleted.statusCode).toBe(204);

    expect([...kinds(householdId)].sort()).toEqual([
      'invite.created',
      'member.joined',
      'member.left',
      'member.left',
    ]);
    const leaves = auditRows(householdId).filter((r) => r.kind === 'member.left');
    const byDeletion = leaves.find((r) => (r.details as Record<string, unknown>).accountDeleted);
    const byLeaving = leaves.find((r) => r !== byDeletion);
    expect(byDeletion?.details).toEqual({ role: 'member', accountDeleted: true });
    expect(byLeaving?.details).toMatchObject({ role: 'member' });
    expect(byLeaving?.details).not.toHaveProperty('accountDeleted');

    const page = (await readLog(householdId, ADMIN)).body as {
      items: Array<{ kind: string; actor: unknown }>;
    };
    // Everyone but the admin has gone: every other actor is a former member.
    expect(page.items.filter((i) => i.kind !== 'invite.created').map((i) => i.actor)).toEqual([
      { type: 'former_member' },
      { type: 'former_member' },
      { type: 'former_member' },
    ]);
    expect(JSON.stringify(page)).not.toContain(code);
  });

  it('records a trash restore and a delete-now', async () => {
    const plantService = await import('../../src/services/plantService.js');
    const trashService = await import('../../src/services/trashService.js');
    const trash = await import('../../src/handlers/households/trash.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    await setHouseholdPlan(store, householdId, 'greenhouse');
    const keep = await plantService.createPlant({ name: 'Keep' }, householdId, ADMIN.userId, 50);
    const drop = await plantService.createPlant(
      { name: 'Drop', notes: PRIVATE_NOTE },
      householdId,
      ADMIN.userId,
      50
    );
    const actor = { userId: ADMIN.userId, name: ADMIN.name };
    await trashService.trashPlant(householdId, keep.id, actor);
    await trashService.trashPlant(householdId, drop.id, actor);

    const admin = { ...ADMIN, householdId };
    const restored = await invokeHandler(trash.restoreTrashEntry, {
      method: 'POST',
      routeKey: 'POST /households/{id}/trash/{kind}/{itemId}/restore',
      pathParameters: { id: householdId, kind: 'plant', itemId: keep.id },
      identity: admin,
    });
    expect(restored.statusCode).toBe(200);
    const purged = await invokeHandler(trash.purgeTrashEntry, {
      method: 'DELETE',
      routeKey: 'DELETE /households/{id}/trash/{kind}/{itemId}',
      pathParameters: { id: householdId, kind: 'plant', itemId: drop.id },
      identity: admin,
    });
    expect(purged.statusCode).toBe(204);

    expect(auditRows(householdId).map((r) => [r.kind, r.details])).toEqual(
      expect.arrayContaining([
        ['trash.restored', { itemKind: 'plant', itemId: keep.id }],
        ['trash.purged', { itemKind: 'plant', itemId: drop.id }],
      ])
    );
    expect(auditRows(householdId)).toHaveLength(2);
    expect(JSON.stringify(auditRows(householdId))).not.toContain(PRIVATE_NOTE);
  });

  it('records the household itself being created', async () => {
    const households = await import('../../src/handlers/households/handler.js');
    const res = await invokeHandler(households.createHousehold, {
      method: 'POST',
      routeKey: 'POST /households',
      identity: ADMIN,
      body: { name: 'The Fernery' },
    });
    expect(res.statusCode).toBe(201);
    const householdId = (res.body as { id: string }).id;
    expect(kinds(householdId)).toEqual(['household.created']);
  });
});

describe('GET /households/{id}/audit', () => {
  it('is admin-only: a member is refused, and so is an admin of another household', async () => {
    const { householdId } = await seedHousehold(store, { admin: ADMIN, members: [MEMBER] });
    const other = await seedHousehold(store, {
      admin: { userId: 'user-other', email: 'other@example.invalid', name: 'Otto' },
    });

    expect((await readLog(householdId, MEMBER)).statusCode).toBe(403);

    const households = await import('../../src/handlers/households/handler.js');
    const foreign = await invokeHandler(households.getHouseholdAuditLog, {
      method: 'GET',
      routeKey: 'GET /households/{id}/audit',
      pathParameters: { id: householdId },
      identity: {
        userId: 'user-other',
        email: 'other@example.invalid',
        householdId: other.householdId,
      },
    });
    expect(foreign.statusCode).toBe(403);
    expect((await readLog(householdId, ADMIN)).statusCode).toBe(200);
  });

  it('refuses a bad limit and an unreadable cursor with a 400', async () => {
    const households = await import('../../src/handlers/households/handler.js');
    const { householdId } = await seedHousehold(store, { admin: ADMIN });
    for (const queryStringParameters of [
      { limit: '0' },
      { limit: 'lots' },
      { cursor: Buffer.from('PLANT#1').toString('base64url') },
    ]) {
      const res = await invokeHandler(households.getHouseholdAuditLog, {
        method: 'GET',
        routeKey: 'GET /households/{id}/audit',
        pathParameters: { id: householdId },
        queryStringParameters,
        identity: { ...ADMIN, householdId },
      });
      expect(res.statusCode, JSON.stringify(queryStringParameters)).toBe(400);
    }
  });
});
