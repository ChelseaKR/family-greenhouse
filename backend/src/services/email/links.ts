/**
 * The one place an email builds a URL.
 *
 * Every outbound email links somewhere, and before this file each composer
 * hand-rolled `${base}/plants/...` with its own trailing-slash and encoding
 * rules (see the pre-existing `frontendUrl` in services/reminders.ts and the
 * `base` local in services/welcomeEmail.ts). With fifteen more notification
 * emails on the way, one builder is the difference between "every email deep
 * links correctly" and "most of them do".
 *
 * Two rules this module exists to enforce:
 *
 *   1. **Deep, not shallow.** A plant named in an email links to THAT plant,
 *      not to the dashboard. The one place we cannot go deeper than the
 *      plant is an individual task: the SPA has no `/tasks/:id` route
 *      (`frontend/src/App.tsx`), so `taskUrl` lands on the task's plant and
 *      carries `?task=` as a forward hook the plant page can honour later
 *      without any email changing.
 *
 *   2. **Our own origins only.** `safeLinkUrl` rejects anything that is not
 *      http(s)/mailto, and `isOwnAssetUrl` rejects any image that is not
 *      served from our own asset origin. Remote images in email are a
 *      tracking and spoofing surface; ADR 0021 commits to loading none.
 */

/** Base URL of the web app, no trailing slash. Mirrors the FRONTEND_URL
 *  policy already used by the invite, share, checkout and reminder builders. */
export function appBaseUrl(): string {
  const raw = process.env.FRONTEND_URL?.trim() || 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

/** Base URL plant photos are served under (CloudFront `/plants/*` behaviour).
 *  Falls back to the app origin, which is the same host in every deployed
 *  environment today. */
export function assetBaseUrl(): string {
  const raw = process.env.ASSETS_BASE_URL?.trim() || appBaseUrl();
  return raw.replace(/\/+$/, '');
}

/**
 * Base URL of the API — where capability URLs (one-click unsubscribe) live,
 * because they must resolve with no session and the SPA origin would
 * SPA-404 them.
 *
 * Returns null when `PUBLIC_API_URL` is unset outside local dev. That is
 * deliberate rather than a guessed origin: an unsubscribe link that 404s is
 * worse for deliverability than no `List-Unsubscribe` header at all, so the
 * caller omits both and logs, instead of shipping a link we know is wrong.
 */
export function apiBaseUrl(): string | null {
  const raw = process.env.PUBLIC_API_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return process.env.NODE_ENV === 'production' ? null : 'http://localhost:4000';
}

function join(base: string, path: string): string {
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function appUrl(path: string): string {
  return join(appBaseUrl(), path);
}

/** Deep link to one plant's detail page. */
export function plantUrl(plantId: string): string {
  return appUrl(`/plants/${encodeURIComponent(plantId)}`);
}

/**
 * Deep link for a task. The SPA has no per-task route, so this resolves to
 * the task's plant — the closest thing to "that exact task" that exists —
 * with the task id in the query string. Callers must pass the plant id; a
 * task link that could only reach `/tasks` would be the shallow link this
 * module exists to stop.
 */
export function taskUrl(plantId: string, taskId: string): string {
  return `${plantUrl(plantId)}?task=${encodeURIComponent(taskId)}`;
}

/** The household task list, filtered to what is due. */
export function tasksUrl(): string {
  return appUrl('/tasks?filter=due');
}

export function settingsUrl(): string {
  return appUrl('/settings');
}

export function analyticsUrl(): string {
  return appUrl('/analytics');
}

/** Revocable capability URL for one-click unsubscribe, or null when the API
 *  base is not configured (see `apiBaseUrl`). */
export function unsubscribeUrl(token: string): string | null {
  const base = apiBaseUrl();
  if (!base) return null;
  return `${base}/notifications/email/unsubscribe?t=${encodeURIComponent(token)}`;
}

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Return `url` when it is a scheme we are willing to put behind an `<a>`, and
 * `null` otherwise. Returning null (rather than throwing) is deliberate: a bad
 * href must degrade one row to unlinked text, never abort a household's whole
 * digest. The renderer drops the anchor when this returns null.
 */
export function safeLinkUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return LINK_SCHEMES.has(parsed.protocol) ? url : null;
  } catch {
    // Not a parseable absolute URL — not a failed read, just not a link.
    return null;
  }
}

/**
 * True only when `url` is an image served from our own asset origin.
 *
 * ADR 0021 commits to loading no remote images in email. Plant photos qualify
 * because they are minted by `handlers/plants` under `ASSETS_BASE_URL` and
 * served by our own CloudFront distribution; anything else — a pasted URL, a
 * legacy direct-to-S3 link, an attacker-controlled host — does not, and the
 * renderer silently omits the image rather than fetching it.
 */
export function isOwnAssetUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(assetBaseUrl());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.origin !== base.origin) return false;
  // The asset base may carry a path prefix; require the URL to sit under it.
  const prefix = base.pathname.replace(/\/+$/, '');
  return parsed.pathname.startsWith(`${prefix}/`);
}
