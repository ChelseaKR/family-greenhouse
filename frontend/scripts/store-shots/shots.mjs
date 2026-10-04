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
    // Overdue work nobody has claimed, marked "Up for grabs".
    name: '05-tasks',
    step: { go: '/tasks', path: '^/tasks$', waitText: 'Up for grabs' },
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
 * What the demo household has done before the frames are taken, through the
 * same API the app calls: Dana shares a plant-sitter link for a long weekend,
 * which the sitter frame opens. Returns what the steps need (the link's token).
 */
export async function setUpDemoHousehold(api, session) {
  if (!session?.idToken) throw new Error('No demo session to set up the household with.');
  const headers = {
    Authorization: `Bearer ${session.idToken}`,
    'Content-Type': 'application/json',
  };
  const household = session.user.householdId;
  const day = 24 * 60 * 60 * 1000;
  const call = async (method, url, body) => {
    const res = await fetch(`${api}${url}`, {
      method,
      headers,
      body: body && JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };

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
