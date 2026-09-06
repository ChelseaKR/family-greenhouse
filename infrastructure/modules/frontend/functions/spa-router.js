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
// This function now decides the WHOLE routing question, in three kinds:
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
//   3. Any other extensionless path. Rewritten to `/app-shell.html` BY NAME —
//      the object always exists, so the request is a hit rather than an error.
//
// Anything with a dot in its last segment is a file request and is left alone.
//
// WHY (3) IS A REWRITE AND NOT AN ERROR FALLBACK (issue #615)
//
// It used to be an error fallback: `/dashboard` was rewritten to
// `/dashboard/index.html`, S3 answered 403, and the distribution's
// `custom_error_response` turned that 403 into `200 /app-shell.html`. That
// worked, and it also meant EVERY missing object under this distribution came
// back as a 200 carrying the app shell — including `/assets/index-<hash>.js`.
// A dropped JS bundle was therefore indistinguishable, by status code, from a
// healthy deploy, and the Route 53 health check (which matches an `og:site_name`
// tag that lives in that very shell) would have called it healthy.
//
// `custom_error_response` is a property of the DISTRIBUTION, not of a cache
// behavior, so it cannot be scoped to exclude `/assets/`. The only way to stop
// it rescuing asset misses is to stop routes depending on it — which is what
// this function now does. See modules/frontend/main.tf for the rest of the
// chain (the `s3:ListBucket` grant and the removed 404 rule).
//
// PRERENDERED is generated from frontend/scripts/public-routes.mjs — the same
// list the sitemap and the prerenderer read. Regenerate with
// `npm run spa-router --workspace frontend`; `spa-router:check` fails the gate
// if it drifts. `/` is not in the map because it is handled directly.
//
// Covered by frontend/scripts/spa-router.test.mjs — edit both together. The
// test also asserts this file stays under CloudFront's 10 KB function limit,
// which the generated map is the only thing here that grows.

// --- generated from public-routes.mjs: do not edit by hand -------------------
var PRERENDERED = {
  '/pricing': 1,
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
// --- end generated -----------------------------------------------------------

function handler(event) {
  var request = event.request;
  var uri = request.uri;

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
  // object is a 404 that no `custom_error_response` rescues.
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

  // (3) Everything else that looks like a route — the authenticated app, an
  // unknown URL, a typo — gets the shell by name. The extension test looks
  // only at the LAST path segment, so a directory with a dot in its name
  // can't accidentally suppress the rewrite.
  var lastSegment = path.slice(path.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/app-shell.html';
    return request;
  }

  // A file request: robots.txt, favicon.ico, sitemap.xml, a brand image. It
  // exists or it does not, and "does not" is a 404.
  return request;
}
