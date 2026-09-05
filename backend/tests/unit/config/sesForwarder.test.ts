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
 *
 * ## Coverage cannot report on this file, so these tests are the only signal
 *
 * v8 coverage is rooted at the `backend/` workspace and this Lambda lives
 * outside it, so it is neither numerator nor denominator: importing it here
 * contributes `0/0` and moves no floor in either direction. That was once
 * recorded as a reason NOT to test `rewrite`; measured, it is not one. The
 * real consequence runs the other way — nothing will ever flag this file as
 * untested, so the absence of a test here is invisible rather than red.
 */
import { describe, expect, it } from 'vitest';

const MODULE_URL = new URL(
  '../../../../infrastructure/modules/email/lambda/forwarder.mjs',
  import.meta.url
);

/**
 * `FROM_ADDRESS` is read at MODULE SCOPE in the forwarder, so it has to exist
 * before the first dynamic import or it is captured as `undefined` — which
 * fails silently, as the literal string "undefined" inside an outgoing From
 * header rather than as an error. Set here, above every `load()`.
 */
const FORWARDER = 'forwarder@example.test';
process.env.FROM_ADDRESS = FORWARDER;

interface ScanDecision {
  relay: boolean;
  outcome: 'pass' | 'fail' | 'inconclusive' | 'unscanned';
  spam: string;
  virus: string;
}

async function load() {
  return (await import(/* @vite-ignore */ MODULE_URL.href)) as {
    scanDecision: (receipt: unknown) => ScanDecision;
    rewrite: (rawBytes: Buffer, originalRecipient: string) => Buffer;
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

// ---------------------------------------------------------------------------
// rewrite — the message that actually goes out (#583)
// ---------------------------------------------------------------------------

const RECIPIENT = 'security@example.test';

/** A raw MIME message, built from BYTES so a body can hold whatever it likes. */
function raw(headerLines: string[], body: Buffer | string = '', eol = '\r\n'): Buffer {
  return Buffer.concat([
    Buffer.from(headerLines.join(eol) + eol + eol, 'latin1'),
    typeof body === 'string' ? Buffer.from(body, 'latin1') : body,
  ]);
}

/**
 * Split a rewritten message the way a receiving MTA would: find the separator,
 * keep the body as BYTES (decoding it would destroy the thing under test), and
 * return the header block as a latin1 string.
 */
function parseOut(out: Buffer): { header: string; body: Buffer; eol: string } {
  let at = out.indexOf(Buffer.from('\r\n\r\n'));
  let sepLen = 4;
  let eol = '\r\n';
  if (at === -1) {
    at = out.indexOf(Buffer.from('\n\n'));
    sepLen = 2;
    eol = '\n';
  }
  if (at === -1) return { header: out.toString('latin1'), body: Buffer.alloc(0), eol };
  return {
    header: out.subarray(0, at).toString('latin1'),
    body: out.subarray(at + sepLen),
    eol,
  };
}

/** The field name of every line that starts a header, in order. */
function fieldNames(header: string, eol: string): string[] {
  return header
    .split(eol)
    .filter((line) => !/^[ \t]/.test(line))
    .map((line) => /^([^\s:]+):/.exec(line)?.[1] ?? line)
    .filter(Boolean);
}

/**
 * True when every CR and LF in the header block belongs to a complete line
 * ending. A BARE CR or LF is precisely how an injected header rides in: it
 * ends the current line for a parser that is looking for one, and whatever
 * follows becomes a header of the attacker's choosing.
 */
function noBareLineBreaks(header: string, eol: string): boolean {
  return header.split(eol).every((chunk) => !/[\r\n]/.test(chunk));
}

describe('rewrite — the message that actually goes out', () => {
  describe('body bytes', () => {
    it('forwards the body byte-for-byte, including octets that are not valid UTF-8', async () => {
      const { rewrite } = await load();
      // A latin-1 (c), a NUL, an unpaired 0xFF/0xFE, and a lone 0x80
      // continuation byte: every one of these becomes U+FFFD if the message is
      // decoded as UTF-8 and re-encoded, which is the defect the byte-split
      // implementation exists to prevent. This stands in for 8-bit MIME,
      // `Content-Transfer-Encoding: binary`, legacy charsets and binary
      // attachment parts.
      const body = Buffer.from([0xa9, 0x00, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0x41]);
      const out = rewrite(raw(['From: a@x.test', 'Subject: report'], body), RECIPIENT);

      // Buffer.equals, NOT a string comparison — a decoded comparison passes
      // through exactly the corruption this is testing for.
      expect(parseOut(out).body.equals(body)).toBe(true);
    });

    it('leaves a body that itself contains a blank line intact', async () => {
      const { rewrite } = await load();
      // Only the FIRST separator splits; a MIME part boundary later in the
      // body must not be mistaken for it and truncate the message.
      const body = Buffer.from('part one\r\n\r\npart two\r\n', 'latin1');
      const out = rewrite(raw(['From: a@x.test'], body), RECIPIENT);
      expect(parseOut(out).body.equals(body)).toBe(true);
    });
  });

  describe('header injection', () => {
    it('cannot be made to emit an extra header by a bare LF in From', async () => {
      const { rewrite } = await load();
      // The message is CRLF-framed, so `split('\r\n')` never breaks on this
      // lone LF and it reaches the rewritten headers still inside the value.
      const out = rewrite(
        raw(['From: "Ev\nBcc: victim@example.test" <ev@bad.test>', 'Subject: hi'], 'body'),
        RECIPIENT
      );
      const { header, eol } = parseOut(out);

      expect(noBareLineBreaks(header, eol)).toBe(true);
      expect(fieldNames(header, eol)).toEqual([
        'Subject',
        'From',
        'Reply-To',
        'X-Forwarded-For-Mailbox',
      ]);
      // The text survives as text — neutralised, not deleted, so a human
      // reading the forwarded mail can still see what was attempted.
      expect(header).toContain('Bcc: victim@example.test');
      expect(header).not.toMatch(/(^|\r\n)Bcc:/);
    });

    it('cannot be made to emit an extra header by a bare CR in From', async () => {
      const { rewrite } = await load();
      const out = rewrite(
        raw(['From: Ev\rX-Injected: yes <ev@bad.test>', 'Subject: hi'], 'body'),
        RECIPIENT
      );
      const { header, eol } = parseOut(out);

      expect(noBareLineBreaks(header, eol)).toBe(true);
      expect(fieldNames(header, eol)).toEqual([
        'Subject',
        'From',
        'Reply-To',
        'X-Forwarded-For-Mailbox',
      ]);
      expect(header).not.toMatch(/(^|\r\n)X-Injected:/);
    });

    it('keeps the display name quoted when the original From carries a quote', async () => {
      const { rewrite } = await load();
      const out = rewrite(raw(['From: "a"b" <ev@bad.test>', 'Subject: hi'], 'body'), RECIPIENT);
      const { header, eol } = parseOut(out);
      const fromLine = header.split(eol).find((l) => l.startsWith('From: ')) as string;

      // Every `"` inside the name became an apostrophe, so the two quotes in
      // the emitted line are the ones this code put there.
      expect(fromLine.match(/"/g)).toHaveLength(2);
      expect(fromLine).toBe(`From: "'a'b' <ev@bad.test> (via ${RECIPIENT})" <${FORWARDER}>`);
      // Reply-To deliberately keeps the original quoting: a legitimately
      // quoted display name (`"Doe, John"`) is not safely re-quoted with
      // apostrophes, and line breaks — not quotes — are the injection vector.
      expect(header.split(eol)).toContain('Reply-To: "a"b" <ev@bad.test>');
    });

    it('addresses the forwarder identity it was configured with', async () => {
      const { rewrite } = await load();
      const out = rewrite(raw(['From: a@x.test'], 'body'), RECIPIENT);
      // Guards the module-scope FROM_ADDRESS read: an unset env var lands here
      // as the string "undefined" rather than raising anything.
      expect(parseOut(out).header).toContain(`<${FORWARDER}>`);
      expect(parseOut(out).header).not.toContain('undefined');
    });
  });

  describe('the strip list', () => {
    it('removes Return-Path, Sender, DKIM-Signature and Message-ID, keeping the rest in order', async () => {
      const { rewrite } = await load();
      const out = rewrite(
        raw([
          'Return-Path: <bounce@bad.test>',
          'Received: from mta.example.test',
          'DKIM-Signature: v=1; a=rsa-sha256; b=AAAA',
          'Subject: report',
          'Sender: agent@bad.test',
          'Message-ID: <1@bad.test>',
          'From: a@x.test',
          'Reply-To: old@bad.test',
          'X-Keep-Me: 1',
        ]),
        RECIPIENT
      );
      const { header, eol } = parseOut(out);

      // A stale DKIM-Signature on a re-sent message is a deliverability
      // failure that presents as silent non-delivery, not as an error.
      expect(fieldNames(header, eol)).toEqual([
        'Received',
        'Subject',
        'X-Keep-Me',
        'From',
        'Reply-To',
        'X-Forwarded-For-Mailbox',
      ]);
      expect(header).not.toContain('old@bad.test');
    });

    it('strips them whatever case they arrive in', async () => {
      const { rewrite } = await load();
      const out = rewrite(
        raw(['RETURN-PATH: <b@bad.test>', 'dkim-signature: v=1; b=AAAA', 'From: a@x.test']),
        RECIPIENT
      );
      const { header, eol } = parseOut(out);
      expect(fieldNames(header, eol)).toEqual(['From', 'Reply-To', 'X-Forwarded-For-Mailbox']);
    });
  });

  describe('header unfolding', () => {
    it('removes a FOLDED From entirely and carries it, unfolded, into Reply-To', async () => {
      const { rewrite } = await load();
      // Without unfolding, the continuation line is matched as a header of its
      // own: the `From:` filter drops only the first line and the remainder
      // survives into the outgoing message.
      const out = rewrite(
        raw(['From: Alice', ' Example <alice@x.test>', 'Subject: hi'], 'body'),
        RECIPIENT
      );
      const { header, eol } = parseOut(out);

      expect(fieldNames(header, eol)).toEqual([
        'Subject',
        'From',
        'Reply-To',
        'X-Forwarded-For-Mailbox',
      ]);
      expect(header).toContain('Reply-To: Alice  Example <alice@x.test>');
      expect(noBareLineBreaks(header, eol)).toBe(true);
    });

    it('keeps an unrelated folded header folded', async () => {
      const { rewrite } = await load();
      const out = rewrite(
        raw(['From: a@x.test', 'Subject: a very', '\tlong subject'], 'body'),
        RECIPIENT
      );
      const { header, eol } = parseOut(out);
      expect(header.split(eol)).toContain('\tlong subject');
      expect(fieldNames(header, eol)).toEqual([
        'Subject',
        'From',
        'Reply-To',
        'X-Forwarded-For-Mailbox',
      ]);
    });
  });

  describe('separator handling', () => {
    it('round-trips an LFLF message with LF endings', async () => {
      const { rewrite } = await load();
      const out = rewrite(raw(['From: a@x.test', 'Subject: hi'], 'body text\n', '\n'), RECIPIENT);
      const text = out.toString('latin1');

      expect(text).not.toContain('\r');
      expect(text.endsWith('\n\nbody text\n')).toBe(true);
      const { header, eol } = parseOut(out);
      expect(eol).toBe('\n');
      expect(fieldNames(header, eol)).toEqual([
        'Subject',
        'From',
        'Reply-To',
        'X-Forwarded-For-Mailbox',
      ]);
    });

    it('does not throw on a message with no separator at all, and loses nothing', async () => {
      const { rewrite } = await load();
      // `splitAt === -1`: the whole message is treated as headers and the body
      // is empty. Reachable, and materially different from the other two — so
      // it is asserted rather than assumed.
      const out = rewrite(Buffer.from('From: a@x.test\r\nSubject: hi', 'latin1'), RECIPIENT);
      const text = out.toString('latin1');

      expect(text).toContain('Subject: hi');
      expect(text).toContain(`<${FORWARDER}>`);
      expect(text).toContain('Reply-To: a@x.test');
      // There was no body to keep, so nothing may be appended after the
      // separator either.
      expect(parseOut(out).body).toHaveLength(0);
    });
  });

  describe('a message with no From at all', () => {
    it('says "Unknown sender" and emits NO Reply-To', async () => {
      const { rewrite } = await load();
      const out = rewrite(raw(['Subject: hi', `To: ${RECIPIENT}`], 'body'), RECIPIENT);
      const { header, eol } = parseOut(out);

      expect(header).toContain(`From: "Unknown sender (via ${RECIPIENT})" <${FORWARDER}>`);
      // A `Reply-To:` with nothing after it is worse than none: it is a header
      // that claims a reply address and supplies none.
      expect(fieldNames(header, eol)).toEqual(['Subject', 'To', 'From', 'X-Forwarded-For-Mailbox']);
    });

    it('treats a whitespace-only From as no From', async () => {
      const { rewrite } = await load();
      const out = rewrite(raw(['From:   ', 'Subject: hi'], 'body'), RECIPIENT);
      const { header, eol } = parseOut(out);
      expect(header).toContain('Unknown sender');
      expect(fieldNames(header, eol)).toEqual(['Subject', 'From', 'X-Forwarded-For-Mailbox']);
    });
  });
});
