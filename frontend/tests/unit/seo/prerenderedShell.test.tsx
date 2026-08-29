import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderRoute } from '../../../scripts/prerender.mjs';

/**
 * The prerendered heading and summary live INSIDE `#root`. That is only safe
 * because React clears its container on the first commit, so a visitor never
 * sees the crawler copy and the hydrated page at the same time. If that ever
 * stopped being true, every prerendered route would render its heading twice —
 * so it is pinned here rather than assumed from the React docs.
 */
describe('prerendered content inside #root', () => {
  it('is replaced by React’s first commit', () => {
    const shell = [
      '<head><title>t</title><meta name="description" content="d" />',
      '<meta property="og:type" content="website" /><meta property="og:title" content="t" />',
      '<meta property="og:description" content="d" /><meta name="twitter:title" content="t" />',
      '<meta name="twitter:description" content="d" /></head>',
      '<body><div id="root"></div></body>',
    ].join('');

    const html = renderRoute(shell, {
      path: '/care',
      canonical: 'https://familygreenhouse.net/care',
      title: 'Plant care guides',
      description: 'How often to water common houseplants.',
      heading: 'Plant care guides',
      ogType: 'website',
      jsonLd: null,
    });

    const host = document.createElement('div');
    host.innerHTML = html.slice(html.indexOf('<div id="root">'), html.indexOf('</body>'));
    document.body.appendChild(host);

    const container = host.querySelector('#root') as HTMLElement;
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.textContent).toContain('Plant care guides');

    const root = createRoot(container);
    act(() => {
      root.render(<h1>Hydrated heading</h1>);
    });

    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.textContent).toBe('Hydrated heading');
    expect(container.querySelector('[data-prerendered-route]')).toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});
