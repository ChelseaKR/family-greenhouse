/**
 * Reply-to-act end to end through `handleInboundReply` (#667, ADR 0031).
 *
 * Real: the token store (`emailReplyTokens`, over an in-memory table that
 * honours the conditional expressions it uses), the parser, the copy, and the
 * whole outbound sender path (`emailNotifier` -> `mime.buildRawMessage`), so
 * the header-injection assertions read the actual bytes handed to SES.
 *
 * Faked: `taskService`, as a stateful store with the SAME occurrence guard the
 * real one has (an action applies only while `nextDue === expectedNextDue`, and
 * every action moves `nextDue`). That guard is what makes a token single-use
 * per task, so the fake keeps it rather than returning canned answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- in-memory table ---------------------------------------------------------

type Row = Record<string, unknown>;
const table = new Map<string, Row>();
const rowKey = (key: { PK: unknown; SK: unknown }) => `${String(key.PK)}|${String(key.SK)}`;
let failGets = false;

function conditionFailed(): never {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  throw err;
}

async function fakeSend(command: { constructor: { name: string }; input: Row }): Promise<Row> {
  const input = command.input as {
    Key?: { PK: string; SK: string };
    Item?: Row;
    ConditionExpression?: string;
    UpdateExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  };
  const values = input.ExpressionAttributeValues ?? {};
  switch (command.constructor.name) {
    case 'GetCommand': {
      if (failGets) throw new Error('ProvisionedThroughputExceededException');
      const row = table.get(rowKey(input.Key!));
      return { Item: row ? structuredClone(row) : undefined };
    }
    case 'PutCommand': {
      const item = input.Item!;
      const existing = table.get(rowKey(item as { PK: string; SK: string }));
      const condition = input.ConditionExpression ?? '';
      if (condition === 'attribute_not_exists(PK)' && existing) conditionFailed();
      if (condition.startsWith('attribute_not_exists(PK) OR (#status = :processing') && existing) {
        const reclaimable =
          existing.status === 'processing' &&
          Number(existing.leaseExpiresAt) <= Number(values[':now']);
        if (!reclaimable) conditionFailed();
      }
      table.set(rowKey(item as { PK: string; SK: string }), structuredClone(item));
      return {};
    }
    case 'UpdateCommand': {
      const existing = table.get(rowKey(input.Key!));
      const update = input.UpdateExpression ?? '';
      const once = input.ExpressionAttributeNames?.['#once'];
      if (update.includes('repliesSent + :one')) {
        if (!existing || Number(existing.repliesSent) >= Number(values[':max'])) conditionFailed();
        if (once && existing[once] !== undefined) conditionFailed();
        existing.repliesSent = Number(existing.repliesSent) + 1;
        if (once) existing[once] = values[':now'];
        return {};
      }
      if (update.includes('repliesSent - :one')) {
        if (!existing || Number(existing.repliesSent) <= 0) conditionFailed();
        existing.repliesSent = Number(existing.repliesSent) - 1;
        if (once) delete existing[once];
        return {};
      }
      if (update.includes('#status = :done')) {
        if (
          !existing ||
          existing.status !== 'processing' ||
          existing.reservationId !== values[':reservationId']
        ) {
          conditionFailed();
        }
        existing.status = 'done';
        existing.disposition = values[':disposition'];
        delete existing.leaseExpiresAt;
        delete existing.reservationId;
        return {};
      }
      throw new Error(`fake table: unhandled update ${update}`);
    }
    case 'DeleteCommand': {
      const key = rowKey(input.Key!);
      const existing = table.get(key);
      if (!existing || existing.reservationId !== values[':reservationId']) conditionFailed();
      table.delete(key);
      return {};
    }
    default:
      throw new Error(`fake table: unhandled ${command.constructor.name}`);
  }
}

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn((command) => fakeSend(command)) },
  TABLE_NAME: 'test-table',
}));

// --- outbound mail: the real sender path, SES itself faked ---------------------

const sesSend = vi.fn(async () => ({ MessageId: 'out' }));
vi.mock('@aws-sdk/client-ses', () => ({
  SESClient: vi.fn(function () {
    return { send: sesSend };
  }),
  SendRawEmailCommand: vi.fn(function (input) {
    return { input };
  }),
}));
vi.mock('../../../src/services/emailSuppression.js', () => ({
  checkAddress: vi.fn(async () => ({ status: 'sendable' })),
}));

// --- households, tasks, side effects -------------------------------------------

vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(),
}));

interface FakeTask {
  id: string;
  householdId: string;
  plantId: string;
  plantName: string;
  type: 'water' | 'fertilize';
  customType: string | null;
  nextDue: string;
  assignedTo: string | null;
}
const tasks = new Map<string, FakeTask>();
const DAY = 24 * 60 * 60 * 1000;

vi.mock('../../../src/services/taskService.js', () => ({
  completeTaskWithOutcome: vi.fn(
    async (
      householdId: string,
      taskId: string,
      _u: string,
      _n: string,
      _x: unknown,
      expected?: string
    ) => {
      const task = tasks.get(`${householdId}|${taskId}`);
      if (!task) return null;
      if (expected !== undefined && task.nextDue !== expected)
        return { task: { ...task }, changed: false };
      task.nextDue = new Date(Date.parse(task.nextDue) + 7 * DAY).toISOString();
      return { task: { ...task }, changed: true };
    }
  ),
  snoozeTaskWithOutcome: vi.fn(
    async (householdId: string, taskId: string, days: number, expected?: string) => {
      const task = tasks.get(`${householdId}|${taskId}`);
      if (!task) return null;
      if (expected !== undefined && task.nextDue !== expected)
        return { task: { ...task }, changed: false };
      task.nextDue = new Date(Date.parse(task.nextDue) + days * DAY).toISOString();
      return { task: { ...task }, changed: true };
    }
  ),
}));
vi.mock('../../../src/services/householdEmails.js', () => ({
  notifyCoveredCompletion: vi.fn(async () => 'ineligible'),
}));
vi.mock('../../../src/services/activity.js', () => ({ recordActivity: vi.fn(async () => {}) }));

import * as householdService from '../../../src/services/householdService.js';
import * as taskService from '../../../src/services/taskService.js';
import * as householdEmails from '../../../src/services/householdEmails.js';
import { recordActivity } from '../../../src/services/activity.js';
import { handleInboundReply, type InboundReply } from '../../../src/services/emailReplies.js';
import {
  MAX_REPLIES_PER_TOKEN,
  REPLY_TOKEN_TTL_SECONDS,
  digestOf,
  mintReplyToken,
} from '../../../src/services/emailReplyTokens.js';
import { newReplyToken } from '../../../src/services/email/replyAddress.js';

const DOMAIN = 'familygreenhouse.net';
const NOW = new Date('2026-09-17T15:00:00.000Z');
const DUE_1 = '2026-09-16T15:00:00.000Z';
const DUE_2 = '2026-09-17T09:00:00.000Z';

const ada = {
  householdId: 'hh',
  userId: 'u-ada',
  name: 'Ada',
  email: 'Ada@Example.com',
  role: 'admin' as const,
  joinedAt: '',
};
const bo = { ...ada, userId: 'u-bo', name: 'Bo', email: 'bo@example.com', role: 'member' as const };

const ORIGINAL_ENV = process.env;
let seq = 0;

function seedTasks() {
  tasks.clear();
  tasks.set('hh|t1', {
    id: 't1',
    householdId: 'hh',
    plantId: 'p1',
    plantName: 'Monstera',
    type: 'water',
    customType: null,
    nextDue: DUE_1,
    assignedTo: 'u-ada',
  });
  tasks.set('hh|t2', {
    id: 't2',
    householdId: 'hh',
    plantId: 'p2',
    plantName: 'Fern',
    type: 'fertilize',
    customType: null,
    nextDue: DUE_2,
    assignedTo: null,
  });
}

async function mint(
  taskIds: string[] = ['t1'],
  over: Partial<Parameters<typeof mintReplyToken>[0]> = {}
): Promise<string> {
  const minted = await mintReplyToken(
    {
      userId: ada.userId,
      householdId: 'hh',
      locale: 'en',
      timeZone: 'UTC',
      tasks: taskIds.map((taskId) => ({
        taskId,
        expectedNextDue: tasks.get(`hh|${taskId}`)!.nextDue,
      })),
      ...over,
    },
    NOW
  );
  if (minted.status !== 'ok') throw new Error('mint failed in test setup');
  return minted.token;
}

function rawReply(firstLine: string): Buffer {
  return Buffer.from(
    [
      'Content-Type: text/plain; charset=utf-8',
      '',
      firstLine,
      '',
      'On Wed, Sep 17, 2026 at 8:00 AM Family Greenhouse wrote:',
      '> 1. Monstera — water, 1 day overdue',
      '> Reply "done 1" ...',
    ].join('\r\n'),
    'utf8'
  );
}

function inbound(token: string, firstLine: string, over: Partial<InboundReply> = {}): InboundReply {
  seq += 1;
  return {
    sesMessageId: `ses-${seq}`,
    recipients: [`care+${token}@${DOMAIN}`],
    from: ['Ada Lovelace <ada@example.com>'],
    messageId: `<reply-${seq}@mail.example.com>`,
    verdicts: { spam: 'PASS', virus: 'PASS', dmarc: 'PASS' },
    loadBody: vi.fn(async () => rawReply(firstLine)),
    ...over,
  };
}

/** Every raw message handed to SES, decoded. */
function sent(): Array<{ raw: string; headers: string; body: string; destinations: string[] }> {
  return sesSend.mock.calls.map((call) => {
    const input = (
      call as unknown as [{ input: { RawMessage: { Data: Buffer }; Destinations: string[] } }]
    )[0].input;
    const raw = input.RawMessage.Data.toString('utf8');
    const [headers, ...rest] = raw.split('\r\n\r\n');
    const body = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8');
    return { raw, headers, body, destinations: input.Destinations };
  });
}

function tokenRow(token: string): Row | undefined {
  return table.get(`EMAILREPLY#${digestOf(token)}|TOKEN`);
}

beforeEach(() => {
  vi.clearAllMocks();
  table.clear();
  failGets = false;
  seedTasks();
  process.env = {
    ...ORIGINAL_ENV,
    EMAIL_REPLY_DOMAIN: DOMAIN,
    SES_FROM_EMAIL: 'Family Greenhouse <hello@familygreenhouse.net>',
    SES_REPLY_TO: 'support@familygreenhouse.net',
    FRONTEND_URL: 'https://familygreenhouse.net',
  };
  vi.mocked(householdService.getMemberByUserId).mockImplementation(async (_hh, userId) =>
    userId === ada.userId ? ada : userId === bo.userId ? bo : null
  );
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('done when (issue #667)', () => {
  it('"done 1" with a valid token completes task 1 for the right user and sends one confirmation', async () => {
    const token = await mint(['t1']);
    const result = await handleInboundReply(inbound(token, 'done 1'), NOW);

    expect(result.disposition).toBe('applied');
    expect(taskService.completeTaskWithOutcome).toHaveBeenCalledTimes(1);
    expect(taskService.completeTaskWithOutcome).toHaveBeenCalledWith(
      'hh',
      't1',
      ada.userId,
      'Ada',
      undefined,
      DUE_1
    );
    expect(tasks.get('hh|t1')!.nextDue).not.toBe(DUE_1);

    const mail = sent();
    expect(mail).toHaveLength(1);
    // To the STORED address, never to the From header.
    expect(mail[0].destinations).toEqual([ada.email]);
    expect(mail[0].headers).toContain(`To: ${ada.email}`);
    expect(mail[0].headers).toContain('Subject: Updated from your reply');
    expect(mail[0].headers).toContain(`Reply-To: care+${token}@${DOMAIN}`);
    expect(mail[0].body).toContain('1. Monstera — water: marked done.');
    expect(householdEmails.notifyCoveredCompletion).toHaveBeenCalledTimes(1);
  });

  it('the same message replayed applies nothing and sends nothing', async () => {
    const token = await mint(['t1']);
    const message = inbound(token, 'done 1');
    await handleInboundReply(message, NOW);
    const afterFirst = tasks.get('hh|t1')!.nextDue;

    const replay = await handleInboundReply(message, NOW);
    expect(replay.disposition).toBe('duplicate');
    expect(taskService.completeTaskWithOutcome).toHaveBeenCalledTimes(1);
    expect(tasks.get('hh|t1')!.nextDue).toBe(afterFirst);
    expect(sent()).toHaveLength(1);
  });

  it('the same content re-sent as a NEW message still applies nothing (single use per task)', async () => {
    const token = await mint(['t1']);
    await handleInboundReply(inbound(token, 'done 1'), NOW);
    const afterFirst = tasks.get('hh|t1')!.nextDue;

    const again = await handleInboundReply(inbound(token, 'done 1'), NOW);
    expect(again.disposition).toBe('applied');
    expect(again.outcomes).toEqual([expect.objectContaining({ kind: 'settled', number: 1 })]);
    expect(tasks.get('hh|t1')!.nextDue).toBe(afterFirst);
    // A snooze through the same token after the done cannot act either.
    const snooze = await handleInboundReply(inbound(token, 'snooze 3 days'), NOW);
    expect(snooze.outcomes).toEqual([expect.objectContaining({ kind: 'settled' })]);
    expect(tasks.get('hh|t1')!.nextDue).toBe(afterFirst);
    expect(recordActivity).not.toHaveBeenCalled();
    expect(sent()[1].headers).toContain('Subject: No changes from your reply');
  });

  it('an expired token yields one "no longer works" reply and no state change', async () => {
    const token = await mint(['t1']);
    const later = new Date(NOW.getTime() + REPLY_TOKEN_TTL_SECONDS * 1000 + 1000);
    const message = inbound(token, 'done 1');

    const result = await handleInboundReply(message, later);
    expect(result).toEqual({ disposition: 'expired', replied: true });
    expect(sent()[0].headers).toContain('Subject: This reply address has expired');
    expect(message.loadBody).not.toHaveBeenCalled();
    expect(taskService.completeTaskWithOutcome).not.toHaveBeenCalled();
    expect(tasks.get('hh|t1')!.nextDue).toBe(DUE_1);

    // At most once per token.
    const second = await handleInboundReply(inbound(token, 'done 1'), later);
    expect(second).toEqual({ disposition: 'expired', replied: false });
    expect(sent()).toHaveLength(1);
  });

  it('a foreign token (never issued) gets no reply and changes nothing', async () => {
    await mint(['t1']);
    const message = inbound(newReplyToken(), 'done 1');
    const result = await handleInboundReply(message, NOW);
    expect(result).toEqual({ disposition: 'dropped_unknown_token', replied: false });
    expect(message.loadBody).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
    expect(taskService.completeTaskWithOutcome).not.toHaveBeenCalled();
  });

  it("a token from user A cannot act for user B: B's reply with A's token is silently dropped", async () => {
    const token = await mint(['t1', 't2']);
    const result = await handleInboundReply(
      inbound(token, 'done 2', { from: ['Bo <bo@example.com>'] }),
      NOW
    );
    expect(result).toEqual({ disposition: 'dropped_sender_mismatch', replied: false });
    expect(sent()).toHaveLength(0);
    expect(taskService.completeTaskWithOutcome).not.toHaveBeenCalled();
    expect(tasks.get('hh|t2')!.nextDue).toBe(DUE_2);
  });

  it('a token can only reach the tasks its email listed — never another task, by number or by id', async () => {
    const token = await mint(['t1']); // t2 exists in the household but was not listed
    const byNumber = await handleInboundReply(inbound(token, 'done 2'), NOW);
    expect(byNumber.disposition).toBe('help');
    const byId = await handleInboundReply(inbound(token, 'done t2'), NOW);
    expect(byId.disposition).toBe('help');
    expect(taskService.completeTaskWithOutcome).not.toHaveBeenCalled();
    expect(tasks.get('hh|t2')!.nextDue).toBe(DUE_2);
  });

  it('"snooze 3d" on an already-completed task replies with the settled state, not success', async () => {
    const token = await mint(['t1']);
    // Somebody completes it in the app after the reminder went out.
    tasks.get('hh|t1')!.nextDue = '2026-09-24T15:00:00.000Z';

    const result = await handleInboundReply(inbound(token, 'snooze 3d'), NOW);
    expect(result.disposition).toBe('applied');
    expect(result.outcomes).toEqual([
      expect.objectContaining({ kind: 'settled', nextDue: '2026-09-24T15:00:00.000Z' }),
    ]);
    expect(tasks.get('hh|t1')!.nextDue).toBe('2026-09-24T15:00:00.000Z');
    const [mail] = sent();
    expect(mail.headers).toContain('Subject: No changes from your reply');
    expect(mail.body).toContain('already taken care of');
    expect(mail.body).not.toContain('snoozed');
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

describe('header injection on the reply sender path (the #617 class)', () => {
  it('a From carrying a bare LF and a Bcc is refused outright — nothing is sent anywhere', async () => {
    const token = await mint(['t1']);
    const from = '"Ada\nBcc: victim@evil.test" <ada@example.com>';
    // Negative control: the sabotage is really in the input.
    expect(from).toMatch(/\nBcc: /);
    const result = await handleInboundReply(inbound(token, 'done 1', { from: [from] }), NOW);
    expect(result.disposition).toBe('dropped_sender_mismatch');
    expect(sent()).toHaveLength(0);
  });

  it('an injected Message-ID never reaches a header; a clean one does', async () => {
    const token = await mint(['t1', 't2']);
    const injected = '<x@evil.test>\r\nBcc: victim@evil.test';
    expect(injected).toContain('\r\nBcc:');
    await handleInboundReply(inbound(token, 'done 1', { messageId: injected }), NOW);
    // Control: a clean Message-ID DOES produce threading headers, so the
    // absence above is the check working, not a header that is never written.
    await handleInboundReply(inbound(token, 'done 2', { messageId: '<ok@mail.example.com>' }), NOW);

    const [dirty, clean] = sent();
    expect(dirty.raw).not.toMatch(/\r\nBcc:/i);
    expect(dirty.raw).not.toContain('victim@evil.test');
    expect(dirty.headers).not.toContain('In-Reply-To');
    expect(clean.headers).toContain('In-Reply-To: <ok@mail.example.com>');
    expect(clean.headers).toContain('References: <ok@mail.example.com>');
  });

  it('echoes nothing from the inbound body into the reply', async () => {
    const token = await mint(['t1']);
    await handleInboundReply(inbound(token, 'done 1 <script>Bcc: victim@evil.test</script>'), NOW);
    const [mail] = sent();
    expect(mail.raw).not.toContain('victim@evil.test');
    expect(mail.body).not.toContain('<script>');
  });
});

describe('everything else gets no action', () => {
  it('an unrecognized reply gets one helpful reply, then silence', async () => {
    const token = await mint(['t1']);
    const first = await handleInboundReply(inbound(token, 'thanks, will do tomorrow'), NOW);
    expect(first).toEqual({ disposition: 'help', replied: true });
    expect(sent()[0].headers).toContain("Subject: We couldn't read your reply");
    expect(sent()[0].body).toContain('support@familygreenhouse.net');

    const second = await handleInboundReply(inbound(token, 'what?'), NOW);
    expect(second).toEqual({ disposition: 'help', replied: false });
    expect(sent()).toHaveLength(1);
    expect(taskService.completeTaskWithOutcome).not.toHaveBeenCalled();
    expect(taskService.snoozeTaskWithOutcome).not.toHaveBeenCalled();
  });

  it('a bare "done" on a reminder that listed several tasks asks which, and changes nothing', async () => {
    const token = await mint(['t1', 't2']);
    const result = await handleInboundReply(inbound(token, 'done'), NOW);
    expect(result.disposition).toBe('help');
    expect(sent()[0].body).toContain('listed 2 tasks');
    expect(taskService.completeTaskWithOutcome).not.toHaveBeenCalled();
  });

  it('one number out of range rejects the whole command rather than applying part of it', async () => {
    const token = await mint(['t1', 't2']);
    const result = await handleInboundReply(inbound(token, 'done 1, 9'), NOW);
    expect(result.disposition).toBe('help');
    expect(taskService.completeTaskWithOutcome).not.toHaveBeenCalled();
  });

  it('a DMARC result other than PASS changes nothing and sends one notice to the stored address', async () => {
    const token = await mint(['t1']);
    const message = inbound(token, 'done 1', {
      verdicts: { spam: 'PASS', virus: 'PASS', dmarc: 'GRAY' },
    });
    const result = await handleInboundReply(message, NOW);
    expect(result).toEqual({ disposition: 'dropped_unauthenticated', replied: true });
    expect(message.loadBody).not.toHaveBeenCalled();
    expect(sent()[0].destinations).toEqual([ada.email]);
    expect(taskService.completeTaskWithOutcome).not.toHaveBeenCalled();

    const again = await handleInboundReply(
      inbound(token, 'done 1', { verdicts: { spam: 'PASS', virus: 'PASS', dmarc: 'FAIL' } }),
      NOW
    );
    expect(again.replied).toBe(false);
    expect(sent()).toHaveLength(1);
  });

  it.each([
    ['spam FAIL', { spam: 'FAIL', virus: 'PASS', dmarc: 'PASS' }],
    ['virus GRAY', { spam: 'PASS', virus: 'GRAY', dmarc: 'PASS' }],
    ['no scan at all', { dmarc: 'PASS' }],
  ])('a message whose scan is not a clean PASS is dropped (%s)', async (_label, verdicts) => {
    const token = await mint(['t1']);
    const result = await handleInboundReply(inbound(token, 'done 1', { verdicts }), NOW);
    expect(result.disposition).toBe('dropped_scan');
    expect(sent()).toHaveLength(0);
    expect(table.has(`EMAILREPLY#${digestOf(token)}|TOKEN`)).toBe(true);
    expect(tokenRow(token)!.repliesSent).toBe(0);
  });

  it('a member who has left the household can no longer act', async () => {
    const token = await mint(['t1']);
    vi.mocked(householdService.getMemberByUserId).mockResolvedValue(null);
    const result = await handleInboundReply(inbound(token, 'done 1'), NOW);
    expect(result.disposition).toBe('dropped_not_member');
    expect(sent()).toHaveLength(0);
  });

  it('a message addressed to two reply tokens is dropped', async () => {
    const a = await mint(['t1']);
    const b = await mint(['t2']);
    const result = await handleInboundReply(
      inbound(a, 'done', { recipients: [`care+${a}@${DOMAIN}`, `care+${b}@${DOMAIN}`] }),
      NOW
    );
    expect(result.disposition).toBe('dropped_no_token');
  });

  it('does nothing at all when the reply domain is not configured', async () => {
    delete process.env.EMAIL_REPLY_DOMAIN;
    const result = await handleInboundReply(inbound(newReplyToken(), 'done'), NOW);
    expect(result.disposition).toBe('not_configured');
  });

  it('caps the replies one token can ever cause', async () => {
    const token = await mint(['t1']);
    for (let i = 0; i < MAX_REPLIES_PER_TOKEN + 3; i += 1) {
      await handleInboundReply(inbound(token, 'done 1'), NOW);
    }
    expect(sent()).toHaveLength(MAX_REPLIES_PER_TOKEN);
    expect(taskService.completeTaskWithOutcome).toHaveBeenCalledTimes(MAX_REPLIES_PER_TOKEN + 3);
    expect(tasks.get('hh|t1')!.nextDue).toBe(new Date(Date.parse(DUE_1) + 7 * DAY).toISOString());
  });
});

describe('what a reply may change', () => {
  it('"snooze 2 for 3 days" snoozes exactly task 2, pinned to its occurrence, and logs it like the app', async () => {
    const token = await mint(['t1', 't2']);
    const result = await handleInboundReply(inbound(token, 'snooze 2 for 3 days'), NOW);
    expect(result.disposition).toBe('applied');
    expect(taskService.snoozeTaskWithOutcome).toHaveBeenCalledWith('hh', 't2', 3, DUE_2);
    expect(taskService.completeTaskWithOutcome).not.toHaveBeenCalled();
    expect(tasks.get('hh|t1')!.nextDue).toBe(DUE_1);
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task.snoozed',
        householdId: 'hh',
        actorId: ada.userId,
        payload: expect.objectContaining({ taskId: 't2', days: 3, reason: null, note: null }),
      })
    );
    expect(sent()[0].body).toContain('2. Fern — fertilize: snoozed 3 days.');
  });

  it('a task deleted since the email is reported as gone', async () => {
    const token = await mint(['t1']);
    tasks.delete('hh|t1');
    const result = await handleInboundReply(inbound(token, 'done'), NOW);
    expect(result.outcomes).toEqual([{ kind: 'gone', number: 1 }]);
  });

  it('Spanish tokens are answered in Spanish', async () => {
    const token = await mint(['t1'], { locale: 'es' });
    await handleInboundReply(inbound(token, '«Hecho»'), NOW);
    expect(sent()[0].body).toContain('marcada como hecha');
  });
});

describe('failures are retried, never reported as a choice', () => {
  it('a failed token read rejects and hands the message claim back for the retry', async () => {
    const token = await mint(['t1']);
    const message = inbound(token, 'done 1');
    failGets = true;
    await expect(handleInboundReply(message, NOW)).rejects.toThrow();
    expect(table.has(`EMAILREPLYMSG#${message.sesMessageId}|MESSAGE`)).toBe(false);

    failGets = false;
    const retry = await handleInboundReply(message, NOW);
    expect(retry.disposition).toBe('applied');
    expect(sent()).toHaveLength(1);
  });

  it('a failed send gives its once-only slot back so the retry can still send it', async () => {
    const token = await mint(['t1']);
    const message = inbound(token, 'gibberish');
    sesSend.mockRejectedValueOnce(new Error('Throttling'));
    await expect(handleInboundReply(message, NOW)).rejects.toThrow('Throttling');
    expect(tokenRow(token)!.repliesSent).toBe(0);
    expect(tokenRow(token)!.helpSentAt).toBeUndefined();

    const retry = await handleInboundReply(message, NOW);
    expect(retry).toEqual({ disposition: 'help', replied: true });
  });
});
