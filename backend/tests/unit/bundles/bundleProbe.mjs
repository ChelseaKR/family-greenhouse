// Child process for lambdaBundles.test.ts. Imports ONE built Lambda bundle the
// way the Lambda runtime does (a fresh process, real ESM `import()`), so a
// bundle that only fails at load time — a package whose ESM build cannot be
// evaluated, a missing `require` — is caught here and not after a deploy.
//
//   node bundleProbe.mjs <bundle.mjs> load   exports a handler function
//   node bundleProbe.mjs <bundle.mjs> api    answers the first requests a page makes
//   node bundleProbe.mjs <bundle.mjs> plants presigns an upload URL
//
// The last two send real requests through the bundle's own AWS SDK code to a
// stand-in DynamoDB endpoint on localhost (AWS_ENDPOINT_URL_DYNAMODB), and
// report what that endpoint received, so a request that never got serialized
// or signed shows up as a missing row and not as a quiet pass.
import http from 'node:http';

const [file, mode] = process.argv.slice(2);
const seen = [];
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const target = String(req.headers['x-amz-target'] ?? '');
    seen.push({
      target,
      signed: String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256'),
    });
    res.setHeader('content-type', 'application/x-amz-json-1.0');
    if (target.endsWith('.GetItem')) {
      // Enough of a household member row for the auth middleware to let the
      // caller through; every other operation returns an empty result.
      res.end(
        JSON.stringify({
          Item: {
            PK: { S: 'HOUSEHOLD#h1' },
            SK: { S: 'MEMBER#u1' },
            role: { S: 'admin' },
            userId: { S: 'u1' },
            householdId: { S: 'h1' },
            name: { S: 'Pat' },
          },
        })
      );
    } else if (target.endsWith('.Query')) {
      res.end('{"Items":[],"Count":0}');
    } else {
      res.end('{}');
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.AWS_ENDPOINT_URL_DYNAMODB = `http://127.0.0.1:${server.address().port}`;

const mod = await import(new URL(file, 'file://').href);
const result = { handlerType: typeof mod.handler };

if (mode !== 'load') {
  const context = { awsRequestId: 'r', functionName: 'f', getRemainingTimeInMillis: () => 30000 };
  const event = (routeKey, extra = {}) => ({
    version: '2.0',
    routeKey,
    rawPath: routeKey.split(' ')[1],
    // A `content-type: application/json` with no body is a 422 from the body
    // parser, so only the requests that carry a body say they are JSON.
    headers: {
      origin: 'https://familygreenhouse.net',
      ...(extra.body ? { 'content-type': 'application/json' } : {}),
    },
    requestContext: {
      authorizer: {
        jwt: { claims: { sub: 'u1', email: 'a@b.c', 'custom:household_id': 'h1' } },
      },
      http: { method: routeKey.split(' ')[0], sourceIp: '1.2.3.4', path: '/' },
      requestId: 'rid',
      stage: 'production',
    },
    isBase64Encoded: false,
    ...extra,
  });
  const answer = async (ev) => {
    const r = await mod.handler(ev, context);
    return { status: r.statusCode, headers: r.headers ?? {}, body: r.body };
  };
  if (mode === 'api') {
    result.warmer = (await answer({ warmer: true })).status;
    const preflight = await answer(event('OPTIONS /{proxy+}'));
    result.preflight = {
      status: preflight.status,
      allowOrigin: preflight.headers['Access-Control-Allow-Origin'],
    };
    const health = await answer(event('GET /health'));
    result.health = { status: health.status, body: JSON.parse(health.body) };
  } else if (mode === 'plants') {
    const upload = await answer(
      event('POST /plants/{id}/image', {
        pathParameters: { id: 'p1' },
        body: JSON.stringify({ contentType: 'image/jpeg', sizeBytes: 1000 }),
      })
    );
    const parsed = JSON.parse(upload.body);
    result.upload = { status: upload.status, uploadUrl: parsed.uploadUrl };
  }
  result.seen = seen;
}
console.log(`@@RESULT@@${JSON.stringify(result)}`);
server.close();
process.exit(0);
