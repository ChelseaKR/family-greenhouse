/**
 * The SES inbound forwarder
 * (`infrastructure/modules/email/lambda/forwarder.mjs`).
 *
 * It is a Lambda, not backend source, but it is a security control on the
 * mailbox that carries security@ and abuse@ — and it re-sends from our
 * DKIM-aligned domain, so anything it relays arrives with this project's
 * reputation applied. `eslint.config.mjs` globs only `backend/src` and
 * `frontend/src`, `tsc` never sees a `.mjs`, and nothing else imports this
 * file, so without these tests the relay predicate has no cover at all.
 *
 * The import-by-URL shape follows tests/unit/config/cognitoMessages.test.ts.
 * Every case here is an early return, so no AWS client is ever exercised.
 */
import { describe, expect, it } from 'vitest';

const MODULE_URL = new URL(
  '../../../../infrastructure/modules/email/lambda/forwarder.mjs',
  import.meta.url
);

interface ScanDecision {
  relay: boolean;
  outcome: 'pass' | 'fail' | 'inconclusive' | 'unscanned';
  spam: string;
  virus: string;
}

async function load() {
  return (await import(/* @vite-ignore */ MODULE_URL.href)) as {
    scanDecision: (receipt: unknown) => ScanDecision;
    handler: (event: unknown) => Promise<Record<string, unknown>>;
  };
}

function receipt(spam?: string, virus?: string) {
  const r: Record<string, unknown> = { recipients: ['security@example.test'] };
  if (spam !== undefined) r.spamVerdict = { status: spam };
  if (virus !== undefined) r.virusVerdict = { status: virus };
  return r;
}

function event(spam?: string, virus?: string) {
  return { Records: [{ ses: { mail: { messageId: 'msg-1' }, receipt: receipt(spam, virus) } }] };
}

/**
 * SES emits PASS | FAIL | GRAY | PROCESSING_FAILED, and omits the verdict
 * entirely when the scan did not run. `undefined` stands for that last case —
 * it is the one the `?.` chain used to swallow, because
 * `undefined === 'FAIL'` is false.
 */
const VERDICTS = [undefined, 'PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED'] as const;

describe('scanDecision — the relay predicate', () => {
  it('relays ONLY when both verdicts are an explicit PASS', async () => {
    const { scanDecision } = await load();
    const relayed: string[] = [];
    for (const spam of VERDICTS) {
      for (const virus of VERDICTS) {
        if (scanDecision(receipt(spam, virus)).relay) {
          relayed.push(`${spam ?? 'MISSING'}/${virus ?? 'MISSING'}`);
        }
      }
    }
    expect(relayed).toEqual(['PASS/PASS']);
  });

  it('reports a FAIL on either verdict as `fail`, whatever the other one says', async () => {
    const { scanDecision } = await load();
    for (const other of VERDICTS) {
      expect(scanDecision(receipt('FAIL', other)).outcome).toBe('fail');
      expect(scanDecision(receipt(other, 'FAIL')).outcome).toBe('fail');
    }
  });

  it('separates GRAY (scanned, unsure) from an absent or failed scan', async () => {
    const { scanDecision } = await load();
    expect(scanDecision(receipt('GRAY', 'PASS')).outcome).toBe('inconclusive');
    expect(scanDecision(receipt('PASS', 'GRAY')).outcome).toBe('inconclusive');
    // GRAY is a real verdict, so it outranks a missing one in the reason.
    expect(scanDecision(receipt('GRAY', undefined)).outcome).toBe('inconclusive');

    expect(scanDecision(receipt('PROCESSING_FAILED', 'PASS')).outcome).toBe('unscanned');
    expect(scanDecision(receipt('PASS', 'PROCESSING_FAILED')).outcome).toBe('unscanned');
    expect(scanDecision(receipt(undefined, 'PASS')).outcome).toBe('unscanned');
    expect(scanDecision(receipt('PASS', undefined)).outcome).toBe('unscanned');
    expect(scanDecision(receipt(undefined, undefined)).outcome).toBe('unscanned');
  });

  it('reports a receipt that is missing entirely as unscanned, not as a pass', async () => {
    const { scanDecision } = await load();
    expect(scanDecision(undefined)).toMatchObject({ relay: false, outcome: 'unscanned' });
    expect(scanDecision({})).toMatchObject({ relay: false, outcome: 'unscanned' });
  });

  it('does not treat a non-string verdict as a pass', async () => {
    const { scanDecision } = await load();
    expect(
      scanDecision({ spamVerdict: { status: null }, virusVerdict: { status: 'PASS' } }).relay
    ).toBe(false);
  });
});

describe('handler — what actually leaves the building', () => {
  it.each([
    ['FAIL', 'PASS', 'scan_failed'],
    ['PASS', 'FAIL', 'scan_failed'],
    ['GRAY', 'PASS', 'scan_inconclusive'],
    ['PROCESSING_FAILED', 'PASS', 'scan_unscanned'],
    ['PASS', 'PROCESSING_FAILED', 'scan_unscanned'],
  ])('drops %s/%s as %s without touching S3 or SES', async (spam, virus, reason) => {
    const { handler } = await load();
    await expect(handler(event(spam, virus))).resolves.toEqual({ dropped: true, reason });
  });

  it('drops a message whose verdicts are absent — the case the ?. chain used to swallow', async () => {
    const { handler } = await load();
    await expect(handler(event())).resolves.toEqual({
      dropped: true,
      reason: 'scan_unscanned',
    });
  });

  it('still skips an event with no SES record at all', async () => {
    const { handler } = await load();
    await expect(handler({ Records: [] })).resolves.toEqual({ skipped: true });
  });
});
