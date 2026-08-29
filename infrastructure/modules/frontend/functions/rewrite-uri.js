/**
 * CloudFront viewer-request function: map a page URL onto the object that
 * holds it.
 *
 * The frontend bucket is a REST (OAC) origin, not an S3 website endpoint, so
 * it does no directory-index resolution. Without this, a request for
 * /care/pothos asks S3 for the key `care/pothos`, which does not exist; the
 * distribution's 403/404 handler then answers 200 with the SPA fallback. That
 * is why every public URL served the same shell, with the same title and no
 * <h1>, to any crawler that does not run JavaScript.
 *
 * The build writes one `<route>/index.html` per public route, so:
 *
 *   /                 -> /index.html          (the prerendered landing page)
 *   /care/            -> /care/index.html
 *   /care/pothos      -> /care/pothos/index.html
 *   /assets/app.4f.js -> unchanged (has an extension)
 *
 * A route with no prerendered page still 404s at S3 and still falls through to
 * the distribution's SPA fallback, exactly as it does today — the behavior for
 * /dashboard, /login and unknown URLs is unchanged.
 *
 * Written to the ES 5.1 core that cloudfront-js-2.0 guarantees. Its behavior
 * is pinned by frontend/tests/unit/config/cloudfrontRewriteUri.test.ts, which
 * runs this exact file.
 */
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.slice(-1) === '/') {
    request.uri = uri + 'index.html';
    return request;
  }

  var lastSegment = uri.slice(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = uri + '/index.html';
  }

  return request;
}
