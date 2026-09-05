/**
 * Installs the browser error handlers before anything else in the app runs.
 *
 * **This must stay the first import in `main.tsx`.** `scripts/check-observability.mjs`
 * asserts that it is.
 *
 * Why a separate module rather than a call at the top of `main.tsx` (issue
 * #576): ES modules evaluate every dependency's body before the importing
 * module's own body. `initFrontendTelemetry()` used to sit at `main.tsx:26`,
 * which meant `@/lib/zodConfig`, React, `react-dom/client`, `react-router`,
 * `@tanstack/react-query`, the entire `./App` route tree, `./sentry`,
 * `./services/pwaRegistration`, `./i18n`, both Zustand stores and four CSS
 * imports had all already been evaluated by the time `window.onerror` was
 * hooked. A top-level throw anywhere in that graph happened with no handler
 * installed and was reported by nothing — `RouteErrorBoundary` cannot help
 * either, because React has to mount first.
 *
 * Importing this module first inverts that: because a dependency's body runs
 * before the importer's, and before every later import's, the handlers are in
 * place before the first line of application code executes.
 *
 * What this still does NOT cover, stated so nobody reads more into it: an
 * entry chunk that fails to load at all. If the browser never fetches or never
 * parses the bundle, no module in it runs, and only markup in `index.html`
 * could catch that. The Route 53 site health check added in #552 is the layer
 * that sees a bundle which stopped being served.
 */
import { initFrontendTelemetry } from './services/frontendTelemetry';

initFrontendTelemetry();
