import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SNSEvent } from 'aws-lambda';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (i) {
    return { input: i, kind: 'Put' };
  }),
  DeleteCommand: vi.fn(function (i) {
    return { input: i, kind: 'Delete' };
  }),
  UpdateCommand: vi.fn(function (i) {
    return { input: i, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/emailSuppression.js', () => ({
  recordHardBounce: vi.fn(async () => ({ state: 'suppressed', reason: 'hard_bounce' })),
  recordSoftBounce: vi.fn(async () => ({ state: 'transient', softBounceCount: 1 })),
  recordComplaint: vi.fn(async () => ({ state: 'suppressed', reason: 'complaint' })),
  recordDelivery: vi.fn(async () => undefined),
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import * as emailSuppression from '../../../src/services/emailSuppression.js';
import { handler, applyNotification } from '../../../src/handlers/emailEvents/handler.js';

const send = dynamodb.send as unknown as ReturnType<typeof vi.fn>;

function snsEvent(message: unknown): SNSEvent {
  return {
    Records: [{ Sns: { Message: JSON.stringify(message) } }],
  } as unknown as SNSEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the event claim succeeds (first time we have seen this one).
  send.mockResolvedValue({});
});

describe('emailEvents handler', () => {
  it('suppresses on a permanent bounce', async () => {
    await handler(
      snsEvent({
        eventType: 'Bounce',
        mail: { messageId: 'm1' },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [{ emailAddress: 'gone@b.com' }],
        },
      })
    );
    expect(emailSuppression.recordHardBounce).toHaveBeenCalledWith(
      'gone@b.com',
      'Permanent/General',
      expect.any(Date)
    );
    expect(emailSuppression.recordSoftBounce).not.toHaveBeenCalled();
  });

  it('counts a transient bounce instead of suppressing', async () => {
    await handler(
      snsEvent({
        eventType: 'Bounce',
        mail: { messageId: 'm2' },
        bounce: {
          bounceType: 'Transient',
          bounceSubType: 'MailboxFull',
          bouncedRecipients: [{ emailAddress: 'full@b.com' }],
        },
      })
    );
    expect(emailSuppression.recordSoftBounce).toHaveBeenCalledWith(
      'full@b.com',
      'Transient/MailboxFull',
      expect.any(Date)
    );
    expect(emailSuppression.recordHardBounce).not.toHaveBeenCalled();
  });

  it('treats an undetermined bounce as transient, not permanent', async () => {
    await handler(
      snsEvent({
        eventType: 'Bounce',
        mail: { messageId: 'm3' },
        bounce: {
          bounceType: 'Undetermined',
          bouncedRecipients: [{ emailAddress: 'maybe@b.com' }],
        },
      })
    );
    expect(emailSuppression.recordSoftBounce).toHaveBeenCalledWith(
      'maybe@b.com',
      'Undetermined/Unknown',
      expect.any(Date)
    );
  });

  it('suppresses every complained recipient', async () => {
    await handler(
      snsEvent({
        eventType: 'Complaint',
        mail: { messageId: 'm4' },
        complaint: {
          complaintFeedbackType: 'abuse',
          complainedRecipients: [{ emailAddress: 'a@b.com' }, { emailAddress: 'c@d.com' }],
        },
      })
    );
    expect(emailSuppression.recordComplaint).toHaveBeenCalledTimes(2);
  });

  it('clears the transient counter on a delivery', async () => {
    await handler(
      snsEvent({
        eventType: 'Delivery',
        mail: { messageId: 'm5' },
        delivery: { recipients: ['a@b.com'] },
      })
    );
    expect(emailSuppression.recordDelivery).toHaveBeenCalledWith('a@b.com');
  });

  it('accepts the older identity-level notificationType payload shape', async () => {
    await handler(
      snsEvent({
        notificationType: 'Bounce',
        mail: { messageId: 'm6' },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'NoEmail',
          bouncedRecipients: [{ emailAddress: 'gone@b.com' }],
        },
      })
    );
    expect(emailSuppression.recordHardBounce).toHaveBeenCalledTimes(1);
  });

  it('applies a redelivered notification only once', async () => {
    const conditional = new Error('exists');
    conditional.name = 'ConditionalCheckFailedException';
    send.mockRejectedValueOnce(conditional);
    const summary = await handler(
      snsEvent({
        eventType: 'Bounce',
        mail: { messageId: 'm7' },
        bounce: {
          bounceType: 'Transient',
          bouncedRecipients: [{ emailAddress: 'a@b.com' }],
        },
      })
    );
    expect(summary).toEqual({ processed: 0, duplicate: 1, ignored: 0 });
    expect(emailSuppression.recordSoftBounce).not.toHaveBeenCalled();
  });

  it('ignores event types with no recipients to act on (Send, Open, …)', async () => {
    const summary = await handler(snsEvent({ eventType: 'Send', mail: { messageId: 'm8' } }));
    expect(summary).toEqual({ processed: 0, duplicate: 0, ignored: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('names a Reject in the logs rather than counting it silently', async () => {
    const { logger } = await import('../../../src/utils/logger.js');
    const info = vi.spyOn(logger, 'info');
    // SES refused the message outright: nothing left the building, and a send
    // that never happened must not read as one.
    await handler(snsEvent({ eventType: 'Reject', mail: { messageId: 'm10' } }));
    expect(info).toHaveBeenCalledWith({ kind: 'Reject' }, 'email_events.no_action');
    info.mockRestore();
  });

  it('reports an unparseable SNS message rather than counting it as handled', async () => {
    const summary = await handler({
      Records: [{ Sns: { Message: 'not json' } }],
    } as unknown as SNSEvent);
    expect(summary).toEqual({ processed: 0, duplicate: 0, ignored: 1 });
  });

  it('processes an event with no messageId rather than dropping the bounce', async () => {
    const summary = await applyNotification({
      eventType: 'Bounce',
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'gone@b.com' }],
      },
    });
    expect(summary.processed).toBe(1);
    expect(emailSuppression.recordHardBounce).toHaveBeenCalledTimes(1);
    // No claim was attempted — there is no id to claim with.
    expect(send).not.toHaveBeenCalled();
  });

  it('propagates a suppression write failure so Lambda retries into the DLQ', async () => {
    vi.mocked(emailSuppression.recordHardBounce).mockRejectedValueOnce(new Error('ddb down'));
    await expect(
      handler(
        snsEvent({
          eventType: 'Bounce',
          mail: { messageId: 'm9' },
          bounce: {
            bounceType: 'Permanent',
            bouncedRecipients: [{ emailAddress: 'gone@b.com' }],
          },
        })
      )
    ).rejects.toThrow('ddb down');
  });
});

/**
 * A DynamoDB stand-in that honours the three conditional writes the claim
 * lifecycle depends on. `send.mockResolvedValue({})` cannot express any of
 * them, and the defect these tests cover is entirely about what the second
 * attempt reads back, so the table has to remember.
 */
interface FakeCommand {
  kind: 'Put' | 'Delete' | 'Update';
  input: {
    Item?: Record<string, unknown>;
    Key?: { PK: string; SK: string };
    ConditionExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
  };
}

function conditionalCheckFailed(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

function installFakeTable(): Map<string, Record<string, unknown>> {
  const table = new Map<string, Record<string, unknown>>();
  const keyOf = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
  send.mockImplementation((command: FakeCommand) => {
    const values = command.input.ExpressionAttributeValues ?? {};
    // The conditions are READ off the command rather than assumed, so a claim
    // that stops leasing — `attribute_not_exists(PK)` alone — is rejected here
    // exactly as DynamoDB would reject it, instead of being quietly forgiven.
    const condition = command.input.ConditionExpression ?? '';
    if (command.kind === 'Put') {
      const item = command.input.Item as Record<string, unknown> & { PK: string; SK: string };
      const existing = table.get(keyOf(item));
      // `attribute_not_exists(PK) OR (#status = :applying AND leaseExpiresAt <= :now)`
      const reclaimable =
        existing !== undefined &&
        condition.includes('leaseExpiresAt <= :now') &&
        existing.status === values[':applying'] &&
        Number(existing.leaseExpiresAt ?? 0) <= Number(values[':now']);
      if (existing && condition.includes('attribute_not_exists(PK)') && !reclaimable) {
        return Promise.reject(conditionalCheckFailed());
      }
      table.set(keyOf(item), { ...item });
      return Promise.resolve({});
    }
    const key = keyOf(command.input.Key as { PK: string; SK: string });
    const existing = table.get(key);
    if (command.kind === 'Delete') {
      // `reservationId = :reservationId`
      const guarded = condition.includes('reservationId = :reservationId');
      if (!existing || (guarded && existing.reservationId !== values[':reservationId'])) {
        return Promise.reject(conditionalCheckFailed());
      }
      table.delete(key);
      return Promise.resolve({});
    }
    // Update — the finalize. `#status = :applying AND reservationId = :reservationId`
    if (
      !existing ||
      (condition.includes('#status = :applying') && existing.status !== values[':applying']) ||
      (condition.includes('reservationId = :reservationId') &&
        existing.reservationId !== values[':reservationId'])
    ) {
      return Promise.reject(conditionalCheckFailed());
    }
    const { leaseExpiresAt: _lease, reservationId: _reservation, ...kept } = existing;
    table.set(key, { ...kept, status: values[':applied'], processedAt: values[':processedAt'] });
    return Promise.resolve({});
  });
  return table;
}

const hardBounce = {
  eventType: 'Bounce',
  mail: { messageId: 'claim-1' },
  bounce: {
    bounceType: 'Permanent',
    bounceSubType: 'General',
    bouncedRecipients: [{ emailAddress: 'gone@b.com' }],
  },
};

describe('emailEvents claim lifecycle', () => {
  it('re-applies a bounce whose first attempt failed, rather than reading its own claim as a duplicate', async () => {
    const table = installFakeTable();
    vi.mocked(emailSuppression.recordHardBounce).mockRejectedValueOnce(new Error('ddb throttled'));

    await expect(handler(snsEvent(hardBounce))).rejects.toThrow('ddb throttled');
    // The failed attempt handed its claim back; nothing is left behind to be
    // mistaken for a completed event.
    expect(table.size).toBe(0);

    // Lambda's async retry: the same SNS record, a second time.
    const retry = await handler(snsEvent(hardBounce));
    expect(retry).toEqual({ processed: 1, duplicate: 0, ignored: 0 });
    expect(emailSuppression.recordHardBounce).toHaveBeenCalledTimes(2);
  });

  it('holds the claim as a lease during the apply and finalizes it only after the write returns', async () => {
    const table = installFakeTable();
    vi.mocked(emailSuppression.recordHardBounce).mockImplementationOnce(async () => {
      const marker = [...table.values()][0];
      // Mid-apply the marker records an intention, not an effect.
      expect(marker.status).toBe('applying');
      expect(Number(marker.leaseExpiresAt)).toBeGreaterThan(0);
      expect(marker.processedAt).toBeUndefined();
      return { state: 'suppressed', reason: 'hard_bounce' } as never;
    });

    await handler(snsEvent(hardBounce));

    const marker = [...table.values()][0];
    expect(marker.status).toBe('applied');
    expect(marker.leaseExpiresAt).toBeUndefined();
    expect(marker.reservationId).toBeUndefined();
    expect(marker.processedAt).toEqual(expect.any(String));
  });

  it('still treats a genuine re-delivery of an applied event as a duplicate', async () => {
    installFakeTable();
    expect(await handler(snsEvent(hardBounce))).toEqual({
      processed: 1,
      duplicate: 0,
      ignored: 0,
    });
    expect(await handler(snsEvent(hardBounce))).toEqual({
      processed: 0,
      duplicate: 1,
      ignored: 0,
    });
    expect(emailSuppression.recordHardBounce).toHaveBeenCalledTimes(1);
  });

  it('blocks a re-delivery while the lease is live and reclaims the claim once it expires', async () => {
    const table = installFakeTable();
    const stored = send.getMockImplementation() as (c: FakeCommand) => Promise<unknown>;
    // A Lambda killed mid-loop never gets to release. Model that by failing the
    // release itself, so the claim survives the failed attempt.
    send.mockImplementation((command: FakeCommand) =>
      command.kind === 'Delete' ? Promise.reject(new Error('release failed')) : stored(command)
    );
    vi.mocked(emailSuppression.recordHardBounce).mockRejectedValueOnce(new Error('ddb throttled'));

    const t0 = new Date('2026-09-05T00:00:00.000Z');
    await expect(applyNotification(hardBounce, t0)).rejects.toThrow('ddb throttled');
    expect([...table.values()][0].status).toBe('applying');

    // Inside the lease window a re-delivery is still a duplicate: another
    // invocation may be applying this very event right now.
    expect(await applyNotification(hardBounce, new Date(t0.getTime() + 60_000))).toEqual({
      processed: 0,
      duplicate: 1,
      ignored: 0,
    });
    expect(emailSuppression.recordHardBounce).toHaveBeenCalledTimes(1);

    // Past the lease the abandoned claim is reclaimable, so the bounce lands.
    expect(await applyNotification(hardBounce, new Date(t0.getTime() + 6 * 60_000))).toEqual({
      processed: 1,
      duplicate: 0,
      ignored: 0,
    });
    expect(emailSuppression.recordHardBounce).toHaveBeenCalledTimes(2);
  });

  it('suppresses every complained recipient even when one write fails, then rethrows', async () => {
    installFakeTable();
    const complaint = {
      eventType: 'Complaint',
      mail: { messageId: 'claim-2' },
      complaint: {
        complaintFeedbackType: 'abuse',
        complainedRecipients: [{ emailAddress: 'a@b.com' }, { emailAddress: 'c@d.com' }],
      },
    };
    vi.mocked(emailSuppression.recordComplaint).mockRejectedValueOnce(new Error('ddb throttled'));

    await expect(handler(snsEvent(complaint))).rejects.toThrow('ddb throttled');
    // The second recipient is not collateral damage of the first one's failure.
    expect(emailSuppression.recordComplaint).toHaveBeenCalledWith(
      'c@d.com',
      'abuse',
      expect.any(Date)
    );
    expect(emailSuppression.recordComplaint).toHaveBeenCalledTimes(2);

    // And the retry picks up the one that failed.
    await handler(snsEvent(complaint));
    expect(emailSuppression.recordComplaint).toHaveBeenCalledWith(
      'a@b.com',
      'abuse',
      expect.any(Date)
    );
    expect(emailSuppression.recordComplaint).toHaveBeenCalledTimes(4);
  });
});
