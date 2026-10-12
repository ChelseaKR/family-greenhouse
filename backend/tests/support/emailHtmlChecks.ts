/**
 * Static checks for a rendered email, used by the rendering tests.
 *
 * Email HTML has no validator worth a dependency, and the rules that matter
 * for mail are not the ones an HTML5 validator checks anyway. These are the
 * rules `services/email/template.ts` promises (its header comment) and that
 * a client would punish silently if broken: a remote stylesheet is simply
 * not loaded, an image without alt text is a blank box, a script is
 * stripped, an oversized body is clipped by Gmail at 102 kB. Each returns a
 * named problem rather than a boolean, so a failing test says what broke.
 *
 * `tests/unit/services/email/emailHtmlChecks.test.ts` is the negative
 * control: it feeds each rule a document that breaks it and asserts the
 * problem is reported. Without that, a checker that silently passed
 * everything would read as a green test over nothing.
 */

export interface EmailHtmlCheckOptions {
  /** The origin every link and the logo must sit on, e.g. `https://familygreenhouse.net`. */
  origin: string;
  /** Any other origins links may use (the API origin for unsubscribe URLs). */
  allowedOrigins?: string[];
  /** The plain-text part, when the message has one: every link in the HTML
   *  must also be in the text, so a text-only client loses nothing. */
  text?: string;
  /** Gmail clips a message above ~102 kB; the product's own cap is lower. */
  maxBytes?: number;
}

export const EMAIL_MAX_BYTES = 100 * 1024;

/** Elements that never close and never appear in the stack. */
const VOID_TAGS = new Set(['img', 'br', 'hr', 'meta', 'link', 'input']);

/**
 * Every problem found, in document order where that makes sense. An empty
 * array is a pass.
 */
export function checkEmailHtml(html: string, options: EmailHtmlCheckOptions): string[] {
  const problems: string[] = [];
  const bytes = Buffer.byteLength(html, 'utf8');
  const max = options.maxBytes ?? EMAIL_MAX_BYTES;
  if (bytes > max) problems.push(`size: ${bytes} bytes is over the ${max}-byte cap`);

  if (!/^<!DOCTYPE html>/iu.test(html.trimStart())) problems.push('doctype: missing');
  if (!/<html[^>]*\slang="[a-z]{2}(?:-[A-Za-z]{2})?"/u.test(html)) {
    problems.push('html: no lang attribute');
  }
  if (!/<meta charset="utf-8"\s*\/?>/iu.test(html)) problems.push('head: no utf-8 charset');
  if (!/<meta name="color-scheme" content="light dark"\s*\/?>/iu.test(html)) {
    problems.push('head: no color-scheme meta');
  }
  if (!/@media \(prefers-color-scheme: dark\)/u.test(html)) {
    problems.push('style: no dark-mode rules');
  }
  if (!/<title>[^<]+<\/title>/u.test(html)) problems.push('head: no title');

  // Nothing executable, nothing fetched but the logo.
  if (/<script\b/iu.test(html)) problems.push('script: element present');
  if (/<link\b/iu.test(html)) problems.push('link: element present (remote stylesheet?)');
  if (/<iframe\b|<object\b|<embed\b|<form\b|<input\b|<video\b|<audio\b/iu.test(html)) {
    problems.push('element: iframe/object/embed/form/input/video/audio present');
  }
  if (/\son[a-z]+\s*=/iu.test(html)) problems.push('attribute: inline event handler');
  if (/@import\b/iu.test(html)) problems.push('style: @import present');
  if (/url\s*\(/iu.test(html)) problems.push('style: url() present (background image or font)');
  if (/@font-face\b/iu.test(html)) problems.push('style: @font-face present (web font)');
  if (/javascript:/iu.test(html)) problems.push('href: javascript: URL');
  if (/display\s*:\s*(flex|grid)/iu.test(html)) problems.push('style: flex/grid layout');

  // Images: exactly the logo, with alt text and dimensions, on our origin.
  const images = [...html.matchAll(/<img\b[^>]*>/giu)].map((m) => m[0]);
  if (images.length !== 1)
    problems.push(`img: expected exactly 1 image (the logo), found ${images.length}`);
  for (const img of images) {
    const src = /\ssrc="([^"]*)"/u.exec(img)?.[1];
    const alt = /\salt="([^"]*)"/u.exec(img)?.[1];
    const width = /\swidth="(\d+)"/u.exec(img)?.[1];
    const height = /\sheight="(\d+)"/u.exec(img)?.[1];
    if (!src) problems.push('img: no src');
    else if (!src.startsWith(`${options.origin}/`)) problems.push(`img: src off-origin: ${src}`);
    else if (src.includes('?')) problems.push(`img: src carries a query string: ${src}`);
    if (!alt || alt.trim() === '') problems.push('img: missing or empty alt text');
    if (!width || !height) problems.push('img: missing width/height');
  }

  // Links: http(s) only, on a known origin, and every one present in the text.
  const allowed = [options.origin, ...(options.allowedOrigins ?? [])];
  const hrefs = [...html.matchAll(/\shref="([^"]*)"/giu)].map((m) => m[1]);
  if (hrefs.length === 0) problems.push('a: no links at all');
  for (const href of hrefs) {
    const unescaped = href.replace(/&amp;/g, '&');
    let parsed: URL | null = null;
    try {
      parsed = new URL(unescaped);
    } catch {
      parsed = null;
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      problems.push(`a: not an absolute http(s) link: ${href}`);
      continue;
    }
    if (!allowed.some((o) => unescaped === o || unescaped.startsWith(`${o}/`))) {
      problems.push(`a: off-origin link: ${href}`);
    }
    if (typeof options.text === 'string' && !options.text.includes(unescaped)) {
      problems.push(`a: link missing from the text part: ${unescaped}`);
    }
  }
  if (typeof options.text === 'string') {
    for (const m of options.text.matchAll(/https?:\/\/\S+/gu)) {
      const url = m[0].replace(/[).,;]+$/u, '');
      if (!html.includes(url.replace(/&/g, '&amp;'))) {
        problems.push(`text: link missing from the html part: ${url}`);
      }
    }
  }

  // Structure: every opening tag closed, in order; attributes quoted.
  problems.push(...checkBalance(html));
  for (const m of html.matchAll(/<[a-z][a-z0-9]*\b([^>]*)>/giu)) {
    const attrs = m[1];
    if (/\s[a-z-]+=(?!")/iu.test(attrs))
      problems.push(`attribute: unquoted value in <${m[0].slice(1, 40)}…>`);
  }
  for (const td of html.matchAll(/<td\b[^>]*>/giu)) {
    if (/\sstyle="/u.test(td[0]) && /\sstyle="[^"]*"[^>]*\sstyle="/u.test(td[0])) {
      problems.push('td: duplicate style attribute');
    }
  }
  return problems;
}

/** Tag balance over the elements the template uses. */
function checkBalance(html: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  const body = html.replace(/<!DOCTYPE[^>]*>/iu, '').replace(/<style>[\s\S]*?<\/style>/giu, '');
  for (const m of body.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>/giu)) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosed = m[3] === '/';
    if (VOID_TAGS.has(name) || selfClosed) continue;
    if (!closing) {
      stack.push(name);
      continue;
    }
    const open = stack.pop();
    if (open !== name) {
      problems.push(`structure: </${name}> closes <${open ?? 'nothing'}>`);
      return problems;
    }
  }
  if (stack.length > 0) problems.push(`structure: unclosed <${stack[stack.length - 1]}>`);
  return problems;
}

/**
 * The private-notes rule for every email builder (docs/notifications.md):
 * nothing a household typed into a plant's notes, care rule or placement
 * note may reach an email. Returns the sentinels that leaked, in any of the
 * message's parts; an empty array is a pass.
 */
export function leakedSentinels(
  message: { subject?: string; text?: string; html?: string },
  sentinels: readonly string[]
): string[] {
  const haystack = `${message.subject ?? ''}\n${message.text ?? ''}\n${message.html ?? ''}`;
  return sentinels.filter((s) => haystack.includes(s));
}
