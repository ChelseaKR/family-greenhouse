/**
 * The App Store shot list for the iPhone app (capture-ios.mjs), in listing
 * order. Each frame is the real app signed in to the store-demo household
 * (backend/src/local-server-store-demo.ts): The Fernwood House, Dana
 * Whitfield, Marisol Reyes and Theo Nakamura, eight plants in five rooms, on
 * the free Seedling plan so no frame can show a price or an upgrade prompt.
 *
 * A step can: `go` to a route (the native tab bar and navigation bar follow it,
 * as they do for a tap), `tap` a link by text, wait for `path` and
 * `waitText`, and `scrollTo` a heading. The file name is the frame name.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The demo sign-in. Invented, and @example.com can never be registered. */
export const DEMO = { email: 'dana@example.com', password: 'password123' };

export const SHOTS = [
  {
    // The Plants tab: the large title, its native bar buttons and the search
    // field, and the list led by what needs care today.
    name: '01-plants',
    step: { go: '/plants', path: '^/plants$', waitText: 'Monstera' },
  },
  {
    // Home, opened from the tab after Plants.
    name: '02-home',
    step: { go: '/dashboard', path: '^/dashboard$', waitText: 'Up for grabs' },
  },
  {
    // A plant, opened from the list: the back chevron, the ⋯ menu, and the
    // status card with what it needs now and who has it.
    name: '03-plant-detail',
    step: {
      go: '/plants',
      tap: { selector: 'a[href^="/plants/"]', text: 'Monstera' },
      path: '^/plants/[^/]+$',
      waitText: 'Monstera deliciosa',
    },
  },
  {
    // Further down the same page: the curated care tips and the plant's task.
    // The Monstera, because its curated note is about care. Most of the demo
    // species' notes are pet-toxicity warnings, and the listing makes no
    // pet-safety claims (store-assets/README.md).
    name: '04-plant-care',
    step: { scrollTo: { text: 'Caring for' }, scrollTop: false },
  },
  {
    // The Tasks checklist: Today first, overdue at the top, and who holds each.
    name: '05-tasks',
    step: { go: '/tasks', path: '^/tasks$', waitText: 'Peace Lily' },
  },
  {
    // Who did the care in the last 30 days and who holds what now.
    name: '06-household',
    step: { go: '/household', path: '^/household$', waitText: 'carrying the care' },
  },
  {
    // The page a plant-sitter link opens: no account, what needs doing, where.
    name: '07-sitter',
    step: (ctx) => ({ go: `/sit/${ctx.sitterToken}`, path: '^/sit/', waitText: 'Water the' }),
  },
  {
    // Settings > Notifications, with its on/off settings as switches.
    name: '08-notifications',
    step: { go: '/settings?section=notifications', path: 'section=notifications' },
  },
];

/**
 * Who adds each demo plant's photo: the member who added the plant in the
 * seed (`addedBy` in backend/src/local-server-store-demo.ts). Every member's
 * password is the demo one.
 */
const PHOTO_UPLOADERS = {
  Monstera: 'dana@example.com',
  'Fiddle Leaf Fig': 'marisol@example.com',
  'Golden Pothos': 'marisol@example.com',
  Aloe: 'dana@example.com',
  'Snake Plant': 'theo@example.com',
  'Peace Lily': 'marisol@example.com',
  'ZZ Plant': 'theo@example.com',
  'Jade Plant': 'dana@example.com',
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The plant photos, from store-assets/photo-credits.json: public-domain or
 * CC0 photographs from Wikimedia Commons, with the source, author and
 * license of each. Each file must still hash to what that record says, so a
 * photo cannot be swapped without its credit being updated too.
 */
function demoPhotos() {
  const credits = JSON.parse(
    readFileSync(path.join(repoRoot, 'store-assets', 'photo-credits.json'), 'utf8')
  );
  return credits.photos.map((photo) => {
    const bytes = readFileSync(path.join(repoRoot, photo.file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== photo.fileSha256) {
      throw new Error(
        `${photo.file} does not match its record in store-assets/photo-credits.json.`
      );
    }
    if (!PHOTO_UPLOADERS[photo.plant]) throw new Error(`No uploader for ${photo.plant}.`);
    return { ...photo, bytes };
  });
}

async function apiCall(api, token, method, url, body) {
  const res = await fetch(`${api}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/**
 * Each demo plant gets its photo the way a person adds one: signed in as the
 * member, ask the API for an upload URL, PUT the bytes there, and confirm.
 * The bytes are already what the app's own pipeline sends (at most 1600 px,
 * no metadata). A plant that already has a photo is left alone, so a re-run
 * against the same API adds nothing.
 */
async function addPlantPhotos(api) {
  const tokens = new Map();
  for (const photo of demoPhotos()) {
    const email = PHOTO_UPLOADERS[photo.plant];
    if (!tokens.has(email)) {
      const res = await fetch(`${api}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: DEMO.password }),
      });
      if (!res.ok) throw new Error(`Signing in as ${email}: ${res.status}`);
      tokens.set(email, (await res.json()).idToken);
    }
    const token = tokens.get(email);
    const plants = await apiCall(api, token, 'GET', '/plants');
    const plant = plants.find((p) => p.name === photo.plant);
    if (!plant) throw new Error(`The demo household has no plant named ${photo.plant}.`);
    if (plant.imageUrl) continue;
    const { uploadUrl, imageUrl } = await apiCall(api, token, 'POST', `/plants/${plant.id}/image`, {
      contentType: 'image/jpeg',
    });
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: photo.bytes,
    });
    if (!put.ok) throw new Error(`Uploading the ${photo.plant} photo: ${put.status}`);
    await apiCall(api, token, 'POST', `/plants/${plant.id}/image/confirm`, { imageUrl });
  }
}

/**
 * What the demo household has done before the frames are taken, through the
 * same API the app calls: each plant has a photo, added by the member who
 * added the plant, and Dana shares a plant-sitter link for a long weekend,
 * which the sitter frame opens. Returns what the steps need (the link's token).
 */
export async function setUpDemoHousehold(api, session) {
  if (!session?.idToken) throw new Error('No demo session to set up the household with.');
  const household = session.user.householdId;
  const day = 24 * 60 * 60 * 1000;
  const call = (method, url, body) => apiCall(api, session.idToken, method, url, body);

  await addPlantPhotos(api);

  // A sitter link for a long weekend. The token is shown only when a link is
  // made, so an existing demo link is revoked and made again.
  const existing = await call('GET', `/households/${household}/sitter-links`);
  for (const link of Array.isArray(existing) ? existing : (existing.links ?? [])) {
    if (link.label === 'Long weekend' && link.id && !link.revokedAt) {
      await call('DELETE', `/households/${household}/sitter-links/${link.id}`);
    }
  }
  const link = await call('POST', `/households/${household}/sitter-links`, {
    label: 'Long weekend',
    expiresAt: new Date(Date.now() + 4 * day).toISOString(),
  });
  return { sitterToken: link.token };
}
