// CloudFront Function (viewer-request) for the Family Greenhouse distribution.
//
// WHY THIS EXISTS
//
// The frontend bucket is private and served through Origin Access Control, so
// CloudFront talks to the S3 REST API, not the S3 website endpoint. The REST
// API has no directory index: a request for `/pricing` asks for an object
// literally keyed `pricing`, which does not exist. `default_root_object` does
// NOT fill that gap — it only rewrites the bare `/`. Without this function the
// prerendered marketing pages would be built, uploaded, and never served.
//
// This function now decides the WHOLE routing question, in four kinds:
//
//   1. `/assets/...`  content-addressed build output. Left alone, always. The
//      name contains the hash of the bytes, so the object either exists or it
//      genuinely does not, and "does not" must reach the viewer as a 404.
//   1b. `/.well-known/...` well-known URIs (RFC 8615). Left alone for the same
//      reason, plus one of its own: `apple-app-site-association` is
//      extensionless, so rule (3) would rewrite it to the shell and Apple
//      would never see the file the deploy uploaded.
//   2. A prerendered public page (PRERENDERED below). Mapped onto its object:
//      `/care/monstera` -> `/care/monstera/index.html`.
//   2b. One segment under a PREFIXED namespace, mapped the same way unlisted.
//   3. An extensionless path the APP routes (APP_EXACT / APP_PATTERNS below).
//      Rewritten to `/app-shell.html` BY NAME — the object always exists, so
//      the request is a hit rather than an error.
//   4. An extensionless path that is neither. Left alone, so S3 answers 404
//      and the viewer gets it, with /404.html as the body (main.tf).
//
// Anything with a dot in its last segment is a file request and is left alone.
//
// WHY (4) EXISTS (issue #719): (3) used to take every extensionless path, so
// every url answered 200. (3) and (4) split on App.tsx's routes, so a url that
// now 404s already rendered "Nothing growing here". See app-routes.mjs.
//
// PRERENDERED is generated from frontend/scripts/public-routes.mjs — the same
// list the sitemap and the prerenderer read. APP_EXACT and APP_PATTERNS are
// generated from src/App.tsx. Regenerate both with
// `npm run spa-router --workspace frontend`; `spa-router:check` fails the gate
// if either drifts. `/` is in no list because it is handled directly.
//
// Covered by frontend/scripts/spa-router.test.mjs — edit both together. The
// test also asserts this file stays under CloudFront's 10 KB function limit,
// which the generated map is the only thing here that grows.

// --- generated from public-routes.mjs: do not edit by hand -------------------
var PRERENDERED = {
  '/pricing': 1,
  '/gift': 1,
  '/blog': 1,
  '/care': 1,
  '/help': 1,
  '/pet-safe': 1,
  '/changelog': 1,
  '/status': 1,
  '/legal/privacy': 1,
  '/legal/terms': 1,
  '/support': 1,
  '/account-deletion': 1,
  '/blog/how-to-remember-to-water-plants': 1,
  '/blog/sharing-plant-care-without-becoming-the-nag': 1,
  '/blog/low-maintenance-houseplants-for-forgetful-people': 1,
  '/blog/how-to-move-plants-without-killing-them': 1,
  '/blog/pet-safe-houseplants-that-are-hard-to-kill': 1,
  '/blog/most-common-toxic-houseplants-and-safer-swaps': 1,
  '/blog/how-to-split-plant-care-with-your-partner': 1,
  '/blog/how-to-water-plants-while-on-vacation': 1,
  '/blog/what-to-leave-for-a-plant-sitter': 1,
  '/blog/plant-care-instructions-for-non-plant-people': 1,
  '/blog/merging-plant-collections-when-you-move-in-together': 1,
  '/blog/signs-of-overwatering-and-how-to-fix-it': 1,
  '/blog/why-are-my-plant-leaves-turning-yellow': 1,
  '/blog/how-much-light-does-my-room-get': 1,
  '/care/pothos': 1,
  '/care/snake-plant': 1,
  '/care/monstera': 1,
  '/care/spider-plant': 1,
  '/care/peace-lily': 1,
  '/care/heartleaf-philodendron': 1,
  '/care/zz-plant': 1,
  '/care/aloe-vera': 1,
  '/care/dieffenbachia': 1,
  '/care/calathea': 1,
  '/care/fiddle-leaf-fig': 1,
  '/care/rubber-plant': 1,
  '/care/bird-of-paradise': 1,
  '/care/anthurium': 1,
  '/care/chinese-evergreen': 1,
  '/care/jade-plant': 1,
  '/care/english-ivy': 1,
  '/care/boston-fern': 1,
  '/care/money-tree': 1,
  '/care/christmas-cactus': 1,
  '/care/parlor-palm': 1,
  '/care/orchid': 1,
  '/care/hoya': 1,
  '/care/nerve-plant': 1,
  '/help/getting-started': 1,
  '/help/plants': 1,
  '/help/tasks': 1,
  '/help/reminders': 1,
  '/help/households': 1,
  '/help/sitters': 1,
  '/help/billing': 1,
  '/help/data': 1,
  '/help/limits': 1,
};
var PREFIXED = '/pet-safe/';
// --- end generated -----------------------------------------------------------

// --- generated from App.tsx: do not edit by hand -----------------------------
var APP_EXACT =
  '/account /analytics /away-recap /chat /confirm-email /dashboard /forgot-password /household /household/caretaker-report /login /onboarding /plants /plants/import /plants/new /register /reset-password /settings /settings/billing /tags /tasks /today /welcome';
var APP_PATTERNS = '/caretaker/* /join/* /kiosk/* /plants/* /shared/* /sit/* /sit/*/brief /tag/*';
// --- end generated App.tsx ---------------------------------------------------

// Space-delimited strings, not object literals: half the bytes, under a hard
// 10 KB ceiling. `*` matches exactly one NON-EMPTY segment, as React Router's
// `:param` does, so segment count + literal equality is exact.
function isAppRoute(path) {
  if ((' ' + APP_EXACT + ' ').indexOf(' ' + path + ' ') !== -1) return true;

  var segments = path.split('/');
  var patterns = APP_PATTERNS.split(' ');
  for (var i = 0; i < patterns.length; i++) {
    var parts = patterns[i].split('/');
    if (parts.length !== segments.length) continue;
    var matched = true;
    for (var j = 1; j < parts.length; j++) {
      if (segments[j] === '' || (parts[j] !== '*' && parts[j] !== segments[j])) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // `www.` never reaches this function: its own distribution 301s it (#797).

  // (1) Content-addressed build output. Never a route, never rewritten: a
  // request for a chunk that is not there has to be a miss, not the shell.
  if (uri === '/assets' || uri.indexOf('/assets/') === 0) {
    return request;
  }

  // (1b) `/.well-known/...` is a registry of well-known URIs (RFC 8615), not a
  // route. `assetlinks.json` would survive rule (3) by accident — its last
  // segment has a dot — but `apple-app-site-association` is extensionless by
  // Apple's spec, so without this it is rewritten to `/app-shell.html` and
  // Apple's CDN fetches `200 text/html` no matter what the deploy uploaded.
  // The file would be in the bucket, correctly typed, and unreachable.
  //
  // Passing it through also means a MISSING association file answers 404
  // rather than 200-with-the-shell, which is the difference between Android's
  // verifier reporting "no such file" and reporting a JSON parse error on a
  // page of HTML. Same reasoning as `/assets/` above, and it works for the
  // same reason: the frontend bucket grants `s3:ListBucket`, so a missing
  // object is a 404 that no `custom_error_response` turns into a 200.
  if (uri === '/.well-known' || uri.indexOf('/.well-known/') === 0) {
    return request;
  }

  // Normalise one trailing slash away so `/care/monstera/` and
  // `/care/monstera` resolve to the same object.
  var path = uri.length > 1 && uri.charAt(uri.length - 1) === '/' ? uri.slice(0, -1) : uri;

  if (path === '/') {
    // The prerendered homepage.
    request.uri = '/index.html';
    return request;
  }

  // (2) A prerendered public page.
  if (PRERENDERED[path] === 1) {
    request.uri = path + '/index.html';
    return request;
  }

  // (2b) No object, S3's 404. Why: build-spa-router.mjs prefixServedRoutes().
  var cut = path.lastIndexOf('/') + 1;
  var ns = path.slice(0, cut).toLowerCase();
  if (cut < path.length && path.indexOf('.', cut) < 0 && PREFIXED.split(' ').indexOf(ns) >= 0) {
    request.uri = path.toLowerCase() + '/index.html';
    return request;
  }

  // The extension test looks only at the LAST path segment, so a directory
  // with a dot in its name can't accidentally suppress the rewrite.
  var lastSegment = path.slice(path.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    // React Router matches case-insensitively (<Route caseSensitive> defaults
    // to false), so the ROUTE question is asked of the lower-cased path.
    // PRERENDERED above stays case-sensitive: `/Pricing` reaching the shell to
    // be client-rendered is what already shipped. Every generated key is
    // lower-case (asserted in spa-router.test.mjs), so this is a superset of
    // that lookup, not a second disagreeing answer.
    var lower = path.toLowerCase();

    // (3) A path this app routes: the authenticated app, a token page, or a
    // public page reached with different capitalisation. The shell by name.
    if (PRERENDERED[lower] === 1 || isAppRoute(lower)) {
      request.uri = '/app-shell.html';
      return request;
    }

    // (4) Extensionless and matched by nothing. Leaving the URI alone asks S3
    // for an object that is not there; the frontend bucket grants
    // `s3:ListBucket`, so that is a 404, and the distribution's 404 rule keeps
    // the status and serves /404.html as the body.
    return request;
  }

  // A file request: robots.txt, favicon.ico, sitemap.xml, a brand image. It
  // exists or it does not, and "does not" is a 404.
  return request;
}
