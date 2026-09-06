/**
 * Hand-rolled HTML + plain-text email renderer. See ADR 0021.
 *
 * ## Why hand-rolled
 *
 * No template dependency. Email HTML is not web HTML — it is a 1999 subset
 * that every library re-learns badly — and the surface we need is four
 * blocks wide. Forty lines of table markup we control beats a transitive
 * dependency in a Lambda that sends a household's weekly mail.
 *
 * ## The compatibility rules this file obeys
 *
 *   - **Tables, not flex/grid.** Outlook's Word rendering engine supports
 *     neither. Every layout row is a `<table role="presentation">`.
 *   - **Inline styles.** Gmail strips `<style>` in some contexts (clipped
 *     messages, forwarded mail), so every declaration that MATTERS is inline
 *     on the element. The `<style>` block carries only progressive
 *     enhancement: the dark-mode swap and the narrow-screen overrides, both
 *     of which are media queries and therefore inline-impossible.
 *   - **No external CSS and no web fonts.** A font that must be fetched is a
 *     remote load; the stack is system fonts only.
 *   - **No remote images.** The only `<img>` we emit is a plant photo from
 *     our own asset origin, checked by `isOwnAssetUrl`. Anything else is
 *     dropped rather than fetched (ADR 0021).
 *   - **600px cap, fluid below it.** `width="600"` for Outlook (which ignores
 *     `max-width`) plus `max-width:100%` and a `<620px` media query for
 *     phones.
 *   - **A preheader.** The hidden first line an inbox list shows next to the
 *     subject. Without one, clients scrape the first visible text — which is
 *     usually the greeting, wasting the most-read 40 characters in email.
 *
 * ## Dark mode
 *
 * Every colour is stated explicitly on both the light path (inline) and the
 * dark path (`prefers-color-scheme` in the `<style>` block). Nothing relies
 * on a client default, because the two clients that force-invert (Outlook
 * mobile, Gmail on Android) invert *unstated* colours only. The palette is
 * chosen so the accent green carries white text at AA in both modes, which
 * is why the button needs no dark variant.
 *
 * ## Escaping
 *
 * `escapeHtml` runs over EVERY interpolated value with no exceptions and no
 * "trusted" escape hatch. Plant names, notes, member names and space names
 * are all user-supplied, and a household email is exactly the place a
 * `<script>`-shaped plant name must not survive. There is no API in this
 * module that accepts raw HTML.
 */
import type { EmailLocale } from './catalog.js';
import { isOwnAssetUrl, safeLinkUrl } from './links.js';

/** A block of email body content. Deliberately small: a heading, prose, a
 *  linked row, a button, an honest "could not load" notice, a rule. */
export type EmailBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; tone?: 'normal' | 'muted' }
  | { kind: 'notice'; text: string }
  | {
      kind: 'row';
      title: string;
      href?: string | null;
      /** Supporting lines under the title, most important first. */
      lines: string[];
      /** Plant photo. Dropped unless it is on our own asset origin. */
      imageUrl?: string | null;
      /** Short label rendered before the title, e.g. "Up for grabs". */
      badge?: string | null;
    }
  | { kind: 'button'; label: string; href: string }
  | { kind: 'divider' };

export interface EmailFooterLink {
  label: string;
  href: string;
}

export interface EmailFooter {
  /** Why this person is receiving this message. */
  reason: string;
  /** The standing anti-phishing line. See ADR 0021. */
  safety: string;
  links: EmailFooterLink[];
}

export interface EmailDocument {
  locale: EmailLocale;
  /** `<title>` and the H1 at the top of the card. */
  title: string;
  /** Inbox preview line. Never repeat the subject here. */
  preheader: string;
  blocks: EmailBlock[];
  footer: EmailFooter;
}

// --- palette ----------------------------------------------------------------
// Light values are inlined; the dark twins live in the <style> block below.
const LIGHT = {
  page: '#f2f5f2',
  card: '#ffffff',
  text: '#1d2b23',
  muted: '#5b6b61',
  border: '#dfe7e1',
  accent: '#2f6b4f',
  onAccent: '#ffffff',
  noticeBg: '#fdf4e6',
  noticeText: '#7a4a12',
  noticeBorder: '#f0d9b5',
} as const;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const STYLE_BLOCK = `
  @media (prefers-color-scheme: dark) {
    .fg-page { background-color: #12171a !important; }
    .fg-card { background-color: #1b2226 !important; }
    .fg-text { color: #e9efea !important; }
    .fg-text a { color: #8ed3ae !important; }
    .fg-muted { color: #a5b5ab !important; }
    .fg-rule { border-color: #2b3438 !important; }
    .fg-notice {
      background-color: #382b14 !important;
      color: #f3d5a4 !important;
      border-color: #5b431e !important;
    }
  }
  @media only screen and (max-width: 620px) {
    .fg-card { width: 100% !important; }
    .fg-pad { padding-left: 18px !important; padding-right: 18px !important; }
    .fg-thumb { display: none !important; }
  }
`.trim();

/**
 * HTML-escape a user-supplied string. Covers the five characters that can
 * change parsing in element content OR in a double- or single-quoted
 * attribute, so one function is correct in both positions and there is no
 * second "attribute-safe" variant for a caller to reach for by mistake.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function td(style: string, content: string, cls = ''): string {
  const classAttr = cls ? ` class="${cls}"` : '';
  return `<td${classAttr} style="${style}">${content}</td>`;
}

function paragraph(text: string, tone: 'normal' | 'muted'): string {
  const color = tone === 'muted' ? LIGHT.muted : LIGHT.text;
  const cls = tone === 'muted' ? 'fg-muted' : 'fg-text';
  return `<tr>${td(
    `padding:0 32px 14px;font-family:${FONT};font-size:15px;line-height:23px;color:${color};`,
    escapeHtml(text),
    `fg-pad ${cls}`
  )}</tr>`;
}

function heading(text: string): string {
  return `<tr>${td(
    `padding:8px 32px 10px;font-family:${FONT};font-size:13px;line-height:18px;` +
      `letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:${LIGHT.muted};`,
    escapeHtml(text),
    'fg-pad fg-muted'
  )}</tr>`;
}

function notice(text: string): string {
  const inner =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr>${td(
      `padding:12px 14px;border:1px solid ${LIGHT.noticeBorder};border-radius:8px;` +
        `background-color:${LIGHT.noticeBg};font-family:${FONT};font-size:14px;` +
        `line-height:21px;color:${LIGHT.noticeText};`,
      escapeHtml(text),
      'fg-notice'
    )}</tr></table>`;
  return `<tr>${td('padding:0 32px 14px;', inner, 'fg-pad')}</tr>`;
}

function divider(): string {
  return `<tr>${td(
    'padding:6px 32px 18px;',
    `<hr class="fg-rule" style="border:0;border-top:1px solid ${LIGHT.border};margin:0;" />`,
    'fg-pad'
  )}</tr>`;
}

function button(label: string, href: string): string {
  const safe = safeLinkUrl(href);
  if (!safe) return '';
  const anchor =
    `<a href="${escapeHtml(safe)}" style="display:inline-block;padding:13px 26px;` +
    `font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;` +
    `color:${LIGHT.onAccent};text-decoration:none;border-radius:8px;` +
    `background-color:${LIGHT.accent};">${escapeHtml(label)}</a>`;
  const wrapper =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0">` +
    `<tr><td bgcolor="${LIGHT.accent}" style="border-radius:8px;">${anchor}</td></tr></table>`;
  return `<tr>${td('padding:4px 32px 22px;', wrapper, 'fg-pad')}</tr>`;
}

function row(block: Extract<EmailBlock, { kind: 'row' }>): string {
  const safe = safeLinkUrl(block.href);
  const titleText = escapeHtml(block.title);
  const title = safe
    ? `<a href="${escapeHtml(safe)}" style="color:${LIGHT.accent};text-decoration:none;` +
      `font-weight:600;">${titleText}</a>`
    : `<span style="font-weight:600;">${titleText}</span>`;

  const badge = block.badge
    ? `<div class="fg-muted" style="font-family:${FONT};font-size:11px;line-height:16px;` +
      `letter-spacing:0.06em;text-transform:uppercase;font-weight:700;color:${LIGHT.muted};` +
      `padding-bottom:2px;">${escapeHtml(block.badge)}</div>`
    : '';

  const lines = block.lines
    .map(
      (line) =>
        `<div class="fg-muted" style="font-family:${FONT};font-size:14px;line-height:21px;` +
        `color:${LIGHT.muted};padding-top:2px;">${escapeHtml(line)}</div>`
    )
    .join('');

  const body =
    `${badge}<div class="fg-text" style="font-family:${FONT};font-size:16px;` +
    `line-height:23px;color:${LIGHT.text};">${title}</div>${lines}`;

  // Photo is opt-in AND origin-checked: an image we do not serve is dropped,
  // never fetched (ADR 0021). `alt` stays empty because the plant name is
  // already the row's title — a duplicate alt reads twice in a screen reader.
  const thumb = isOwnAssetUrl(block.imageUrl)
    ? `<td class="fg-thumb" width="64" valign="top" style="padding-right:14px;">` +
      `<img src="${escapeHtml(block.imageUrl as string)}" width="64" height="64" alt="" ` +
      `style="display:block;width:64px;height:64px;border-radius:8px;` +
      `object-fit:cover;border:0;" /></td>`
    : '';

  const inner =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr>${thumb}<td valign="top">${body}</td></tr></table>`;

  return `<tr>${td('padding:0 32px 16px;', inner, 'fg-pad')}</tr>`;
}

function renderBlockHtml(block: EmailBlock): string {
  switch (block.kind) {
    case 'heading':
      return heading(block.text);
    case 'text':
      return paragraph(block.text, block.tone ?? 'normal');
    case 'notice':
      return notice(block.text);
    case 'row':
      return row(block);
    case 'button':
      return button(block.label, block.href);
    case 'divider':
      return divider();
  }
}

function renderBlockText(block: EmailBlock): string[] {
  switch (block.kind) {
    case 'heading':
      return [block.text.toUpperCase(), '-'.repeat(Math.min(block.text.length, 60)), ''];
    case 'text':
      return [block.text, ''];
    case 'notice':
      // The marker keeps the honest-failure line visibly distinct in the text
      // part, where there is no amber box to carry the meaning.
      return [`! ${block.text}`, ''];
    case 'row': {
      const out = [`${block.badge ? `[${block.badge}] ` : ''}${block.title}`];
      for (const line of block.lines) out.push(`    ${line}`);
      const safe = safeLinkUrl(block.href);
      if (safe) out.push(`    ${safe}`);
      out.push('');
      return out;
    }
    case 'button': {
      const safe = safeLinkUrl(block.href);
      return safe ? [`${block.label}: ${safe}`, ''] : [];
    }
    case 'divider':
      return ['--', ''];
  }
}

/**
 * Preheader padding. Clients pull preview text until they run out of
 * characters, so without trailing filler the greeting bleeds into the
 * preview. Zero-width joiners + non-breaking spaces are the standard,
 * client-safe filler; they render as nothing.
 */
const PREHEADER_FILLER = '&#847;&zwnj;&nbsp;'.repeat(60);

/**
 * Render one document into both parts.
 *
 * The text part is not a stripped-down afterthought: it is generated from the
 * same block list with its own layout rules (underlined headings, indented
 * supporting lines, the URL on its own line under each row) so that a client
 * that shows only `text/plain` — or a person who prefers it — gets a
 * genuinely readable email rather than HTML with the tags removed.
 */
export function renderEmail(doc: EmailDocument): { html: string; text: string } {
  const bodyRows = doc.blocks.map(renderBlockHtml).join('');

  const footerLinks = doc.footer.links
    .map((link) => {
      const safe = safeLinkUrl(link.href);
      return safe
        ? `<a href="${escapeHtml(safe)}" style="color:${LIGHT.muted};text-decoration:underline;">` +
            `${escapeHtml(link.label)}</a>`
        : escapeHtml(link.label);
    })
    .join(' &nbsp;·&nbsp; ');

  const footer = `<tr>${td(
    `padding:20px 32px 28px;border-top:1px solid ${LIGHT.border};font-family:${FONT};` +
      `font-size:12px;line-height:19px;color:${LIGHT.muted};`,
    `${escapeHtml(doc.footer.reason)}<br />${escapeHtml(doc.footer.safety)}` +
      (footerLinks ? `<br /><br />${footerLinks}` : ''),
    'fg-pad fg-muted fg-rule'
  )}</tr>`;

  const html = `<!DOCTYPE html>
<html lang="${doc.locale}" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escapeHtml(doc.title)}</title>
<style>${STYLE_BLOCK}</style>
</head>
<body class="fg-page" style="margin:0;padding:0;background-color:${LIGHT.page};">
<div style="display:none;max-height:0;max-width:0;opacity:0;overflow:hidden;font-size:1px;line-height:1px;color:${LIGHT.page};">${escapeHtml(doc.preheader)}${PREHEADER_FILLER}</div>
<table role="presentation" class="fg-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${LIGHT.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="fg-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:${LIGHT.card};border-radius:14px;">
<tr>${td(
    `padding:28px 32px 6px;font-family:${FONT};font-size:22px;line-height:29px;` +
      `font-weight:700;color:${LIGHT.text};`,
    escapeHtml(doc.title),
    'fg-pad fg-text'
  )}</tr>
${bodyRows}${footer}
</table>
</td></tr>
</table>
</body>
</html>`;

  const textLines: string[] = [doc.title, '='.repeat(Math.min(doc.title.length, 60)), ''];
  for (const block of doc.blocks) textLines.push(...renderBlockText(block));
  textLines.push('--', doc.footer.reason, doc.footer.safety);
  for (const link of doc.footer.links) {
    const safe = safeLinkUrl(link.href);
    if (safe) textLines.push(`${link.label}: ${safe}`);
  }

  // Collapse runs of blank lines the block writers may have doubled up, then
  // end with exactly one newline.
  const text = `${textLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
  return { html, text };
}
