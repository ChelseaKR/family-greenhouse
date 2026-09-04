import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SNSEvent } from 'aws-lambda';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (i) {
    return { input: i, kind: 'Put' };
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
