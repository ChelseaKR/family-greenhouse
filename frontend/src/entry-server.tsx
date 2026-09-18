/**
 * SSR entry used only by the build-time prerender.
 *
 * `vite build --ssr src/entry-server.tsx --outDir dist-ssr` compiles this into a
 * Node-loadable bundle; `scripts/prerender.mjs` imports it, renders each public
 * marketing route, and inlines the resulting HTML + <head> into the client
 * template. There is no server at runtime — the output is static files in S3.
 *
 * Deliberately does NOT import `main.tsx`: that module registers the service
 * worker, boots Sentry/telemetry, and applies persisted preferences, none of
 * which have any meaning in a build script. It composes the same providers
 * around <App /> instead, so what renders here is what hydrates in the browser.
 */

import { StrictMode } from 'react';
import { prerender } from 'react-dom/static.edge';
import { StaticRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import './i18n';
import { MetaSinkContext, type MetaSink } from './hooks/metaSink';
import { headToTags, notFoundHeadToTags, resolveHead, type MetaTags } from './config/seo';

/** Rendered HTML for a route plus the <head> tags the route asked for. */
export interface RenderedRoute {
  /** Markup for `<div id="root">`. */
  html: string;
  /** Serialized <head> content for the head:start/head:end block. */
  head: string;
}

/**
 * React 19 hoists document-level resources — `<link rel="preload">` for images,
 * stylesheets, `<meta>` — out of the component tree and into <head>. When the
 * render target is a fragment rather than a whole document (it is: we splice
 * into an existing index.html) there is no <head> to hoist into, so React emits
 * them inline at the head of the stream instead.
 *
 * They must be moved to <head> rather than left where they land. Leaving them
 * inside #root is what a hydration mismatch is made of: the client renders the
 * same tree, React hoists the tag into <head> as designed, and the first child
 * of #root no longer matches the server's — React throws away the entire
 * prerendered tree and re-renders on the client, which silently undoes the
 * whole point of prerendering. (This is not theoretical: BrandMark's eager
 * `/brand/icon.svg` produced exactly one such tag on all 25 pages.)
 *
 * `<link>` and `<meta>` are never legitimate body content in this app, so
 * extracting them wholesale is safe; `check-prerender-coverage.mjs` re-asserts
 * that none survived into #root.
 */
function extractHoistables(html: string): { body: string; hoisted: string } {
  const hoisted: string[] = [];
  const body = html.replace(/<(?:link|meta)\b[^>]*>/g, (tag) => {
    hoisted.push(tag);
    return '';
  });
  return { body, hoisted: hoisted.join('\n    ') };
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Only `retry` is overridden, and only to keep the build from making
        // three doomed attempts per query against a backend that isn't running.
        //
        // Queries stay ENABLED on purpose. `useQuery` doesn't suspend, so a
        // data-backed route (/status) prerenders in its loading state — "we're
        // checking" — which is exactly what its real first paint shows.
        // Disabling queries instead would render the settled-but-empty branch,
        // and /status resolves missing data to `down`: the build would ship a
        // static page claiming an outage that isn't happening.
        retry: false,
      },
    },
  });
}

/**
 * Render the app at `url` and return the markup plus the meta the rendered
 * route asked for.
 *
 * Uses React 19's `prerender` (react-dom/static) rather than `renderToString`
 * because every route in App.tsx is behind `React.lazy`. `renderToString`
 * cannot suspend, so it would emit the Suspense fallback — a loading spinner —
 * for all 25 pages. `prerender` waits for the whole tree to settle and only
 * then resolves.
 */
async function renderApp(
  url: string
): Promise<{ body: string; hoisted: string; meta: MetaTags | null }> {
  const sink: MetaSink = { current: null };
  const errors: unknown[] = [];

  const { prelude } = await prerender(
    <StrictMode>
      <QueryClientProvider client={newQueryClient()}>
        <MetaSinkContext.Provider value={sink}>
          <StaticRouter location={url}>
            <App />
          </StaticRouter>
        </MetaSinkContext.Provider>
      </QueryClientProvider>
    </StrictMode>,
    {
      onError(error) {
        errors.push(error);
      },
    }
  );

  if (errors.length > 0) throw errors[0];

  const rendered = await new Response(prelude).text();
  return { ...extractHoistables(rendered), meta: sink.current as MetaTags | null };
}

/** Render one route to HTML. */
export async function renderRoute(url: string): Promise<RenderedRoute> {
  const { body, hoisted, meta } = await renderApp(url);
  const head = headToTags(resolveHead(meta, url));
  return { html: body, head: hoisted ? `${head}\n    ${hoisted}` : head };
}

/**
 * A URL no `<Route>` in App.tsx declares, so React Router resolves it to the
 * `*` route — the same `NotFoundPage` a browser renders for an unknown URL.
 */
const NOT_FOUND_RENDER_URL = '/__not-found__';

/**
 * The not-found document, `dist/404.html` (issue #719). CloudFront returns it
 * WITH a 404 status for any path the frontend bucket has no object for, so a
 * crawler, a link checker and a browser with JavaScript off all get the app's
 * own "Nothing growing here" page rather than S3's XML error.
 *
 * It answers for arbitrary URLs, so its head is resolved with no path (no
 * canonical) and serialized by `notFoundHeadToTags` — which also leaves out
 * `og:site_name`, because the same document answers for a missing `/assets/`
 * chunk. See that function for why that matters.
 */
export async function renderNotFound(): Promise<RenderedRoute> {
  const { body, hoisted, meta } = await renderApp(NOT_FOUND_RENDER_URL);
  const head = notFoundHeadToTags(resolveHead(meta, null));
  return { html: body, head: hoisted ? `${head}\n    ${hoisted}` : head };
}

/**
 * The <head> for the SPA shell — the document CloudFront serves for every path
 * that has no prerendered file (the dashboard, an unknown URL), and the service
 * worker's offline navigation fallback.
 *
 * It answers for arbitrary URLs, so it deliberately carries no canonical: see
 * the canonical strategy note in `config/seo.ts`.
 */
export function shellHead(): string {
  return headToTags(resolveHead(null, null));
}
