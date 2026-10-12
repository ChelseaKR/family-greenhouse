/**
 * Negative controls for `tests/support/emailHtmlChecks.ts`.
 *
 * `renderedEmails.test.ts` asserts that every email the product sends passes
 * `checkEmailHtml` with no problems. That assertion means nothing unless the
 * checker is shown to fail on the things it claims to catch — a checker that
 * passed everything would be a green test over nothing. Each case here takes
 * a document that passes, breaks exactly one rule, and asserts that rule's
 * named problem is reported.
 */
import { describe, expect, it } from 'vitest';
import { checkEmailHtml, leakedSentinels } from '../../../support/emailHtmlChecks.js';

const ORIGIN = 'https://familygreenhouse.net';

/** The smallest document that passes every rule. */
function good(): string {
  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="light dark" />
<title>Water Monstera today</title>
<style>@media (prefers-color-scheme: dark) { .fg-page { background-color: #0e2103 !important; } }</style>
</head>
<body class="fg-page" style="margin:0;">
<table role="presentation" width="100%"><tr><td style="padding:0;">
<img src="${ORIGIN}/brand/logo-dark.png" width="180" height="104" alt="Family Greenhouse" />
<a href="${ORIGIN}/plants/p1">Monstera</a>
</td></tr></table>
</body>
</html>`;
}

const TEXT = `Water Monstera today\n\n${ORIGIN}/plants/p1\n`;

describe('checkEmailHtml — the document that passes', () => {
  it('reports nothing for a well-formed branded email', () => {
    expect(checkEmailHtml(good(), { origin: ORIGIN, text: TEXT })).toEqual([]);
  });
});

describe('checkEmailHtml — each rule fails on exactly what it names', () => {
  const cases: Array<[string, (html: string) => string, RegExp]> = [
    [
      'a remote stylesheet',
      (h) =>
        h.replace('<style>', '<link rel="stylesheet" href="https://cdn.example/x.css" /><style>'),
      /^link: element present/,
    ],
    [
      'a script',
      (h) => h.replace('</body>', '<script>1</script></body>'),
      /^script: element present/,
    ],
    [
      'an image with no alt text',
      (h) => h.replace(' alt="Family Greenhouse"', ''),
      /^img: missing or empty alt/,
    ],
    [
      'an image with empty alt text',
      (h) => h.replace('alt="Family Greenhouse"', 'alt=""'),
      /^img: missing or empty alt/,
    ],
    [
      'an image with no dimensions',
      (h) => h.replace(' width="180" height="104"', ''),
      /^img: missing width\/height/,
    ],
    [
      'a second image (a tracking pixel)',
      (h) =>
        h.replace('</body>', `<img src="${ORIGIN}/open.gif" width="1" height="1" alt="" /></body>`),
      /^img: expected exactly 1 image/,
    ],
    [
      'an image on another origin',
      (h) => h.replace(`${ORIGIN}/brand/logo-dark.png`, 'https://cdn.example/logo.png'),
      /^img: src off-origin/,
    ],
    [
      'an image with a query string',
      (h) => h.replace('logo-dark.png"', 'logo-dark.png?u=42"'),
      /^img: src carries a query string/,
    ],
    [
      'a web font',
      (h) =>
        h.replace('<style>', '<style>@font-face{font-family:x;src:url(https://f.example/x.woff2)}'),
      /^style: @font-face/,
    ],
    [
      'an @import',
      (h) => h.replace('<style>', '<style>@import url(https://f.example/x.css);'),
      /^style: @import/,
    ],
    [
      'a background image',
      (h) => h.replace('style="padding:0;"', `style="background:url(${ORIGIN}/bg.png);"`),
      /^style: url\(\)/,
    ],
    [
      'a javascript: link',
      (h) => h.replace(`href="${ORIGIN}/plants/p1"`, 'href="javascript:alert(1)"'),
      /^href: javascript:/,
    ],
    [
      'an inline event handler',
      (h) => h.replace('<a ', '<a onclick="x()" '),
      /^attribute: inline event handler/,
    ],
    [
      'a flex layout',
      (h) => h.replace('style="padding:0;"', 'style="display:flex;"'),
      /^style: flex\/grid/,
    ],
    [
      'a form',
      (h) => h.replace('</body>', '<form action="/x"></form></body>'),
      /^element: iframe\/object\/embed\/form/,
    ],
    [
      'a missing color-scheme meta',
      (h) => h.replace('<meta name="color-scheme" content="light dark" />', ''),
      /^head: no color-scheme meta/,
    ],
    [
      'no dark-mode rules',
      (h) => h.replace('@media (prefers-color-scheme: dark)', '@media screen'),
      /^style: no dark-mode rules/,
    ],
    ['no lang attribute', (h) => h.replace(' lang="en"', ''), /^html: no lang/],
    [
      'an off-origin link',
      (h) => h.replace(`href="${ORIGIN}/plants/p1"`, 'href="https://evil.example/p1"'),
      /^a: off-origin link/,
    ],
    [
      'a relative link',
      (h) => h.replace(`href="${ORIGIN}/plants/p1"`, 'href="/plants/p1"'),
      /^a: not an absolute http/,
    ],
    ['an unclosed element', (h) => h.replace('</a>', ''), /^structure: /],
    [
      'an unquoted attribute',
      (h) => h.replace('width="180"', 'width=180'),
      /^attribute: unquoted value/,
    ],
  ];

  for (const [name, sabotage, expected] of cases) {
    it(`catches ${name}`, () => {
      const html = sabotage(good());
      expect(html, 'the sabotage must actually change the document').not.toBe(good());
      const problems = checkEmailHtml(html, { origin: ORIGIN, text: TEXT });
      expect(
        problems.some((p) => expected.test(p)),
        problems.join('\n')
      ).toBe(true);
    });
  }

  it('catches a document over the size cap', () => {
    const html = good().replace('</body>', `<p>${'x'.repeat(2000)}</p></body>`);
    const problems = checkEmailHtml(html, { origin: ORIGIN, text: TEXT, maxBytes: 1024 });
    expect(problems.some((p) => p.startsWith('size:'))).toBe(true);
  });

  it('catches a link in the HTML that the text part does not carry', () => {
    const problems = checkEmailHtml(good(), { origin: ORIGIN, text: 'Water Monstera today\n' });
    expect(problems).toContain(`a: link missing from the text part: ${ORIGIN}/plants/p1`);
  });

  it('catches a link in the text part that the HTML does not carry', () => {
    const problems = checkEmailHtml(good(), {
      origin: ORIGIN,
      text: `${TEXT}${ORIGIN}/tasks?filter=due\n`,
    });
    expect(problems).toContain(`text: link missing from the html part: ${ORIGIN}/tasks?filter=due`);
  });

  it('accepts a link on an explicitly allowed second origin (the API, for unsubscribe)', () => {
    const api = 'https://api.familygreenhouse.net';
    const html = good().replace(
      '</td>',
      `<a href="${api}/notifications/email/unsubscribe?t=x">Unsubscribe</a></td>`
    );
    const text = `${TEXT}${api}/notifications/email/unsubscribe?t=x\n`;
    expect(checkEmailHtml(html, { origin: ORIGIN, allowedOrigins: [api], text })).toEqual([]);
    expect(checkEmailHtml(html, { origin: ORIGIN, text })).toContainEqual(
      expect.stringMatching(/^a: off-origin link/)
    );
  });
});

describe('leakedSentinels', () => {
  it('names every sentinel that reached any part, and nothing when none did', () => {
    const message = { subject: 'Water Monstera', text: 'ok', html: '<p>ok PRIVATE-2</p>' };
    expect(leakedSentinels(message, ['PRIVATE-1', 'PRIVATE-2'])).toEqual(['PRIVATE-2']);
    expect(leakedSentinels(message, ['PRIVATE-1'])).toEqual([]);
  });
});
