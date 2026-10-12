import { beforeEach, describe, expect, it } from 'vitest';
import {
  __palette,
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

  it('emits exactly one image, the brand logo, and never a plant photo (ADR 0033)', () => {
    // A photo URL cannot live in an email: it is served only through a
    // signature that expires within the hour or so, and a mailbox keeps a
    // message for years. So the renderer has no image path to take, whatever
    // a composer hands it. The one image is the header's logo: a fixed file
    // on our own origin, with alt text and dimensions.
    const { html } = renderEmail(
      doc({
        blocks: [
          { kind: 'heading', text: 'Could use a hand' },
          { kind: 'text', text: 'Two plants are waiting.' },
          { kind: 'notice', text: 'We could not load the forecast.' },
          {
            kind: 'row',
            title: 'Monstera',
            href: 'https://app.example/plants/p1',
            lines: ['Water 3 days overdue'],
            badge: 'Up for grabs',
            // A stale caller passing a photo the old way is ignored.
            ...({ imageUrl: 'https://app.example/plants/h1/p1/photo.jpg' } as object),
          },
          { kind: 'button', label: 'Open', href: 'https://app.example/tasks' },
          { kind: 'divider' },
        ],
      })
    );
    const images = html.match(/<img\b[^>]*>/gi) ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]).toContain('src="https://app.example/brand/logo-dark.png"');
    expect(images[0]).toContain('alt="Family Greenhouse"');
    expect(images[0]).toContain(`width="${__palette.LOGO_WIDTH}"`);
    expect(images[0]).toContain(`height="${__palette.LOGO_HEIGHT}"`);
    expect(html).not.toContain('/plants/h1/p1/photo.jpg');
  });

  it('renders a row action as a button to the row link, in both parts', () => {
    const { html, text } = renderEmail(
      doc({
        blocks: [
          {
            kind: 'row',
            title: '1. Monstera',
            href: 'https://app.example/plants/p1',
            lines: ['Water · 6 days overdue'],
            action: { label: 'Mark done in the app', href: 'https://app.example/plants/p1' },
          },
          { kind: 'link', label: 'and 3 more', href: 'https://app.example/tasks?filter=due' },
        ],
      })
    );
    expect(html).toContain('Mark done in the app');
    expect(html).toContain('class="fg-button"');
    expect(html).toContain('and 3 more');
    // The action's URL is the row's own, so the text part prints it once.
    expect(text).toContain(
      '1. Monstera\n    Water · 6 days overdue\n    https://app.example/plants/p1'
    );
    expect(text).not.toContain('Mark done in the app:');
    expect(text).toContain('and 3 more: https://app.example/tasks?filter=due');
  });

  it('uses a caller-supplied text body under the same title and footer', () => {
    const { text } = renderEmail(
      doc({ blocks: [{ kind: 'text', text: 'Generated prose that must NOT appear.' }] }),
      { textBody: '1. Monstera — water, 2 days overdue\n   https://app.example/plants/p1' }
    );
    expect(
      text.startsWith('Your week in the greenhouse\n===========================\n\n1. Monstera')
    ).toBe(true);
    expect(text).not.toContain('Generated prose');
    expect(text).toContain(
      '--\nYou are a member of The Kim House.\nWe will never ask for your password.'
    );
    expect(text).toContain('Email settings: https://app.example/settings');
  });

  it('states every color on both the light and the dark path, from the brand tokens', () => {
    const { html } = renderEmail(doc({ blocks: [{ kind: 'notice', text: 'x' }] }));
    const { LIGHT, DARK } = __palette;
    // Light values are inline; dark twins are in the one <style> block.
    for (const value of [LIGHT.band, LIGHT.title, LIGHT.accent, LIGHT.paneBg, LIGHT.noticeBg]) {
      expect(html).toContain(value);
    }
    const style = /<style>([\s\S]*?)<\/style>/u.exec(html)?.[1] ?? '';
    for (const value of [
      DARK.page,
      DARK.card,
      DARK.text,
      DARK.accent,
      DARK.paneBg,
      DARK.noticeBg,
    ]) {
      expect(style).toContain(value);
    }
    // The band is Forest on both paths: the logo never sits on a surface it was not drawn for.
    expect(style).not.toContain('.fg-band');
    expect(html).toContain(`background-color:${LIGHT.band}`);
    expect(LIGHT.band).toBe('#173404');
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
