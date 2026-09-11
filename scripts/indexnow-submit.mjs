#!/usr/bin/env node
/**
 * Tell the IndexNow search engines about every page in the live sitemap.
 *
 * ## Why this exists
 *
 * Bing Webmaster Tools reported zero pages indexed for familygreenhouse.net.
 * The sitemap and robots.txt were fine; nothing had ever told a search engine
 * they existed. IndexNow is the push protocol Bing, Yandex, Seznam, Naver and
 * others share: the site hosts a key file at its root, and one POST to
 * api.indexnow.org is forwarded to every participating engine. No account is
 * involved. Google does not take part — Search Console is handled by hand.
 *
 * ## What it does, in order, and why each step can stop the run
 *
 *   1. Finds the key: exactly one `frontend/public/<32 hex>.txt`, whose content
 *      is its own name and nothing else. The key file is the only place the key
 *      is written down, so nothing can drift from what is deployed.
 *   2. Fetches `<site>/<key>.txt` and requires a 200 whose body IS the key, at
 *      that URL and not behind a redirect. IndexNow proves ownership by fetching
 *      that URL, so submitting before it is live earns a 403 and tells every
 *      engine the key is bad. This is also the proof that the release carrying
 *      the key file has actually deployed.
 *   3. Fetches the LIVE sitemap and extracts every `<loc>`. Live rather than the
 *      committed file, because the point is to describe what is being served.
 *      It requires at least one URL — an empty list is not a submission, and
 *      reporting "submitted 0 URLs" as a success is this repository's named
 *      defect class — every URL https on the site's own host (IndexNow answers
 *      422 to anything else), and no more than the protocol's 10,000.
 *   4. POSTs `{host, key, keyLocation, urlList}` to api.indexnow.org. 200 and
 *      202 are success (202 is "received, key validation pending", which is
 *      normal for a first submission). Anything else fails, with the response
 *      body in the log.
 *   5. Writes what happened — status, URL count, key location — to
 *      `$GITHUB_STEP_SUMMARY` when that is set, on failure as well as success.
 *
 * `--dry-run` runs steps 1–3, prints the payload and does NOT post. The summary
 * says so, so a dry run cannot be mistaken for a submission.
 *
 * ## Where it runs
 *
 * `cd-production.yml`'s `indexnow` job, after the post-deploy smoke passes, and
 * `indexnow.yml` (workflow_dispatch only) for a submission by hand. In the
 * deploy it is advisory: nothing needs that job, and it is `continue-on-error`,
 * so a refused submission shows as a failed job on a green run and can neither
 * fail, delay nor roll back the release it follows. The job-graph half of that
 * promise is asserted in `scripts/indexnow-submit.test.mjs`.
 *
 * Zero dependencies — global `fetch`, no npm install — so the job is a checkout
 * plus one `node` invocation, with no AWS credentials and a read-only token.
 *
 * Usage:
 *   node scripts/indexnow-submit.mjs              # verify, then submit
 *   node scripts/indexnow-submit.mjs --dry-run    # verify and print, no POST
 */
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The production origin. Staging is not submitted: it is not a public site. */
export const SITE = 'https://familygreenhouse.net';

/** The shared endpoint; it forwards to every engine that participates. */
export const ENDPOINT = 'https://api.indexnow.org/indexnow';

/** Where Vite copies files unchanged to the site root (robots.txt lives here). */
export const PUBLIC_DIR = join(ROOT, 'frontend/public');

/** IndexNow's per-request limit. */
export const MAX_URLS = 10_000;

const KEY_FILE = /^([0-9a-f]{32})\.txt$/;
const TIMEOUT_MS = 30_000;
const USER_AGENT = 'family-greenhouse-indexnow (+https://familygreenhouse.net)';

/**
 * The one key file in `publicDir`, checked against its own name.
 *
 * Exactly one, because two key files would be two answers to "which key does
 * this site use", and a key file whose content is not its name would be served
 * at a URL IndexNow cannot verify.
 */
export function findKey(publicDir = PUBLIC_DIR) {
  const matches = readdirSync(publicDir).filter((name) => KEY_FILE.test(name));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one IndexNow key file (<32 hex>.txt) in ${publicDir}, found ${matches.length}` +
        (matches.length > 0 ? `: ${matches.join(', ')}` : '')
    );
  }
  const [file] = matches;
  const key = KEY_FILE.exec(file)[1];
  const content = readFileSync(join(publicDir, file), 'utf8');
  if (content !== key) {
    throw new Error(
      `${file} must contain exactly its own name (${key}) with no whitespace or newline; ` +
        `it contains ${JSON.stringify(content.slice(0, 80))}`
    );
  }
  return { key, file };
}

/** Where the key file is served. */
export function keyLocation(key, site = SITE) {
  return new URL(`/${key}.txt`, site).href;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Every `<loc>` in a sitemap, entity-decoded, in document order. */
export function extractLocs(xml) {
  const locs = [];
  for (const match of xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)) {
    locs.push(match[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name]));
  }
  return locs;
}

/**
 * Why this URL list cannot be submitted for `site`, as one line per problem.
 * Empty means it can.
 */
export function urlListFailures(urls, site = SITE) {
  const failures = [];
  if (urls.length === 0) {
    failures.push('the sitemap lists no URLs; there is nothing to submit');
  }
  if (urls.length > MAX_URLS) {
    failures.push(`the sitemap lists ${urls.length} URLs; IndexNow accepts at most ${MAX_URLS}`);
  }
  const { host } = new URL(site);
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      failures.push(`not a URL: ${JSON.stringify(url)}`);
      continue;
    }
    if (parsed.protocol !== 'https:' || parsed.host !== host) {
      failures.push(`not an https URL on ${host}: ${url}`);
    }
  }
  return failures;
}

/** The request body IndexNow expects. */
export function buildPayload({ key, urls, site = SITE }) {
  return {
    host: new URL(site).host,
    key,
    keyLocation: keyLocation(key, site),
    urlList: urls,
  };
}

/** 200 is "submitted"; 202 is "received, key validation pending". */
export function submissionAccepted(status) {
  return status === 200 || status === 202;
}

/** Markdown for the job summary. */
export function summary({ outcome, status, urlCount, location, detail }) {
  const lines = [
    '### IndexNow submission',
    '',
    `| | |`,
    `|---|---|`,
    `| Outcome | ${outcome} |`,
    `| Endpoint | ${ENDPOINT} |`,
    `| HTTP status | ${status ?? 'not sent'} |`,
    `| URLs | ${urlCount ?? 'none read'} |`,
    `| Key location | ${location ?? 'unknown'} |`,
  ];
  if (detail) lines.push('', detail);
  return `${lines.join('\n')}\n`;
}

/** An error's message plus the network cause `fetch` hides behind "fetch failed". */
function describe(error) {
  const cause = error?.cause?.code ?? error?.cause?.message;
  return `${error?.message ?? String(error)}${cause ? ` (${cause})` : ''}`;
}

function request(fetchImpl, url, init = {}) {
  return fetchImpl(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...init.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * A GET, retried once after a network error (never after an HTTP status: a 404
 * is an answer). One blip on a runner should not cost a release its
 * submission; two in a row is worth reporting.
 */
async function get(fetchImpl, url, retryDelayMs) {
  try {
    return await request(fetchImpl, url);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return request(fetchImpl, url);
  }
}

/**
 * Run the submission. Returns an exit code rather than exiting, so the tests
 * can drive it with a fake `fetch` and a temporary key directory.
 */
export async function main(
  argv,
  {
    fetchImpl = globalThis.fetch,
    env = process.env,
    publicDir = PUBLIC_DIR,
    site = SITE,
    retryDelayMs = 5_000,
    log = console.log,
  } = {}
) {
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(' ')}`);
  const dryRun = argv.includes('--dry-run');

  const report = (fields) => {
    const text = summary(fields);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    log(text);
  };
  const fail = (fields) => {
    report({ outcome: 'FAILED — nothing was submitted', ...fields });
    return 1;
  };

  // 1. The key, from the one file that holds it.
  let key;
  try {
    ({ key } = findKey(publicDir));
  } catch (error) {
    return fail({ detail: error.message });
  }
  const location = keyLocation(key, site);

  // 2. The key file must be live, at that URL, saying exactly that.
  try {
    const response = await get(fetchImpl, location, retryDelayMs);
    const body = await response.text();
    const redirected = Boolean(response.url) && response.url !== location;
    if (response.status !== 200 || body !== key || redirected) {
      const why = [];
      if (response.status !== 200) why.push(`HTTP ${response.status}`);
      if (redirected) why.push(`a redirect to ${response.url}`);
      if (body !== key) why.push('a body that is not the key');
      return fail({
        location,
        detail:
          `${location} answered with ${why.join(', ')}, so IndexNow would reject the ` +
          'submission. A release carrying the key file has to be deployed first.',
      });
    }
  } catch (error) {
    return fail({ location, detail: `fetching ${location} failed: ${describe(error)}` });
  }

  // 3. The pages, from the sitemap production is serving now.
  const sitemapUrl = new URL('/sitemap.xml', site).href;
  let urls;
  try {
    const response = await get(fetchImpl, sitemapUrl, retryDelayMs);
    if (response.status !== 200) {
      return fail({ location, detail: `${sitemapUrl} answered HTTP ${response.status}` });
    }
    urls = extractLocs(await response.text());
  } catch (error) {
    return fail({ location, detail: `fetching ${sitemapUrl} failed: ${describe(error)}` });
  }
  const problems = urlListFailures(urls, site);
  if (problems.length > 0) {
    return fail({ location, urlCount: urls.length, detail: problems.join('\n') });
  }

  const payload = buildPayload({ key, urls, site });

  if (dryRun) {
    log(JSON.stringify(payload, null, 2));
    report({
      outcome: 'DRY RUN — key file and sitemap verified, nothing was submitted',
      urlCount: urls.length,
      location,
    });
    return 0;
  }

  // 4. Submit.
  let status;
  let responseBody;
  try {
    // Not retried: a POST that timed out may still have landed, and the next
    // release (or a run of indexnow.yml) resubmits the whole sitemap anyway.
    const response = await request(fetchImpl, ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
    status = response.status;
    responseBody = (await response.text()).slice(0, 500);
  } catch (error) {
    // Not "nothing was submitted": a request that timed out may have landed.
    report({
      outcome: 'FAILED — the POST did not complete, so whether it landed is unknown',
      status: 'no response',
      urlCount: urls.length,
      location,
      detail: `POST ${ENDPOINT} failed: ${describe(error)}`,
    });
    return 1;
  }

  if (!submissionAccepted(status)) {
    report({
      outcome: 'REFUSED',
      status,
      urlCount: urls.length,
      location,
      detail: `IndexNow answered HTTP ${status}${responseBody ? `: ${responseBody}` : ''}`,
    });
    return 1;
  }

  report({
    outcome: status === 202 ? 'ACCEPTED — key validation pending' : 'SUBMITTED',
    status,
    urlCount: urls.length,
    location,
  });
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
