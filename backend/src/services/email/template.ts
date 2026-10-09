/**
 * Hand-rolled HTML + plain-text email renderer. See ADR 0021.
 *
 * ## Why hand-rolled
 *
 * No template dependency. Email HTML is not web HTML — it is a 1999 subset
 * that every library re-learns badly — and the surface we need is a handful
 * of blocks wide. A few hundred lines of table markup we control beats a
 * transitive dependency in a Lambda that sends a household's daily mail.
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
 *     remote load. The stacks below NAME the brand faces (Bitter for the
 *     title, Instrument Sans for everything else) so a device that has them
 *     uses them, and fall back to installed system faces otherwise.
 *   - **One image: the brand logo.** The header shows
 *     `frontend/public/brand/logo-dark.png` from the site's own origin at a
 *     fixed path with no query string: the same bytes for every recipient,
 *     so the request a mail client makes for it identifies nobody. It has
 *     alt text, width and height, so a client that blocks images (Outlook
 *     desktop by default) shows the name in its place at the right size.
 *     Nothing else emits an `<img>`: a plant photo is served only through a
 *     URL that expires within the hour or so (ADR 0033), and an email is
 *     opened days later, forwarded and archived. Rows are text and a deep
 *     link to the plant, where the photo shows signed in.
 *   - **600px cap, fluid below it.** `width="600"` for Outlook (which ignores
 *     `max-width`) plus `max-width:100%` and a `<620px` media query for
 *     phones.
 *   - **A preheader.** The hidden first line an inbox list shows next to the
 *     subject. Without one, clients scrape the first visible text — which is
 *     usually the greeting, wasting the most-read 40 characters in email.
 *
 * ## Brand
 *
 * The palette is the design-token set in `docs/brand.md` and the `@theme`
 * block of `frontend/src/index.css`: Forest for the header band, Canopy for
 * the serif title (the app's `h1` is `font-serif text-ink`), Leaf dark for
 * links, labels and the button (the app's `.btn-primary` is
 * `bg-primary-700`), Paper and Glass for the row panes, Parchment for the
 * page, and the terracotta accent only on the honest-failure notice, once.
 *
 * ## Dark mode
 *
 * Every color is stated explicitly on both the light path (inline) and the
 * dark path (`prefers-color-scheme` in the `<style>` block). Nothing relies
 * on a client default, because the two clients that force-invert (Outlook
 * mobile, Gmail on Android) invert *unstated* colors only. The header band
 * is Forest on both paths, so the logo never sits on a surface it was not
 * drawn for. Every text/background pair below is at or above WCAG AA on
 * both paths; the button swaps to Leaf light with Forest text in the dark
 * so it stays visible on a dark pane.
 *
 * ## Escaping
 *
 * `escapeHtml` runs over EVERY interpolated value with no exceptions and no
 * "trusted" escape hatch. Plant names, member names and space names are all
 * user-supplied, and a household email is exactly the place a
 * `<script>`-shaped plant name must not survive. There is no API in this
 * module that accepts raw HTML.
 */
import type { EmailLocale } from './catalog.js';
import { brandLogoUrl, safeLinkUrl } from './links.js';

/** A block of email body content. Deliberately small: a heading, prose, a
 *  linked row, a button, a plain link, an honest "could not load" notice, a
 *  rule. */
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
      /** Short label rendered before the title, e.g. "Up for grabs". */
      badge?: string | null;
      /** One small action button under the lines, e.g. "Mark done in the app". */
      action?: { label: string; href: string } | null;
    }
  | { kind: 'button'; label: string; href: string }
  /** A plain text link on its own line, e.g. "and 3 more" → the task list. */
  | { kind: 'link'; label: string; href: string }
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

export interface RenderOptions {
  /**
   * A ready-made plain-text body to use INSTEAD of the one generated from
   * `blocks`. The title and the footer are still added around it, so every
   * text part has the same shape. The daily reminder uses this: its text
   * body is the numbered list the reply-to-act path (ADR 0031) is bound to,
   * and that list is tested line by line, so it is kept rather than
   * regenerated.
   */
  textBody?: string;
}

// --- palette ----------------------------------------------------------------
// Light values are inlined; the dark twins live in the <style> block below.
// Every value is a token from docs/brand.md or frontend/src/index.css.
const LIGHT = {
  /** Parchment: the page behind the card. */
  page: '#eef1e6',
  card: '#ffffff',
  /** Forest: the header band, on both paths. */
  band: '#173404',
  /** The app's body text (`text-gray-900`). */
  text: '#111827',
  /** Canopy: serif titles (`text-ink`). */
  title: '#27500a',
  /** `text-gray-600`: supporting lines and the footer. */
  muted: '#4b5563',
  /** Leaf dark: links, uppercase labels, the button (`bg-primary-700`). */
  accent: '#3b6d11',
  onAccent: '#ffffff',
  /** Dew: rules and structural borders. */
  border: '#b7d9d1',
  /** Paper + Glass: the pane each row sits in. */
  paneBg: '#f7f8f2',
  paneBorder: '#ddeee7',
  /** Terracotta accent-50 / accent-800 / accent-200: the one warm accent. */
  noticeBg: '#fdf4ed',
  noticeText: '#7e3219',
  noticeBorder: '#f4caa4',
} as const;

const DARK = {
  /** primary-950 */
  page: '#0e2103',
  /** Forest */
  card: '#173404',
  /** Paper */
  text: '#f7f8f2',
  title: '#f7f8f2',
  /** Dew */
  muted: '#b7d9d1',
  /** Leaf light */
  accent: '#97c459',
  /** Forest on Leaf light: 6.8:1 */
  onAccent: '#173404',
  /** Leaf dark */
  border: '#3b6d11',
  /** Canopy pane on a Forest card */
  paneBg: '#27500a',
  paneBorder: '#3b6d11',
  /** accent-900 / accent-100 / accent-700 */
  noticeBg: '#5e2614',
  noticeText: '#fae6d4',
  noticeBorder: '#a23f1a',
} as const;

const FONT =
  "'Instrument Sans','Instrument Sans Variable',Inter,-apple-system,BlinkMacSystemFont," +
  "'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const FONT_DISPLAY = "Bitter,'Bitter Variable',Georgia,Cambria,'Times New Roman',Times,serif";

/** The product name is the same in every language, so the logo's alt text
 *  is a constant rather than a catalog key. */
const BRAND_NAME = 'Family Greenhouse';

/** The logo is 800×460; 180px wide keeps the lockup's own ratio. */
const LOGO_WIDTH = 180;
const LOGO_HEIGHT = 104;

const STYLE_BLOCK = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .fg-page { background-color: ${DARK.page} !important; }
    .fg-card { background-color: ${DARK.card} !important; }
    .fg-text { color: ${DARK.text} !important; }
    .fg-text a { color: ${DARK.accent} !important; }
    .fg-title { color: ${DARK.title} !important; }
    .fg-muted { color: ${DARK.muted} !important; }
    .fg-label { color: ${DARK.accent} !important; }
    .fg-link { color: ${DARK.accent} !important; }
    .fg-rule { border-color: ${DARK.border} !important; }
    .fg-pane {
      background-color: ${DARK.paneBg} !important;
      border-color: ${DARK.paneBorder} !important;
    }
    .fg-button, .fg-button a {
      background-color: ${DARK.accent} !important;
      color: ${DARK.onAccent} !important;
    }
    .fg-notice {
      background-color: ${DARK.noticeBg} !important;
      color: ${DARK.noticeText} !important;
      border-color: ${DARK.noticeBorder} !important;
    }
  }
  @media only screen and (max-width: 620px) {
    .fg-card { width: 100% !important; }
    .fg-pad { padding-left: 18px !important; padding-right: 18px !important; }
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
    `padding:10px 32px 10px;font-family:${FONT};font-size:12px;line-height:18px;` +
      `letter-spacing:0.1em;text-transform:uppercase;font-weight:700;color:${LIGHT.accent};`,
    escapeHtml(text),
    'fg-pad fg-label'
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

/** The button itself, without the outer row: reused inside a row's pane. */
function buttonTable(label: string, href: string, size: 'large' | 'small'): string {
  const safe = safeLinkUrl(href);
  if (!safe) return '';
  const padding = size === 'large' ? '13px 26px' : '9px 16px';
  const fontSize = size === 'large' ? '15px' : '14px';
  const anchor =
    `<a href="${escapeHtml(safe)}" style="display:inline-block;padding:${padding};` +
    `font-family:${FONT};font-size:${fontSize};font-weight:600;line-height:20px;` +
    `color:${LIGHT.onAccent};text-decoration:none;border-radius:8px;` +
    `background-color:${LIGHT.accent};">${escapeHtml(label)}</a>`;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0">` +
    `<tr><td class="fg-button" bgcolor="${LIGHT.accent}" style="border-radius:8px;` +
    `background-color:${LIGHT.accent};">${anchor}</td></tr></table>`
  );
}

function button(label: string, href: string): string {
  const table = buttonTable(label, href, 'large');
  if (!table) return '';
  return `<tr>${td('padding:4px 32px 22px;', table, 'fg-pad')}</tr>`;
}

function link(label: string, href: string): string {
  const safe = safeLinkUrl(href);
  if (!safe) return '';
  return `<tr>${td(
    `padding:0 32px 16px;font-family:${FONT};font-size:15px;line-height:23px;`,
    `<a class="fg-link" href="${escapeHtml(safe)}" style="color:${LIGHT.accent};` +
      `font-weight:600;text-decoration:underline;">${escapeHtml(label)}</a>`,
    'fg-pad'
  )}</tr>`;
}

function row(block: Extract<EmailBlock, { kind: 'row' }>): string {
  const safe = safeLinkUrl(block.href);
  const titleText = escapeHtml(block.title);
  const title = safe
    ? `<a class="fg-link" href="${escapeHtml(safe)}" style="color:${LIGHT.accent};` +
      `text-decoration:none;font-weight:600;">${titleText}</a>`
    : `<span style="font-weight:600;">${titleText}</span>`;

  const badge = block.badge
    ? `<div class="fg-label" style="font-family:${FONT};font-size:11px;line-height:16px;` +
      `letter-spacing:0.08em;text-transform:uppercase;font-weight:700;color:${LIGHT.accent};` +
      `padding-bottom:2px;">${escapeHtml(block.badge)}</div>`
    : '';

  const lines = block.lines
    .map(
      (line) =>
        `<div class="fg-muted" style="font-family:${FONT};font-size:14px;line-height:21px;` +
        `color:${LIGHT.muted};padding-top:2px;">${escapeHtml(line)}</div>`
    )
    .join('');

  const action = block.action ? buttonTable(block.action.label, block.action.href, 'small') : '';
  const actionCell = action ? `<div style="padding-top:10px;">${action}</div>` : '';

  const body =
    `${badge}<div class="fg-text" style="font-family:${FONT};font-size:16px;` +
    `line-height:23px;color:${LIGHT.text};">${title}</div>${lines}${actionCell}`;

  // No photo thumbnail: see "One image" in the header (ADR 0033). Each row is
  // a pane — Paper on Glass — which is the brand's structural motif.
  const inner =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr>${td(
      `padding:14px 16px;border:1px solid ${LIGHT.paneBorder};border-radius:10px;` +
        `background-color:${LIGHT.paneBg};`,
      body,
      'fg-pane'
    )}</tr></table>`;

  return `<tr>${td('padding:0 32px 10px;', inner, 'fg-pad')}</tr>`;
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
    case 'link':
      return link(block.label, block.href);
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
      const action = block.action ? safeLinkUrl(block.action.href) : null;
      // The action's URL is printed only when it differs from the row's own.
      if (block.action && action && action !== safe) {
        out.push(`    ${block.action.label}: ${action}`);
      }
      out.push('');
      return out;
    }
    case 'button':
    case 'link': {
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

/** The Forest band with the logo. Alt text, width and height are what a
 *  client that blocks images renders in its place. */
function header(): string {
  const src = escapeHtml(brandLogoUrl());
  const alt = escapeHtml(BRAND_NAME);
  const img =
    `<img src="${src}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="${alt}" ` +
    `style="display:block;border:0;outline:none;text-decoration:none;width:${LOGO_WIDTH}px;` +
    `height:auto;max-width:${LOGO_WIDTH}px;color:#f7f8f2;font-family:${FONT_DISPLAY};` +
    `font-size:22px;line-height:28px;" />`;
  return `<tr>${td(
    `padding:22px 32px 18px;background-color:${LIGHT.band};border-radius:14px 14px 0 0;`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">` +
      `<tr><td align="center" bgcolor="${LIGHT.band}" style="background-color:${LIGHT.band};">` +
      `${img}</td></tr></table>`,
    'fg-pad'
  )}</tr>`;
}

/**
 * Render one document into both parts.
 *
 * The text part is not a stripped-down afterthought: it is generated from the
 * same block list with its own layout rules (underlined headings, indented
 * supporting lines, the URL on its own line under each row) so that a client
 * that shows only `text/plain` — or a person who prefers it — gets a
 * genuinely readable email rather than HTML with the tags removed.
 */
export function renderEmail(
  doc: EmailDocument,
  options: RenderOptions = {}
): { html: string; text: string } {
  const bodyRows = doc.blocks.map(renderBlockHtml).join('');

  const footerLinks = doc.footer.links
    .map((link) => {
      const safe = safeLinkUrl(link.href);
      return safe
        ? `<a class="fg-link" href="${escapeHtml(safe)}" style="color:${LIGHT.accent};` +
            `text-decoration:underline;">${escapeHtml(link.label)}</a>`
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
<meta name="x-apple-disable-message-reformatting" />
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no" />
<title>${escapeHtml(doc.title)}</title>
<style>${STYLE_BLOCK}</style>
</head>
<body class="fg-page" style="margin:0;padding:0;background-color:${LIGHT.page};">
<div style="display:none;max-height:0;max-width:0;opacity:0;overflow:hidden;font-size:1px;line-height:1px;color:${LIGHT.page};">${escapeHtml(doc.preheader)}${PREHEADER_FILLER}</div>
<table role="presentation" class="fg-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${LIGHT.page};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="fg-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:${LIGHT.card};border-radius:14px;">
${header()}
<tr>${td(
    `padding:28px 32px 8px;font-family:${FONT_DISPLAY};font-size:26px;line-height:33px;` +
      `font-weight:400;color:${LIGHT.title};`,
    escapeHtml(doc.title),
    'fg-pad fg-title'
  )}</tr>
${bodyRows}${footer}
</table>
</td></tr>
</table>
</body>
</html>`;

  const textLines: string[] = [doc.title, '='.repeat(Math.min(doc.title.length, 60)), ''];
  if (typeof options.textBody === 'string') textLines.push(options.textBody.trimEnd(), '');
  else for (const block of doc.blocks) textLines.push(...renderBlockText(block));
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

/** Exposed for the rendering tests; not part of the composing API. */
export const __palette = { LIGHT, DARK, LOGO_WIDTH, LOGO_HEIGHT } as const;
