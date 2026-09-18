// CloudFront Function (viewer-request) for the `www.` redirect distribution.
//
// Every request, over either scheme, is answered here with one 301 to
// https://<apex><path><query>. It never reaches an origin.
//
// WHY `www.` REDIRECTS AT ALL (issue #760). `www.<domain>` and the apex used
// to answer 200 with identical content, and Google treated them as two sites.
// Search Console, 2026-09-11, over the preceding three months: 7 paths indexed
// ONLY under `www.`, 15 ONLY under the apex, 0 under both — one site's ranking
// signal split across two hostnames, with the `www.` half at average position
// 55-75 while the apex homepage sat at 6.2. Every page already carried an
// apex self-canonical, and that was not enough: a canonical is a hint, a 301 is
// not.
//
// WHY IT HAS ITS OWN DISTRIBUTION (issue #797). The redirect used to be rule 0
// of spa-router.js on the main distribution. That distribution's
// `viewer_protocol_policy = "redirect-to-https"` answers a plain-HTTP request
// itself, before any function runs, so http://www took two hops: CloudFront to
// https://www, then rule 0 to the apex. This distribution is `allow-all`, so
// this function sees both schemes and one hop is all there is.
//
// WHY APEX IS SUBSTITUTED, NOT READ FROM `Host`. Terraform replaces the
// placeholder below with the apex (modules/frontend/main.tf). Deriving it from
// the Host header would send a request that reached this distribution by its
// *.cloudfront.net name to a mangled host — or, for a Host with no `www.` to
// strip, to itself, forever.
//
// Covered by frontend/scripts/www-redirect.test.mjs.

var APEX = '__APEX_DOMAIN__';

function handler(event) {
  var request = event.request;

  // Rebuild the querystring, every value of a repeated key included.
  var qs = '';
  for (var key in request.querystring) {
    var param = request.querystring[key];
    var values = param.multiValue || [param];
    for (var i = 0; i < values.length; i++) {
      qs += (qs ? '&' : '?') + key;
      if (values[i].value) qs += '=' + values[i].value;
    }
  }

  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: { location: { value: 'https://' + APEX + request.uri + qs } },
  };
}
