import { beforeEach, describe, expect, it } from 'vitest';
import {
  escapeHtml,
  renderEmail,
  type EmailDocument,
} from '../../../../src/services/email/template.js';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL,
    FRONTEND_URL: 'https://app.example',
    ASSETS_BASE_URL: 'https://app.example',
  };
});

function doc(overrides: Partial<EmailDocument> = {}): EmailDocument {
  return {
    locale: 'en',
    title: 'Your week in the greenhouse',
    preheader: '2 tasks are up for grabs.',
    blocks: [],
    footer: {
      reason: 'You are a member of The Kim House.',
      safety: 'We will never ask for your password.',
      links: [{ label: 'Email settings', href: 'https://app.example/settings' }],
    },
    ...overrides,
  };
}

describe('renderEmail', () => {
  it('renders both parts from the same blocks', () => {
    const { html, text } = renderEmail(
      doc({
        blocks: [
          { kind: 'heading', text: 'Could use a hand' },
          { kind: 'text', text: 'Two plants are waiting.' },
          {
            kind: 'row',
            title: 'Monstera',
            href: 'https://app.example/plants/p1',
            lines: ['Watering · 6 days overdue'],
          },
          { kind: 'button', label: 'Open Family Greenhouse', href: 'https://app.example/tasks' },
        ],
      })
    );

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Could use a hand');
    expect(html).toContain('https://app.example/plants/p1');
    expect(html).toContain('Open Family Greenhouse');

    // The text part is a real document, not tags-stripped HTML: headings are
    // underlined, row detail is indented, and each row's URL is on its own
    // line so it survives a client that does not autolink inline text.
    expect(text).toContain('COULD USE A HAND\n----------------');
    expect(text).toContain(
      'Monstera\n    Watering · 6 days overdue\n    https://app.example/plants/p1'
    );
    expect(text).toContain('Open Family Greenhouse: https://app.example/tasks');
    expect(text).not.toContain('<');
  });

  it('escapes user-supplied markup in a plant name in BOTH parts', () => {
    const evil = '<script>alert("x")</script> & "Ficus"';
    const { html, text } = renderEmail(
      doc({
        blocks: [
          { kind: 'row', title: evil, href: 'https://app.example/plants/p1', lines: [evil] },
        ],
      })
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;Ficus&quot;'
    );
    // The text part carries it verbatim, which is correct: text/plain has no
    // parser to confuse, and escaping there would show entity gibberish.
    expect(text).toContain(evil);
  });

  it('escapes markup that arrives through the title, preheader and footer', () => {
    const { html } = renderEmail(
      doc({
        title: '<img src=x onerror=1>',
        preheader: '</div><script>1</script>',
        footer: {
          reason: '<b>member</b>',
          safety: 'safe',
          links: [{ label: '<i>settings</i>', href: 'https://app.example/settings' }],
        },
      })
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>1</script>');
    expect(html).not.toContain('<b>member</b>');
    expect(html).not.toContain('<i>settings</i>');
  });

  it('drops an image that is not on our own asset origin, and keeps one that is', () => {
    const outside = renderEmail(
      doc({
        blocks: [
          {
            kind: 'row',
            title: 'Monstera',
            lines: [],
            imageUrl: 'https://tracker.example/plants/pixel.png',
          },
        ],
      })
    ).html;
    expect(outside).not.toContain('tracker.example');
    expect(outside).not.toContain('<img');

    const ours = renderEmail(
      doc({
        blocks: [
          {
            kind: 'row',
            title: 'Monstera',
            lines: [],
            imageUrl: 'https://app.example/plants/h1/p1/photo.jpg',
          },
        ],
      })
    ).html;
    expect(ours).toContain('<img src="https://app.example/plants/h1/p1/photo.jpg"');
  });

  it('refuses a javascript: href rather than linking it', () => {
    const { html, text } = renderEmail(
      doc({
        blocks: [
          // eslint-disable-next-line no-script-url -- exercising the guard
          { kind: 'row', title: 'Monstera', href: 'javascript:alert(1)', lines: [] },
          // eslint-disable-next-line no-script-url -- exercising the guard
          { kind: 'button', label: 'Tap', href: 'javascript:alert(1)' },
        ],
      })
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Monstera');
    expect(text).not.toContain('javascript:');
    expect(text).not.toContain('Tap:');
  });

  it('carries a preheader, the locale on <html>, and no external resources', () => {
    const { html } = renderEmail(doc({ locale: 'es', preheader: 'Vista previa' }));
    expect(html).toContain('<html lang="es"');
    expect(html).toContain('Vista previa');
    // No web fonts, no stylesheets, no scripts, no remote anything.
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('fonts.googleapis');
    expect(html).not.toContain('@import');
  });

  it('lays out with tables and a 600px cap so Outlook and phones both work', () => {
    const { html } = renderEmail(doc());
    expect(html).toContain('role="presentation"');
    expect(html).toContain('width="600"');
    expect(html).toContain('max-width:100%');
    expect(html).toContain('@media only screen and (max-width: 620px)');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).not.toContain('display:flex');
    expect(html).not.toContain('display:grid');
  });

  it('marks an honest-failure notice distinctly in the text part too', () => {
    const { html, text } = renderEmail(
      doc({ blocks: [{ kind: 'notice', text: 'We could not read your local forecast.' }] })
    );
    expect(html).toContain('fg-notice');
    expect(text).toContain('! We could not read your local forecast.');
  });
});

describe('escapeHtml', () => {
  it('covers the characters that matter in content and in attributes', () => {
    expect(escapeHtml(`<a href="x" data-y='z'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;&lt;/a&gt;'
    );
  });

  it('escapes ampersands before the entities it introduces', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
