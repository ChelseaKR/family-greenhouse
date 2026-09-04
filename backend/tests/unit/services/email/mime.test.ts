import { describe, expect, it } from 'vitest';
import { buildRawMessage, encodeHeaderValue } from '../../../../src/services/email/mime.js';

function decodePart(raw: string, contentType: string): string {
  const marker = `Content-Type: ${contentType}`;
  const start = raw.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = raw.indexOf('\r\n\r\n', start) + 4;
  const bodyEnd = raw.indexOf('\r\n--', bodyStart);
  const b64 = raw.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd).replace(/\r\n/g, '');
  return Buffer.from(b64, 'base64').toString('utf8');
}

describe('buildRawMessage', () => {
  const base = {
    from: 'Family Greenhouse <hello@example.net>',
    to: 'sam@example.com',
    subject: 'Weekly digest: 3 plants could use some care',
    text: 'plain body',
    html: '<p>html body</p>',
  };

  it('produces a multipart/alternative message carrying both parts', () => {
    const raw = buildRawMessage(base).toString('utf8');
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="');
    expect(decodePart(raw, 'text/plain; charset=UTF-8')).toBe('plain body');
    expect(decodePart(raw, 'text/html; charset=UTF-8')).toBe('<p>html body</p>');
  });

  it('puts text before html, so a dual-capable client shows the html', () => {
    const raw = buildRawMessage(base).toString('utf8');
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'));
  });

  it('falls back to a valid single-part message when there is no html', () => {
    const raw = buildRawMessage({ ...base, html: undefined }).toString('utf8');
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).not.toContain('multipart/alternative');
    expect(Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString()).toBe(
      'plain body'
    );
  });

  it('carries List-Unsubscribe headers verbatim', () => {
    const raw = buildRawMessage({
      ...base,
      headers: {
        'List-Unsubscribe': '<https://api.example/notifications/email/unsubscribe?t=abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }).toString('utf8');
    expect(raw).toContain(
      'List-Unsubscribe: <https://api.example/notifications/email/unsubscribe?t=abc>'
    );
    expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('sets Reply-To only when one is configured', () => {
    expect(buildRawMessage(base).toString('utf8')).not.toContain('Reply-To:');
    expect(buildRawMessage({ ...base, replyTo: 'support@example.net' }).toString('utf8')).toContain(
      'Reply-To: support@example.net'
    );
  });

  it('strips CR/LF from header values so a subject cannot inject a header', () => {
    const raw = buildRawMessage({
      ...base,
      subject: 'Hi\r\nBcc: attacker@example.com',
    }).toString('utf8');
    // The injected text is folded into the Subject line rather than starting
    // one of its own, which is what makes it inert.
    expect(raw).not.toContain('\r\nBcc:');
    expect(raw).toContain('Subject: Hi Bcc: attacker@example.com');
  });

  it('wraps base64 bodies at 76 characters', () => {
    const raw = buildRawMessage({ ...base, text: 'x'.repeat(500) }).toString('utf8');
    for (const line of raw.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
    const body = decodePart(raw, 'text/plain; charset=UTF-8');
    expect(body).toBe('x'.repeat(500));
  });

  it('round-trips non-ASCII bodies', () => {
    const raw = buildRawMessage({
      ...base,
      text: 'Riego · 6 días de retraso 🌱',
      html: '<p>Riego · 6 días 🌱</p>',
    }).toString('utf8');
    expect(decodePart(raw, 'text/plain; charset=UTF-8')).toBe('Riego · 6 días de retraso 🌱');
    expect(decodePart(raw, 'text/html; charset=UTF-8')).toBe('<p>Riego · 6 días 🌱</p>');
  });
});

describe('encodeHeaderValue', () => {
  it('leaves a pure-ASCII subject alone', () => {
    const subject = 'Weekly digest: 3 plants could use some care';
    expect(encodeHeaderValue(subject)).toBe(subject);
  });

  it('encodes a Spanish subject as RFC 2047 encoded words', () => {
    const encoded = encodeHeaderValue('Resumen semanal: 3 plantas necesitan cuidados 🌱');
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
    const decoded = encoded
      .split(/\r\n ?/)
      .map((word) => Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe('Resumen semanal: 3 plantas necesitan cuidados 🌱');
  });

  it('keeps every encoded word inside the 75-character limit', () => {
    const encoded = encodeHeaderValue(`Tu año ${'á'.repeat(120)} en el invernadero`);
    for (const word of encoded.split(/\r\n ?/)) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte character across encoded words', () => {
    const source = '🌱'.repeat(40);
    const encoded = encodeHeaderValue(source);
    const decoded = encoded
      .split(/\r\n ?/)
      .map((word) => Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(source);
  });
});
