import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SNOOZE_DAYS,
  MAX_SNOOZE_DAYS,
  commandLine,
  extractReplyText,
  htmlToText,
  parseReplyCommand,
  safeMessageId,
  senderAddress,
} from '../../../../src/services/email/replyCommand.js';

describe('parseReplyCommand — the closed grammar', () => {
  it.each([
    ['done', { kind: 'complete', tasks: null }],
    ['Done!', { kind: 'complete', tasks: null }],
    ['DONE.', { kind: 'complete', tasks: null }],
    ['"done"', { kind: 'complete', tasks: null }],
    ['complete', { kind: 'complete', tasks: null }],
    ['completed', { kind: 'complete', tasks: null }],
    ['done 1', { kind: 'complete', tasks: [1] }],
    ['done 1,3', { kind: 'complete', tasks: [1, 3] }],
    ['done 3, 1', { kind: 'complete', tasks: [1, 3] }],
    ['done 1 and 3', { kind: 'complete', tasks: [1, 3] }],
    ['done #2', { kind: 'complete', tasks: [2] }],
    ['done 2 2', { kind: 'complete', tasks: [2] }],
    ['done task 2', { kind: 'complete', tasks: [2] }],
    // Spanish, with and without accents and the catalog's own quotes.
    ['hecho', { kind: 'complete', tasks: null }],
    ['Hecha', { kind: 'complete', tasks: null }],
    ['«Hecho 1, 2»', { kind: 'complete', tasks: [1, 2] }],
    ['listo 1 y 2', { kind: 'complete', tasks: [1, 2] }],
    ['completado', { kind: 'complete', tasks: null }],
  ])('%s', (line, expected) => {
    expect(parseReplyCommand(line)).toEqual(expected);
  });

  it.each([
    ['snooze', { kind: 'snooze', tasks: null, days: DEFAULT_SNOOZE_DAYS }],
    ['snooze 2 days', { kind: 'snooze', tasks: null, days: 2 }],
    ['snooze 3d', { kind: 'snooze', tasks: null, days: 3 }],
    ['snooze for 1 day', { kind: 'snooze', tasks: null, days: 1 }],
    ['snooze 1 week', { kind: 'snooze', tasks: null, days: 7 }],
    ['snooze 2 for 3 days', { kind: 'snooze', tasks: [2], days: 3 }],
    ['snooze 1, 3 2d', { kind: 'snooze', tasks: [1, 3], days: 2 }],
    ['snooze 1, 3', { kind: 'snooze', tasks: [1, 3], days: DEFAULT_SNOOZE_DAYS }],
    ['posponer', { kind: 'snooze', tasks: null, days: DEFAULT_SNOOZE_DAYS }],
    ['posponer 2 días', { kind: 'snooze', tasks: null, days: 2 }],
    ['Posponer 2 por 3 días', { kind: 'snooze', tasks: [2], days: 3 }],
    ['pospón 1 semana', { kind: 'snooze', tasks: null, days: 7 }],
    ['aplazar 3 dias', { kind: 'snooze', tasks: null, days: 3 }],
    [`snooze ${MAX_SNOOZE_DAYS} days`, { kind: 'snooze', tasks: null, days: MAX_SNOOZE_DAYS }],
  ])('%s', (line, expected) => {
    expect(parseReplyCommand(line)).toEqual(expected);
  });

  it.each([
    // Ambiguous: task 2 for a day, or two days? Never guessed.
    'snooze 2',
    'posponer 3',
    // Out of range.
    'snooze 0 days',
    `snooze ${MAX_SNOOZE_DAYS + 1} days`,
    'snooze 53 weeks',
    'done 0',
    'done 100',
    // Anything that is not exactly a command.
    'done thanks',
    'done, thanks!',
    'thanks, done',
    'I did it',
    'yes',
    'skip',
    'delete',
    'done all',
    'done 1-3',
    'hecha la 2',
    'done 1; drop table',
    // A task id pasted from the app is not a task number.
    'done 5f3c9a1e-0b7d-4c55-9a8e-2d1f6b0c7e11',
    '',
    '   ',
    `done ${'1 '.repeat(40)}`,
  ])('%j is unrecognized', (line) => {
    expect(parseReplyCommand(line)).toEqual({ kind: 'unrecognized' });
  });

  it('treats a missing line as unrecognized', () => {
    expect(parseReplyCommand(null)).toEqual({ kind: 'unrecognized' });
  });
});

describe('commandLine — only the first line above the quote', () => {
  it('takes the first non-empty line and ignores everything under it', () => {
    expect(commandLine('\n\n  done 2  \nsnooze 1 for 3 days\n')).toBe('done 2');
  });

  it.each([
    [
      'Gmail',
      'On Tue, Sep 16, 2026 at 8:00 AM Family Greenhouse <care+x@f.net> wrote:\n> 1. Monstera',
    ],
    [
      'Spanish Gmail',
      'El mar, 16 sept 2026 a las 8:00, Family Greenhouse escribió:\n> 1. Monstera',
    ],
    ['quoted lines', '> done 1\n> snooze'],
    ['Outlook header block', 'From: Family Greenhouse <care+x@f.net>\nSent: Tuesday\n1. done'],
    ['Outlook separator', '________________________________\nFrom: x'],
    ['an original-message divider', '-----Original Message-----\ndone'],
    ['a signature', '-- \nSent from my phone'],
    ['a mobile footer', 'Sent from my iPhone\n\nOn Tue wrote:'],
  ])('finds no command in a reply that only quotes (%s)', (_label, text) => {
    expect(commandLine(text)).toBeNull();
  });

  it('does not read a command out of the quoted reminder under a real first line', () => {
    const text = 'thanks!\n\nOn Tue, Family Greenhouse wrote:\n> done 1';
    expect(commandLine(text)).toBe('thanks!');
    expect(parseReplyCommand(commandLine(text))).toEqual({ kind: 'unrecognized' });
  });

  it('treats non-breaking and zero-width spaces as whitespace', () => {
    expect(commandLine('\u00a0\u200b\ndone\u00a01\u200b')).toBe('done 1');
  });

  it('handles null and empty input', () => {
    expect(commandLine(null)).toBeNull();
    expect(commandLine('')).toBeNull();
  });
});

const CRLF = '\r\n';
const mime = (lines: string[]) => Buffer.from(lines.join(CRLF), 'latin1');

describe('extractReplyText', () => {
  it('reads a single-part text/plain message', () => {
    const raw = mime([
      'From: a@b.test',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'done 1',
      '',
    ]);
    expect(commandLine(extractReplyText(raw))).toBe('done 1');
  });

  it('prefers text/plain inside multipart/alternative and decodes quoted-printable', () => {
    const raw = mime([
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'posponer 2 por 3 d=C3=ADas',
      '',
      '> quoted',
      '--b1',
      'Content-Type: text/html; charset="UTF-8"',
      '',
      '<div>done 1</div>',
      '--b1--',
      '',
    ]);
    const line = commandLine(extractReplyText(raw));
    expect(line).toBe('posponer 2 por 3 días');
    expect(parseReplyCommand(line)).toEqual({ kind: 'snooze', tasks: [2], days: 3 });
  });

  it('decodes a base64 body in a nested multipart/mixed and skips attachments', () => {
    const raw = mime([
      'Content-Type: multipart/mixed; boundary=outer',
      '',
      '--outer',
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      '',
      'done 9',
      '--outer',
      'Content-Type: multipart/alternative; boundary=inner',
      '',
      '--inner',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('hecho 2\r\n\r\nEl lun escribió:\r\n> 1.').toString('base64'),
      '--inner--',
      '--outer--',
      '',
    ]);
    expect(commandLine(extractReplyText(raw))).toBe('hecho 2');
  });

  it('decodes a legacy charset', () => {
    const raw = Buffer.concat([
      Buffer.from('Content-Type: text/plain; charset=iso-8859-1\r\n\r\n', 'latin1'),
      Buffer.from([0x70, 0x6f, 0x73, 0x70, 0xf3, 0x6e]), // "pospón" in latin1
    ]);
    expect(parseReplyCommand(commandLine(extractReplyText(raw)))).toEqual({
      kind: 'snooze',
      tasks: null,
      days: DEFAULT_SNOOZE_DAYS,
    });
  });

  it('falls back to HTML and stops at the quoted original (Gmail)', () => {
    const raw = mime([
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><head><style>p{}</style><title>done 4</title></head><body>',
      '<div dir="ltr">done&nbsp;1</div><br>',
      '<div class="gmail_quote"><div class="gmail_attr">On Tue wrote:</div>',
      '<blockquote>done 2</blockquote></div></body></html>',
    ]);
    expect(commandLine(extractReplyText(raw))).toBe('done 1');
  });

  it('returns null for a message with no text part', () => {
    const raw = mime([
      'Content-Type: multipart/mixed; boundary=x',
      '',
      '--x',
      'Content-Type: image/jpeg',
      'Content-Transfer-Encoding: base64',
      '',
      '/9j/4AAQ',
      '--x--',
    ]);
    expect(extractReplyText(raw)).toBeNull();
  });

  it('survives a truncated message (the Lambda reads only the first MiB)', () => {
    const raw = mime([
      'Content-Type: multipart/alternative; boundary=b',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'done',
      '--b',
      'Content-Type: text/html',
      '',
      '<div>tru',
    ]);
    expect(commandLine(extractReplyText(raw))).toBe('done');
  });
});

describe('htmlToText', () => {
  it('stops at an Outlook reply marker and at Apple Mail blockquotes', () => {
    expect(htmlToText('<p>done 2</p><div id="appendonsend"></div><p>done 1</p>').trim()).toBe(
      'done 2'
    );
    expect(htmlToText('<blockquote type="cite">done 1</blockquote>').trim()).toBe('');
  });

  it('drops script and style content rather than reading it', () => {
    expect(htmlToText('<script>done 1</script><style>x</style>snooze').trim()).toBe('snooze');
  });

  it('stops at an unterminated tag', () => {
    expect(htmlToText('done<div class="x" ').trim()).toBe('done');
  });
});

describe('senderAddress', () => {
  it.each([
    ['sam@example.com', 'sam@example.com'],
    ['Sam <Sam@Example.com>', 'sam@example.com'],
    ['"Doe, Sam" <sam@example.com>', 'sam@example.com'],
    ['=?UTF-8?B?U8OhbQ==?= <sam@example.com>', 'sam@example.com'],
    ['sam@example.com (Sam)', 'sam@example.com'],
  ])('reads %j', (from, expected) => {
    expect(senderAddress([from])).toBe(expected);
  });

  it.each([
    ['two From headers', ['a@b.test', 'c@d.test']],
    ['no From header', []],
    ['two mailboxes', ['a@b.test, c@d.test']],
    ['a group', ['team: a@b.test;']],
    ['two angle addresses', ['<a@b.test> <c@d.test>']],
    ['a bare LF (the #617 shape)', ['"Ev\nBcc: victim@example.com" <ev@bad.test>']],
    ['a CR', ['ev@bad.test\rBcc: victim@example.com']],
    ['not an address', ['Sam']],
  ])('rejects %s', (_label, from) => {
    expect(senderAddress(from)).toBeNull();
  });

  it('rejects an absent header list', () => {
    expect(senderAddress(undefined)).toBeNull();
  });
});

describe('safeMessageId', () => {
  it('keeps an ordinary Message-ID and brackets a bare one', () => {
    expect(safeMessageId('<CAB123@mail.gmail.com>')).toBe('<CAB123@mail.gmail.com>');
    expect(safeMessageId('CAB123@mail.gmail.com')).toBe('<CAB123@mail.gmail.com>');
  });

  it.each([
    '<a@b>\r\nBcc: victim@example.com',
    '<a@b>\nBcc: victim@example.com',
    '<a b@c>',
    '<a<b@c>',
    `<${'x'.repeat(260)}@c>`,
    '<ümlaut@c>',
    '',
  ])('refuses %j', (value) => {
    expect(safeMessageId(value)).toBeNull();
  });

  it('refuses a non-string', () => {
    expect(safeMessageId(undefined)).toBeNull();
    expect(safeMessageId(42)).toBeNull();
  });
});
