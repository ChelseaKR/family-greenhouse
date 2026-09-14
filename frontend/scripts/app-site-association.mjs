/**
 * The iOS universal-link claim: which URLs on familygreenhouse.net the app is
 * allowed to open instead of Safari, derived from the route table React Router
 * actually matches.
 *
 * ## Why this is derived and not hand-written
 *
 * `frontend/public/.well-known/apple-app-site-association` is a second copy of
 * the route table. Every second copy in this repository has drifted: the
 * CloudFront function's route map (#615, #719), the sitemap, the billing email
 * that pointed at `/settings/notifications` for months (#721). The AASA file
 * drifts in the two directions that both cost a customer and neither of which
 * reports an error:
 *
 *   - **A claimed path the app no longer routes.** iOS opens the app, the app
 *     renders "Nothing growing here", and the link the user tapped — a sitter
 *     invite, a caretaker report — is gone. Safari would have shown the same
 *     404, but at least the back button worked.
 *   - **A route added without a claim.** The link opens the browser and asks a
 *     signed-in user to sign in again. That is the status quo this file exists
 *     to end, re-created one route at a time.
 *
 * So the claim is not a list of paths. It is a decision *per declared route*,
 * in ROUTE_POLICY below, checked against `declaredRoutePaths()` on every gate
 * run: a route App.tsx declares and this file does not classify fails the
 * build. Adding a route to App.tsx forces someone to answer "does the app open
 * this?" rather than letting the answer default to "no, silently".
 *
 * ## Why some routes are deliberately NOT claimed
 *
 * A universal link is only honoured for a device that has the app installed —
 * but the AASA file is also what tells iOS to *stop* handing the URL to
 * Safari. So every URL a person might reach before they have an account, or
 * while they cannot sign in, has to stay a web page:
 *
 *   - **Marketing and content** (`/`, `/pricing`, `/blog`, `/care`, `/help`,
 *     `/pet-safe`, `/changelog`, `/support`, `/status`, `/legal/*`). These are
 *     the prerendered pages; they are the reason the site ranks at all, and
 *     they must render for someone who has never installed anything.
 *   - **Email-link auth** (`/login`, `/register`, `/confirm-email`,
 *     `/reset-password`, `/forgot-password`, `/welcome`). A confirmation link
 *     is followed once, often on a device where the app is not yet installed
 *     or not yet signed in. Opening a cold app on a token URL is how those
 *     tokens get burned.
 *   - **`/account-deletion`.** This one is not a judgement call. App Review
 *     checks that account deletion is reachable, and a deletion route that
 *     opens the app strands the one person who most needs it: someone who
 *     cannot sign in and wants their data gone. It stays browser-reachable.
 *
 * `ROUTE_POLICY` records that decision next to the route, and the gate proves
 * no component pattern matches any of them — which is the assertion that
 * matters, because `/account` and `/account-deletion` are one wildcard apart.
 *
 * ## What the `components` format means, and the one thing Apple is vague about
 *
 * This is Apple's modern AASA shape (`appIDs` + `components`), not the legacy
 * `appID` + `paths` array. A component's `/` value is matched against the
 * WHOLE URL path, not a prefix — so `/account` claims `/account` and nothing
 * else, and `/account-deletion` is not a match. That part is unambiguous, and
 * it is the part App Review depends on.
 *
 * What Apple does not say clearly is whether `*` crosses a `/`. The two
 * primary sources disagree in tone:
 *
 *   - The documentation's own example comments read as prefix matching:
 *     `{"/": "/buy/*"}` is annotated "Matches any URL whose path starts with
 *     /buy/", which only reads naturally if `*` absorbs the remaining
 *     segments.
 *   - WWDC19 session 717, introducing `components`, says "pattern matching is
 *     performed the same way it is in terminal" — and in shell pathname
 *     globbing `*` does NOT cross `/`.
 *
 * So the semantics are treated here the CONSERVATIVE way: **`*` matches
 * within one path segment and never crosses `/`** — the same rule React
 * Router's `:param` follows, and the same rule `spa-router.js`'s
 * `isAppRoute()` already implements for this repository's own edge function.
 *
 * That choice is not a guess about Apple; it is a choice that is correct under
 * BOTH readings. A file built segment-wise claims every URL it needs to claim
 * whichever rule iOS applies, because the extra components it emits are
 * supersets nothing else depends on. A file built on the permissive reading is
 * correct only if the permissive reading is true, and its failure mode is a
 * link that silently opens Safari — undetectable from the server.
 *
 * The one visible consequence: `/sit/:token/brief` needs a component of its
 * own — a wildcard segment followed by the literal `brief`. It is NOT covered
 * by the `/sit/` wildcard that claims `/sit/:token`, because `brief` is a
 * second segment. By contrast
 * `/plants/new`, `/plants/import` and `/household/caretaker-report` each sit
 * exactly one segment below a claimed prefix, so `/plants/*` and
 * `/household/*` cover them under either reading and are not restated.
 * `componentPatterns()` computes that distinction rather than asserting it in
 * a comment, and `app-site-association.test.mjs` pins the matcher.
 *
 * ## The Team ID
 *
 * An `appID` is `<Team ID>.<bundle id>` — Apple's order, team first; see
 * TEAM_ID. The Team ID is issued when a Developer Program enrollment is
 * approved, and `scripts/check-well-known.mjs` — a step of `npm run verify`
 * and of CI's Lint job — refuses to let the file ship with anything that is
 * not one: the `TEAM_ID_PLACEHOLDER` sentinel, an empty or missing appID, or
 * a value that is not ten uppercase alphanumerics. A wrong Team ID publishes a
 * file that parses, deploys, caches, and is fetched successfully by Apple
 * while every universal link silently keeps opening Safari — the "absence
 * rendered as a value" defect at the one layer where the symptom arrives weeks
 * later, on someone else's device, with no server-side trace.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { declaredRoutePaths, sampleUrlFor } from './app-routes.mjs';
import { FRONTEND_ROOT } from './public-routes.mjs';

/** The app's bundle identifier, on both platforms. See docs/mobile.md. */
export const BUNDLE_ID = 'net.familygreenhouse.app';

/**
 * The Apple Developer Team ID, from Apple Developer → Membership → Team ID.
 *
 * It is not a secret — it is published, by design, in this very file, which is
 * world-readable at https://familygreenhouse.net/.well-known/apple-app-site-association
 * and is fetched by Apple's CDN. It is also not an Enrollment ID: that is the
 * different, similar-looking number shown while an application is pending, and
 * a file carrying one would parse, deploy, and fail verification in silence.
 */
export const TEAM_ID = '6X5YH93QNM';

/**
 * The sentinel a Team ID must never be. Deliberately not a plausible Team ID —
 * a real one is exactly ten uppercase alphanumerics — so it cannot be mistaken
 * for one by a human or by TEAM_ID_PATTERN. Kept, and kept gated, now that the
 * real value exists: the failure it guards against is a FUTURE placeholder,
 * pasted in by someone standing up a second app or a staging domain, and that
 * is exactly when a sentinel gets committed and forgotten.
 */
export const TEAM_ID_PLACEHOLDER = 'TEAMID_PENDING';

/**
 * The Enrollment ID for this account — the one wrong value that is NOT caught
 * by shape.
 *
 * Apple shows an Enrollment ID while a Developer Program application is
 * pending, and issues the Team ID when it is approved. Both are ten uppercase
 * alphanumerics, so `TEAM_ID_PATTERN` accepts both, and both are shown in the
 * same corner of the same portal, months apart, to the same person. The
 * comments around this gate used to claim the shape check caught the
 * Enrollment ID; it does not, and it cannot — that is a statement about a
 * regex that admits 36^10 values, one of which is on file.
 *
 * Publishing the Enrollment ID is the most expensive defect this file can
 * carry, and the quietest: the JSON parses, the deploy uploads it, S3 serves
 * `application/json`, Apple's CDN fetches it with a 200 — and every universal
 * link keeps opening Safari, with no server-side trace, on someone else's
 * device, weeks later.
 *
 * So the specific known-wrong value is named here and refused by value rather
 * than by shape. This is not a secret (neither ID is), and it is not a guess
 * about which ID is right — it is the one substitution this repository has
 * enough information to rule out.
 */
export const ENROLLMENT_ID = 'ACKGM9XK9V';

/** The shape Apple issues: ten characters, uppercase letters and digits. */
export const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;

/**
 * Why `teamId` cannot be published, or `null` if it can.
 *
 * Shared by the generator (so `npm run aasa` refuses to WRITE a bad file) and
 * by `scripts/check-well-known.mjs` (so a file already on disk is refused
 * before it ships). One predicate, two callers: a second copy of this rule is
 * how the two ends drift into disagreeing about what is publishable.
 */
export function teamIdProblem(teamId) {
  if (teamId === TEAM_ID_PLACEHOLDER) {
    return `it is the placeholder sentinel \`${TEAM_ID_PLACEHOLDER}\``;
  }
  if (teamId === ENROLLMENT_ID) {
    return (
      `\`${ENROLLMENT_ID}\` is this account's ENROLLMENT ID, not its Team ID — and being ` +
      'exactly ten uppercase alphanumerics, it passes every shape check'
    );
  }
  if (!TEAM_ID_PATTERN.test(teamId)) {
    return `\`${teamId}\` is not ${TEAM_ID_PATTERN.source}`;
  }
  return null;
}

/** Where the association file is committed, to be copied into `dist/`. */
export const ASSOCIATION_PATH = join(
  FRONTEND_ROOT,
  'public',
  '.well-known',
  'apple-app-site-association'
);

/**
 * Every route `App.tsx` declares, and whether the iOS app claims it.
 *
 *   `'app'`         — the app opens exactly this path.
 *   `'app-subtree'` — the app opens this path and everything under it.
 *   `'web'`         — stays in the browser; the app must NOT claim it.
 *
 * `*` (React Router's catch-all) is not listed: it is not a URL, and claiming
 * it would claim the whole domain. `assertPolicyCoversRoutes()` fails if
 * App.tsx declares anything else this map does not classify.
 */
export const ROUTE_POLICY = {
  // --- public web: marketing, content, and the pages that must render for
  // --- someone who has never installed the app ------------------------------
  '/': 'web',
  '/blog': 'web',
  '/blog/:slug': 'web',
  '/care': 'web',
  '/care/:slug': 'web',
  '/changelog': 'web',
  '/help': 'web',
  '/help/:topicId': 'web',
  '/legal/privacy': 'web',
  '/legal/terms': 'web',
  '/pet-safe': 'web',
  // One public page per plant in the curated pet-toxicity table. Content, found
  // by search, read by people who do not have the app: never claimed.
  '/pet-safe/:slug': 'web',
  '/pricing': 'web',
  '/status': 'web',
  '/support': 'web',

  // --- public web: entry points reached from an email, on a device that may
  // --- not have the app, or by someone who cannot sign in -------------------
  '/account-deletion': 'web', // App Review reads this one; see the header.
  '/confirm-email': 'web',
  '/forgot-password': 'web',
  '/login': 'web',
  '/register': 'web',
  '/reset-password': 'web',
  '/welcome': 'web',

  // --- the signed-in app ----------------------------------------------------
  '/account': 'app',
  '/analytics': 'app',
  '/away-recap': 'app',
  '/chat': 'app',
  '/dashboard': 'app',
  '/household': 'app-subtree',
  '/household/caretaker-report': 'app',
  '/onboarding': 'app',
  '/plants': 'app-subtree',
  '/plants/:plantId': 'app',
  '/plants/import': 'app',
  '/plants/new': 'app',
  '/settings': 'app-subtree',
  '/settings/billing': 'app',
  '/tags': 'app',
  '/tasks': 'app',
  '/today': 'app',

  // --- shared/token links: the whole reason this file exists. Every one of
  // --- these arrives by email or by being handed to someone ------------------
  '/caretaker/:token': 'app',
  '/join/:inviteCode': 'app',
  '/kiosk/:token': 'app',
  '/shared/:code': 'app',
  // NOT a subtree: `*` is treated as segment-wise (see the header), so
  // `/sit/*` does not reach `/sit/<token>/brief` and the brief route claims
  // itself. Claiming the subtree instead would hand the app every URL under
  // a sitter token, including ones it 404s.
  '/sit/:token': 'app',
  '/sit/:token/brief': 'app',
  '/tag/:token': 'app',
};

/** React Router's catch-all. Not a URL, never classified, never claimed. */
const CATCH_ALL = '*';

/**
 * Does `path` match an AASA component pattern? Apple's semantics, whole-path:
 * `*` is zero or more characters including `/`, `?` is exactly one character.
 */
export function matchesComponent(pattern, path) {
  let source = '^';
  for (const character of pattern) {
    if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`).test(path);
}

/** A route path as an AASA pattern: every `:param` becomes one `*`. */
function patternFor(route) {
  return route.replace(/:[^/]+/g, '*');
}

/**
 * Fails if App.tsx and ROUTE_POLICY disagree about what the routes are.
 *
 * The direction that costs a customer is a NEW route nobody classified — it
 * silently defaults to "browser", which is the behaviour this whole file
 * exists to replace. The other direction (a policy entry for a route that is
 * gone) leaves a claim pointing at nothing. Both are refused.
 */
export function assertPolicyCoversRoutes(declared = declaredRoutePaths()) {
  const routes = declared.filter((route) => route !== CATCH_ALL);
  const classified = Object.keys(ROUTE_POLICY);

  const unclassified = routes.filter((route) => !(route in ROUTE_POLICY));
  if (unclassified.length > 0) {
    throw new Error(
      `App.tsx declares ${unclassified.join(', ')}, which ROUTE_POLICY in ` +
        'frontend/scripts/app-site-association.mjs does not classify. Every route has to say ' +
        "whether the iOS app opens it ('app'/'app-subtree') or it stays in the browser " +
        "('web'), because the default is silent: an unclassified route is simply not in the " +
        'association file, and its links keep opening Safari and asking a signed-in user to ' +
        'sign in again.'
    );
  }

  const stale = classified.filter((route) => !routes.includes(route));
  if (stale.length > 0) {
    throw new Error(
      `ROUTE_POLICY classifies ${stale.join(', ')}, which App.tsx no longer declares. A claim ` +
        'on a path the app does not route opens the app onto "Nothing growing here" — the ' +
        'browser would at least have had a back button. Drop the entry.'
    );
  }

  const bad = classified.filter(
    (route) => !['app', 'app-subtree', 'web'].includes(ROUTE_POLICY[route])
  );
  if (bad.length > 0) {
    throw new Error(
      `ROUTE_POLICY gives ${bad.join(', ')} a value that is not 'app', 'app-subtree' or 'web'.`
    );
  }

  return routes;
}

/** The routes the app claims, and the routes that stay in the browser. */
export function partitionRoutes(declared = declaredRoutePaths()) {
  const routes = assertPolicyCoversRoutes(declared);
  return {
    claimed: routes.filter((route) => ROUTE_POLICY[route] !== 'web'),
    web: routes.filter((route) => ROUTE_POLICY[route] === 'web'),
  };
}

/**
 * The component patterns, minimised.
 *
 * `app-subtree` contributes two patterns — the path itself and `path/*` —
 * because `/plants` and `/plants/import` are different strings and the first
 * pattern does not cover the second. Everything else contributes one. Then any
 * pattern another pattern already matches is dropped: `/plants/*` covers
 * `/plants/new`, `/plants/import` and `/plants/<id>`, so emitting those three
 * as well would be three more lines saying nothing, and three more lines to
 * keep in step with App.tsx. The minimisation is computed, not asserted in a
 * comment, so it stays true as routes move.
 */
export function componentPatterns(declared = declaredRoutePaths()) {
  const { claimed } = partitionRoutes(declared);

  const candidates = [];
  for (const route of claimed) {
    const pattern = patternFor(route);
    candidates.push(pattern);
    if (ROUTE_POLICY[route] === 'app-subtree') candidates.push(`${pattern}/*`);
  }

  const unique = [...new Set(candidates)];
  // Keep a pattern unless a DIFFERENT pattern matches it and it does not match
  // that one back. The mutual case (two patterns that match each other but are
  // not equal) keeps both rather than cancelling the pair to nothing.
  const kept = unique.filter(
    (pattern) =>
      !unique.some(
        (other) =>
          other !== pattern && matchesComponent(other, pattern) && !matchesComponent(pattern, other)
      )
  );
  return kept.sort();
}

/** Which claimed routes a pattern is carrying, for its `comment`. */
function routesCoveredBy(pattern, claimed) {
  return claimed.filter((route) => matchesComponent(pattern, sampleUrlFor(route)));
}

/**
 * The association document, as the object that gets serialised.
 *
 * `applinks` only. `webcredentials` (shared-password autofill) and `appclips`
 * need the same Team ID and a matching entitlement, and neither is built — a
 * declaration without the app-side half is the "half a setup is worse than
 * none" failure docs/mobile.md is about.
 */
export function associationDocument(teamId = TEAM_ID, declared = declaredRoutePaths()) {
  // Refused at the point of WRITING, not only at the point of checking. The
  // committed file is byte-compared against this generator's output, so a bad
  // TEAM_ID edited in above would otherwise regenerate cleanly and leave every
  // gate green — which is exactly the shape of failure this file is about.
  const problem = teamIdProblem(teamId);
  if (problem !== null) {
    throw new Error(
      `Refusing to build an association file whose appID names ${teamId}: ${problem}. ` +
        'The real value is at Apple Developer → Membership → Team ID.'
    );
  }

  const { claimed } = partitionRoutes(declared);
  const patterns = componentPatterns(declared);

  return {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.${BUNDLE_ID}`],
          components: patterns.map((pattern) => ({
            '/': pattern,
            comment: `Opens ${routesCoveredBy(pattern, claimed).join(', ')} in the app.`,
          })),
        },
      ],
    },
  };
}

/** Exactly the bytes the committed file must contain. */
export function renderAssociation(teamId = TEAM_ID, declared = declaredRoutePaths()) {
  return `${JSON.stringify(associationDocument(teamId, declared), null, 2)}\n`;
}

/** The committed file's bytes, or `null` when it is not in the tree. */
export function committedAssociation() {
  try {
    return readFileSync(ASSOCIATION_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The Team ID the committed file declares, read out of its first `appID`.
 * Returns `null` if the file is absent or does not have the expected shape —
 * the caller reports that as its own problem.
 */
export function committedTeamId(source = committedAssociation()) {
  if (source === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const appIds = parsed?.applinks?.details?.[0]?.appIDs;
  if (!Array.isArray(appIds) || typeof appIds[0] !== 'string') return null;
  const [appId] = appIds;
  const dot = appId.indexOf('.');
  return dot === -1 ? null : appId.slice(0, dot);
}
