import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SESEvent } from 'aws-lambda';

const s3Send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: s3Send };
  }),
  GetObjectCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  DeleteObjectCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
}));

const handleInboundReply = vi.fn();
vi.mock('../../../src/services/emailReplies.js', () => ({
  handleInboundReply: (...args: unknown[]) => handleInboundReply(...args),
}));

import { handler, MAX_BODY_BYTES } from '../../../src/handlers/emailReplies/handler.js';

const ORIGINAL_ENV = process.env;

function sesEvent(messageId = 'abc123-def'): SESEvent {
  return {
    Records: [
      {
        eventSource: 'aws:ses',
        eventVersion: '1.0',
        ses: {
          mail: {
            messageId,
            commonHeaders: { from: ['Ada <ada@example.com>'], messageId: '<m@x>' },
          },
          receipt: {
            recipients: ['care+abc@familygreenhouse.net'],
            spamVerdict: { status: 'PASS' },
            virusVerdict: { status: 'PASS' },
            dmarcVerdict: { status: 'PASS' },
          },
        },
      },
    ],
  } as unknown as SESEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    EMAIL_REPLY_BUCKET: 'inbound-bucket',
    EMAIL_REPLY_PREFIX: 'replies/',
  };
  s3Send.mockImplementation(async (command: { kind: string }) =>
    command.kind === 'Get'
      ? { Body: { transformToByteArray: async () => new TextEncoder().encode('raw') } }
      : {}
  );
  handleInboundReply.mockImplementation(async (reply: { loadBody: () => Promise<Buffer> }) => {
    await reply.loadBody();
    return { disposition: 'applied', replied: true };
  });
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('emailReplies handler', () => {
  it('adapts the SES event, fetches only the first MiB, and deletes the stored reply afterwards', async () => {
    await expect(handler(sesEvent())).resolves.toEqual({ handled: 1 });

    const reply = handleInboundReply.mock.calls[0][0];
    expect(reply).toMatchObject({
      sesMessageId: 'abc123-def',
      recipients: ['care+abc@familygreenhouse.net'],
      from: ['Ada <ada@example.com>'],
      messageId: '<m@x>',
      verdicts: { spam: 'PASS', virus: 'PASS', dmarc: 'PASS' },
    });

    const [get, del] = s3Send.mock.calls.map(
      (c) => c[0] as { kind: string; input: Record<string, string> }
    );
    expect(get.kind).toBe('Get');
    expect(get.input).toEqual({
      Bucket: 'inbound-bucket',
      Key: 'replies/abc123-def',
      Range: `bytes=0-${MAX_BODY_BYTES - 1}`,
    });
    expect(del.kind).toBe('Delete');
    expect(del.input).toEqual({ Bucket: 'inbound-bucket', Key: 'replies/abc123-def' });
  });

  it('never builds an object key from a message id that is not SES-shaped', async () => {
    handleInboundReply.mockImplementation(async (reply: { loadBody: () => Promise<Buffer> }) => {
      await expect(reply.loadBody()).rejects.toThrow('bucket_not_configured');
      return { disposition: 'dropped_no_token', replied: false };
    });
    await handler(sesEvent('../inbox/secret'));
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('rethrows a failure so the async invoke is retried, and keeps the stored copy for it', async () => {
    handleInboundReply.mockRejectedValueOnce(new Error('dynamo down'));
    await expect(handler(sesEvent())).rejects.toThrow('dynamo down');
    expect(s3Send).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'Delete' }));
  });

  it('a failed delete of the stored copy does not fail a handled reply', async () => {
    s3Send.mockImplementation(async (command: { kind: string }) => {
      if (command.kind === 'Delete') throw new Error('AccessDenied');
      return { Body: { transformToByteArray: async () => new Uint8Array() } };
    });
    await expect(handler(sesEvent())).resolves.toEqual({ handled: 1 });
  });

  it('skips a record with no message id', async () => {
    const event = { Records: [{ ses: { mail: {}, receipt: {} } }] } as unknown as SESEvent;
    await expect(handler(event)).resolves.toEqual({ handled: 0 });
    expect(handleInboundReply).not.toHaveBeenCalled();
  });
});
