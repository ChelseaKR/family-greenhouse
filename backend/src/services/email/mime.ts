/**
 * Minimal RFC 2045/2046/2047 message builder for SES `SendRawEmailCommand`.
 *
 * ## Why raw MIME rather than SESv2
 *
 * The v1 `SendEmailCommand` this codebase used has no header surface at all —
 * `Source`, `Destination`, `Message` and nothing else — so it cannot carry
 * `List-Unsubscribe`. Two ways out: add `@aws-sdk/client-sesv2` (whose
 * `Content.Simple.Headers` accepts custom headers and assembles the MIME for
 * you), or assemble MIME ourselves and keep the existing client.
 *
 * We assemble it. The IAM policy already grants `ses:SendRawEmail`
 * (`infrastructure/modules/api/main.tf`), so this needs no infrastructure
 * change and no new dependency in a Lambda bundle — and the thing SESv2 would
 * have bought us, "don't hand-roll MIME", is 80 lines with three rules
 * (base64 both parts so nothing is 8-bit or over-long, encode the Subject per
 * RFC 2047, CRLF everywhere) and a unit test per rule. ADR 0021 records the
 * trade and the conditions under which we would switch.
 */
import { randomBytes } from 'node:crypto';

export interface RawMessageInput {
  /** RFC 5322 From, e.g. `Family Greenhouse <hello@example.net>`. */
  from: string;
  to: string;
  subject: string;
  /** Plain-text alternative. Always present — never a stripped afterthought. */
  text: string;
  /** HTML alternative. Omit for a text-only message (still a valid message). */
  html?: string;
  replyTo?: string;
  /** Extra headers, e.g. List-Unsubscribe. Values must already be ASCII. */
  headers?: Record<string, string>;
}

const CRLF = '\r\n';

/** Base64 wrapped at 76 characters, as RFC 2045 requires. */
function base64Body(value: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return (encoded.match(/.{1,76}/g) ?? ['']).join(CRLF);
}

/**
 * RFC 2047 encoded-word form for a header value containing non-ASCII (a
 * Spanish subject, an emoji). Split into chunks so each encoded word stays
 * under the 75-character limit, and split on code points so a multi-byte
 * character is never cut in half.
 */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;

  const words: string[] = [];
  let chunk: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    words.push(`=?UTF-8?B?${Buffer.from(chunk.join(''), 'utf8').toString('base64')}?=`);
    chunk = [];
    bytes = 0;
  };
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    // 45 raw bytes -> 60 base64 chars; +12 for the `=?UTF-8?B??=` wrapper
    // leaves the encoded word at 72, comfortably inside the 75 limit.
    if (bytes + size > 45) flush();
    chunk.push(char);
    bytes += size;
  }
  flush();
  // Encoded words are joined by CRLF + a space: a folded header continuation.
  return words.join(`${CRLF} `);
}

/** Strip anything that could inject a header line. Callers build these values
 *  themselves, but a header is the one place a stray CR/LF is a real
 *  vulnerability rather than a cosmetic bug. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Build the complete RFC 5322 message. Returns a UTF-8 Buffer suitable for
 * `SendRawEmailCommand`'s `RawMessage.Data`.
 */
export function buildRawMessage(input: RawMessageInput): Buffer {
  const boundary = `--fg-${randomBytes(12).toString('hex')}`;
  const headers: string[] = [
    `From: ${sanitizeHeaderValue(input.from)}`,
    `To: ${sanitizeHeaderValue(input.to)}`,
    `Subject: ${encodeHeaderValue(sanitizeHeaderValue(input.subject))}`,
    'MIME-Version: 1.0',
  ];
  if (input.replyTo) headers.push(`Reply-To: ${sanitizeHeaderValue(input.replyTo)}`);
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers.push(`${sanitizeHeaderValue(name)}: ${sanitizeHeaderValue(value)}`);
  }

  if (!input.html) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return Buffer.from(
      `${headers.join(CRLF)}${CRLF}${CRLF}${base64Body(input.text)}${CRLF}`,
      'utf8'
    );
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  // Order matters: least-capable part first. A client that understands both
  // shows the last one it can render, which is the HTML.
  const body = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(input.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(input.html),
    `--${boundary}--`,
    '',
  ].join(CRLF);

  return Buffer.from(`${headers.join(CRLF)}${body}`, 'utf8');
}
