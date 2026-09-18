/**
 * Everything the inbound reply path reads out of a message, as pure functions
 * over attacker-controlled input (#667, ADR 0031).
 *
 * Nothing in an inbound email is trusted: not the body, not the From header,
 * not the Message-ID, not the MIME structure. This module turns that input
 * into exactly three things and nothing else:
 *
 *   1. `extractReplyText` — the text the person typed, as a string, from the
 *      first `text/plain` part (or, failing that, the first `text/html` part
 *      reduced to text). Attachments are never decoded.
 *   2. `commandLine` + `parseReplyCommand` — ONE line, the first non-empty one
 *      above the quoted reminder, matched against a closed grammar. There is
 *      no fuzzy matching and no natural-language step: a line that is not
 *      exactly a command is `unrecognized`, and the caller does nothing.
 *   3. `senderAddress` / `safeMessageId` — the one mailbox in From (or null),
 *      and a Message-ID only if it is plain printable ASCII in angle brackets,
 *      so the one inbound value that is ever echoed into an outbound header
 *      (In-Reply-To, for threading) cannot carry a line break or a second
 *      header (the #617 class).
 *
 * ## The grammar
 *
 *     complete := DONE [TASKS]
 *     snooze   := SNOOZE [TASKS] [DURATION]
 *     TASKS    := N ( ("," | "&" | "and" | "y" | " ") N )*      N in 1..99
 *     DURATION := [ "for" | "por" | "durante" ] D UNIT          D in 1..365 days
 *     UNIT     := d | day | days | día | días | w | week | weeks | semana | semanas
 *
 * DONE and SNOOZE are small closed word lists in English and Spanish (below).
 * Case, accents, surrounding quotes and trailing punctuation are ignored, so
 * `"Done!"`, `«Hecho 2»` and `posponer 2 por 3 días` all parse.
 *
 * Numbers name tasks by the number the reminder printed next to them; a
 * duration always carries a unit. The one shape that could mean either — a
 * single bare number after SNOOZE (`snooze 2`: task 2, or two days?) — is
 * `unrecognized` rather than resolved by a guess.
 */

export type ReplyCommand =
  | { kind: 'complete'; tasks: number[] | null }
  | { kind: 'snooze'; tasks: number[] | null; days: number }
  | { kind: 'unrecognized' };

/** A bare `snooze` pushes by one day — the first of the app's snooze choices. */
export const DEFAULT_SNOOZE_DAYS = 1;
/** Same ceiling the app's own snooze endpoint accepts (`snoozeTaskSchema`). */
export const MAX_SNOOZE_DAYS = 365;
const MAX_TASK_NUMBER = 99;

const COMPLETE_WORDS = new Set([
  'done',
  'complete',
  'completed',
  'hecho',
  'hecha',
  'listo',
  'lista',
  'completado',
  'completada',
]);

const SNOOZE_WORDS = new Set(['snooze', 'postpone', 'posponer', 'pospon', 'aplazar']);

/** Only this much of the message is looked at for the command at all. */
const MAX_TEXT_CHARS = 4000;
const MAX_SCANNED_LINES = 40;
/** A command is a few words. A longer first line is simply not one. */
const MAX_COMMAND_CHARS = 60;
const MAX_LINE_CHARS = 300;
const MAX_HTML_CHARS = 200_000;
const MAX_MIME_DEPTH = 5;
const MAX_MIME_PARTS = 50;

// ---------------------------------------------------------------------------
// MIME → text
// ---------------------------------------------------------------------------

interface Entity {
  headers: Map<string, string>;
  body: Buffer;
}

function splitEntity(raw: Buffer): Entity {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');
  let at = crlf;
  let sepLen = 4;
  if (at === -1 || (lf !== -1 && lf < at)) {
    at = lf;
    sepLen = 2;
  }
  const headerBytes = at === -1 ? raw : raw.subarray(0, at);
  const body = at === -1 ? Buffer.alloc(0) : raw.subarray(at + sepLen);

  const headers = new Map<string, string>();
  // latin1 is a lossless byte<->char mapping; header names are ASCII.
  const lines = headerBytes.toString('latin1').split(/\r?\n/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function parseContentType(value: string | undefined): {
  type: string;
  params: Record<string, string>;
} {
  if (!value) return { type: 'text/plain', params: {} };
  const semi = value.indexOf(';');
  const type = (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
  const params: Record<string, string> = {};
  if (semi !== -1) {
    const pattern = /;\s*([a-z0-9_*-]+)\s*=\s*(?:"([^"]*)"|([^;\s]*))/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value.slice(semi))) !== null) {
      params[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
    }
  }
  return { type: type || 'text/plain', params };
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('latin1');
  const marker = `--${boundary}`;
  const starts: number[] = [];
  let from = 0;
  while (starts.length <= MAX_MIME_PARTS) {
    const at = text.indexOf(marker, from);
    if (at === -1) break;
    if (at === 0 || text[at - 1] === '\n') starts.push(at);
    from = at + marker.length;
  }
  const parts: Buffer[] = [];
  for (let k = 0; k < starts.length; k += 1) {
    const afterMarker = starts[k] + marker.length;
    if (text.startsWith('--', afterMarker)) break; // closing delimiter
    const eol = text.indexOf('\n', afterMarker);
    if (eol === -1) break;
    const end = k + 1 < starts.length ? starts[k + 1] : text.length;
    parts.push(Buffer.from(text.slice(eol + 1, end).replace(/\r?\n$/, ''), 'latin1'));
  }
  return parts;
}

function decodeQuotedPrintable(value: string): Buffer {
  const joined = value.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeTransfer(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable':
      return decodeQuotedPrintable(body.toString('latin1'));
    default:
      return body;
  }
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase() || 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    // An unknown charset label. UTF-8 with replacement characters is the
    // honest reading: anything it cannot decode becomes U+FFFD, which no
    // command word contains, so a mis-decoded body can only fail to parse.
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(bytes);
}

interface FoundText {
  plain: string | null;
  html: string | null;
}

function findText(raw: Buffer, depth: number, budget: { parts: number }): FoundText {
  const entity = splitEntity(raw);
  const disposition = (entity.headers.get('content-disposition') ?? '').toLowerCase();
  if (disposition.startsWith('attachment')) return { plain: null, html: null };

  const contentType = parseContentType(entity.headers.get('content-type'));
  if (contentType.type.startsWith('multipart/')) {
    const boundary = contentType.params.boundary;
    if (depth >= MAX_MIME_DEPTH || !boundary) return { plain: null, html: null };
    let html: string | null = null;
    for (const part of splitMultipart(entity.body, boundary)) {
      budget.parts += 1;
      if (budget.parts > MAX_MIME_PARTS) break;
      const found = findText(part, depth + 1, budget);
      if (found.plain !== null) return { plain: found.plain, html: null };
      html ??= found.html;
    }
    return { plain: null, html };
  }

  if (contentType.type !== 'text/plain' && contentType.type !== 'text/html') {
    return { plain: null, html: null };
  }
  const decoded = decodeCharset(
    decodeTransfer(entity.body, entity.headers.get('content-transfer-encoding')),
    contentType.params.charset
  );
  return contentType.type === 'text/plain'
    ? { plain: decoded, html: null }
    : { plain: null, html: decoded };
}

const HTML_SKIP_CONTENT = new Set(['head', 'style', 'script', 'title']);
const HTML_LINE_BREAKS = new Set([
  'br',
  'p',
  'div',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
/** Where a client starts the quoted original: Apple Mail / Thunderbird
 *  `<blockquote>`, Gmail `gmail_quote`, Outlook `appendonsend` /
 *  `divRplyFwdMsg`, Yahoo `yahoo_quoted`, Thunderbird `moz-cite-prefix`. */
const HTML_QUOTE_START =
  /^blockquote\b|\bclass\s*=\s*["']?[^"'>]*\b(?:gmail_quote|gmail_attr|yahoo_quoted|moz-cite-prefix)|\bid\s*=\s*["']?(?:appendonsend|divrplyfwdmsg)/;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith('#')) return safeCodePoint(Number.parseInt(lower.slice(1), 10), whole);
    const named: Record<string, string> = {
      nbsp: ' ',
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      laquo: '«',
      raquo: '»',
      ldquo: '“',
      rdquo: '”',
    };
    return named[lower] ?? whole;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : fallback;
}

/**
 * Reduce an HTML body to the text ABOVE the quoted original. A small scanner,
 * not a parser and not a regex tag-stripper: it walks `<…>` spans, drops the
 * contents of head/style/script/title, turns block ends into newlines, and
 * stops at the first marker of quoted content or at an unterminated tag.
 * The output is only ever matched against the command grammar; it is never
 * rendered or stored.
 */
export function htmlToText(html: string): string {
  const src = html.slice(0, MAX_HTML_CHARS);
  const lower = src.toLowerCase();
  let out = '';
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, lt);
    const gt = src.indexOf('>', lt);
    if (gt === -1) break;
    const tag = lower.slice(lt + 1, gt).trim();
    if (HTML_QUOTE_START.test(tag)) break;
    const name = /^\/?([a-z0-9]+)/.exec(tag)?.[1] ?? '';
    if (!tag.startsWith('/') && HTML_SKIP_CONTENT.has(name)) {
      const close = lower.indexOf(`</${name}`, gt);
      if (close === -1) break;
      const closeEnd = lower.indexOf('>', close);
      if (closeEnd === -1) break;
      i = closeEnd + 1;
      continue;
    }
    if (HTML_LINE_BREAKS.has(name)) out += '\n';
    i = gt + 1;
  }
  return decodeEntities(out);
}

/**
 * The typed text of a raw RFC 5322 message: the first `text/plain` part, or
 * the first `text/html` part reduced by `htmlToText`, or null when the
 * message has neither (an attachment-only message, a calendar invite).
 */
export function extractReplyText(raw: Buffer): string | null {
  const found = findText(raw, 0, { parts: 0 });
  if (found.plain !== null) return found.plain;
  if (found.html !== null) return htmlToText(found.html);
  return null;
}

// ---------------------------------------------------------------------------
// Text → the one command line
// ---------------------------------------------------------------------------

/** Lines at which the reply ends and the quoted original (or a signature)
 *  begins. Tested against a trimmed line of at most MAX_LINE_CHARS. */
const QUOTE_MARKERS: readonly RegExp[] = [
  /^>/,
  /^(?:on|el)\s[^\n]*(?:wrote|escribi[oó]):?$/i,
  /^-{2,}\s*(?:original message|mensaje original|forwarded message|mensaje reenviado)\s*-{2,}$/i,
  /^_{8,}$/,
  /^--$/,
  /^(?:from|de|sent|enviado|to|para|subject|asunto):\s/i,
  /^(?:sent from|enviado desde)\s/i,
];

/**
 * The first non-empty line above the quoted original, or null when the reply
 * has none (an empty reply that only quotes the reminder). Only this line is
 * ever interpreted; everything under it — the rest of the message, the
 * quoted reminder with its own numbered list — is ignored.
 */
export function commandLine(text: string | null): string | null {
  if (!text) return null;
  const lines = text
    .slice(0, MAX_TEXT_CHARS)
    .split(/\r\n|\r|\n/)
    .slice(0, MAX_SCANNED_LINES);
  for (const raw of lines) {
    const line = raw.replace(/[\u00a0\u200b-\u200d\u2060\ufeff]/g, ' ').trim();
    if (!line) continue;
    if (line.length > MAX_LINE_CHARS) return line;
    if (QUOTE_MARKERS.some((marker) => marker.test(line))) return null;
    return line;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line → command
// ---------------------------------------------------------------------------

function normalizeLine(line: string): string {
  return line
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/["'“”‘’«»]/g, ' ')
    .replace(/[.!?¡¿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DURATION =
  /(?:^|\s)(?:(?:for|por|durante)\s+)?(\d{1,3})\s*(d|days?|dias?|w|wks?|weeks?|semanas?)$/;

/** `null` = no tasks named; `'invalid'` = something that is not a task list. */
function parseTaskList(rest: string): number[] | null | 'invalid' {
  const trimmed = rest.replace(/^(?:tasks?|tareas?)\s+/, '').trim();
  if (!trimmed) return null;
  const tokens = trimmed
    .replace(/[#,&]/g, ' ')
    .split(' ')
    .filter((token) => token.length > 0 && token !== 'and' && token !== 'y');
  if (tokens.length === 0) return 'invalid';
  const numbers = new Set<number>();
  for (const token of tokens) {
    if (!/^\d{1,2}$/.test(token)) return 'invalid';
    const n = Number(token);
    if (n < 1 || n > MAX_TASK_NUMBER) return 'invalid';
    numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

export function parseReplyCommand(line: string | null): ReplyCommand {
  if (!line || line.length > MAX_COMMAND_CHARS) return { kind: 'unrecognized' };
  const normalized = normalizeLine(line);
  const match = /^([a-z]+)(?:\s+(.*))?$/.exec(normalized);
  if (!match) return { kind: 'unrecognized' };
  const [, verb, restRaw = ''] = match;
  const rest = restRaw.trim();

  if (COMPLETE_WORDS.has(verb)) {
    const tasks = parseTaskList(rest);
    return tasks === 'invalid' ? { kind: 'unrecognized' } : { kind: 'complete', tasks };
  }

  if (SNOOZE_WORDS.has(verb)) {
    let days = DEFAULT_SNOOZE_DAYS;
    let taskPart = rest;
    const duration = DURATION.exec(rest);
    if (duration) {
      const unit = duration[2];
      const multiplier = unit.startsWith('w') || unit.startsWith('semana') ? 7 : 1;
      days = Number(duration[1]) * multiplier;
      taskPart = rest.slice(0, duration.index).trim();
    }
    if (!Number.isInteger(days) || days < 1 || days > MAX_SNOOZE_DAYS) {
      return { kind: 'unrecognized' };
    }
    const tasks = parseTaskList(taskPart);
    if (tasks === 'invalid') return { kind: 'unrecognized' };
    // `snooze 2`: task 2 for a day, or everything for two days? Not guessed.
    if (!duration && tasks !== null && tasks.length === 1 && /^\d{1,2}$/.test(taskPart)) {
      return { kind: 'unrecognized' };
    }
    return { kind: 'snooze', tasks, days };
  }

  return { kind: 'unrecognized' };
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const ADDRESS =
  /^[a-z0-9!#$%&*+/=?^_`{|}~.-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The single mailbox in the From header, lower-cased, or null.
 *
 * Null for anything that is not exactly one plain address: no From, two From
 * headers, a From listing two mailboxes, a group, a value with a line break
 * in it, or an address that does not look like one. The caller compares the
 * result to the member's stored address and does nothing on a mismatch, so a
 * null here can only ever mean "no action".
 */
export function senderAddress(fromHeaders: readonly string[] | undefined): string | null {
  if (!fromHeaders || fromHeaders.length !== 1) return null;
  const value = fromHeaders[0];
  if (typeof value !== 'string' || value.length > 512 || /[\r\n]/.test(value)) return null;
  const stripped = value.replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/\([^()]*\)/g, ' ');
  if (/[,;:]/.test(stripped.replace(/<[^<>]*>/g, ''))) return null;
  const bracketed = stripped.match(/<[^<>]*>/g);
  let address: string;
  if (bracketed) {
    if (bracketed.length !== 1) return null;
    address = bracketed[0].slice(1, -1).trim();
  } else {
    address = stripped.trim();
  }
  address = address.toLowerCase();
  return ADDRESS.test(address) ? address : null;
}

/**
 * A Message-ID fit to be echoed into `In-Reply-To` / `References`, or null.
 * Printable ASCII only, no spaces, no angle brackets inside, bounded length:
 * nothing that could end a header line or begin another one.
 */
export function safeMessageId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const bracketed = trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
  return /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/.test(bracketed) ? bracketed : null;
}
