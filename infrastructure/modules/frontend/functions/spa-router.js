// CloudFront Function (viewer-request) for the Family Greenhouse distribution.
//
// WHY THIS EXISTS
//
// The frontend bucket is private and served through Origin Access Control,
// which means CloudFront talks to the S3 REST API — not the S3 website
// endpoint. The REST API has no concept of a directory index: a request for
// `/pricing` asks for an object literally keyed `pricing`, which does not
// exist, so S3 answers 403 (a private bucket returns AccessDenied rather than
// NoSuchKey) and the distribution's custom_error_response serves the SPA shell.
//
// `default_root_object` does NOT fill this gap. It only rewrites the bare `/`.
//
// So without this function, prerendering the marketing routes would be
// pointless: `frontend/scripts/prerender.mjs` would write
// dist/pricing/index.html, the deploy would upload it, and CloudFront would
// never once serve it. The empty JavaScript shell would keep going out to every
// crawler and every social unfurler, and the change would look complete.
//
// WHAT IT DOES
//
// Maps a clean URL onto the prerendered object:
//   /                 -> /index.html                 (the prerendered homepage)
//   /pricing          -> /pricing/index.html
//   /care/monstera/   -> /care/monstera/index.html
//   /assets/app.js    -> unchanged (has an extension)
//   /brand/icon.svg   -> unchanged
//   /dashboard        -> /dashboard/index.html, which does not exist; S3 403s
//                        and the distribution falls back to /app-shell.html,
//                        the empty SPA shell. Unknown paths keep working
//                        exactly as they did before prerendering existed.
//
// The extension test looks only at the LAST path segment, so a directory with a
// dot in its name can't accidentally suppress the rewrite.
//
// Covered by frontend/scripts/spa-router.test.mjs — edit both together.

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  var lastSlash = uri.lastIndexOf('/');
  var lastSegment = uri.substring(lastSlash + 1);

  if (lastSegment === '') {
    // Ends in a slash (including the bare "/"): append the index document.
    request.uri = uri + 'index.html';
  } else if (lastSegment.indexOf('.') === -1) {
    // Extensionless: a route, not a file.
    request.uri = uri + '/index.html';
  }

  return request;
}
