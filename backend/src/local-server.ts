// Development-only mock server. Express handlers here mix early-`return res.x()`
// with implicit-returning success paths, which trips `noImplicitReturns`.
// This file is never deployed (build pipeline uses esbuild on Lambda handlers),
// so suppress strict-mode return checks rather than rewriting every handler.
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

export const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// In-memory storage for local development
interface User {
  id: string;
  email: string;
  password: string;
  name: string;
  confirmed: boolean;
  /** Default household — kept on the JWT for backward compat. The first
   *  household the user joins becomes their default. */
  householdId: string | null;
  householdRole: 'admin' | 'member' | null;
  /** All households the user is a member of. Source of truth for the
   *  household-switcher; default `householdId` is just a convenience for
   *  clients that don't send `X-Household-Id`. */
  memberships: Array<{ householdId: string; role: 'admin' | 'member' }>;
}

interface Household {
  id: string;
  name: string;
  /** Optional saved location for climate-aware care tips. */
  location?: { city: string; lat: number; lon: number } | null;
  createdAt: string;
  createdBy: string;
  planId?: 'seedling' | 'garden' | 'greenhouse';
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  subscriptionStatus?: string;
}

interface Plant {
  id: string;
  householdId: string;
  name: string;
  species: string | null;
  location: string | null;
  imageUrl: string | null;
  notes: string | null;
  tags: string[];
  perenualSpeciesId: number | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

interface Task {
  id: string;
  householdId: string;
  plantId: string;
  type: string;
  customType: string | null;
  frequency: number;
  lastCompleted: string | null;
  nextDue: string;
  assignedTo: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

interface PushSubscriptionRecord {
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

interface NotificationPrefsRecord {
  userId: string;
  browser: boolean;
  email: boolean;
  sms: boolean;
  phone: string;
  dndStart: string;
  dndEnd: string;
  timezone: string;
  pestAlerts: boolean;
  updatedAt: string;
}

interface PlantPhoto {
  id: string;
  plantId: string;
  householdId: string;
  imageUrl: string;
  uploadedBy: string;
  uploadedAt: string;
  caption: string | null;
}

interface ActivityEvent {
  id: string;
  type:
    | 'task.completed'
    | 'plant.created'
    | 'plant.deleted'
    | 'photo.uploaded'
    | 'member.joined'
    | 'member.left';
  householdId: string;
  actorId: string;
  actorName: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

interface ApiKey {
  id: string;
  householdId: string;
  label: string;
  last4: string;
  /** Granted read scopes; mirrors backend `ApiKeyRecord.scopes`. */
  scopes: string[];
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
  /** Dev-only: store plaintext in-memory so the lookup endpoint can match
   *  it. Production hashes the key and never persists the plaintext. */
  plaintext: string;
}

/** Mirrors `apiKeys.API_SCOPES` in the backend service. */
const API_SCOPES = ['read:plants', 'read:tasks', 'read:activity'];

interface Completion {
  id: string;
  householdId: string;
  plantId: string;
  taskId: string;
  taskType: string;
  completedBy: string;
  completedByName: string;
  completedAt: string;
  notes: string | null;
}

export const db = {
  users: new Map<string, User>(),
  households: new Map<string, Household>(),
  householdMembers: new Map<string, { odId: string; role: 'admin' | 'member' }[]>(),
  plants: new Map<string, Plant>(),
  tasks: new Map<string, Task>(),
  completions: new Map<string, Completion>(),
  photos: new Map<string, PlantPhoto>(),
  apiKeys: new Map<string, ApiKey>(),
  activity: new Map<string, ActivityEvent>(),
  pushSubscriptions: new Map<string, PushSubscriptionRecord>(),
  notificationPrefs: new Map<string, NotificationPrefsRecord>(),
  pendingConfirmations: new Map<string, string>(), // email -> confirmation code
};

export const seedHouseholdId = '550e8400-e29b-41d4-a716-446655440001';
export const seedUserId = '550e8400-e29b-41d4-a716-446655440000';
export let seedPlantId = '';
export let seedTaskId = '';

export function resetDb(): void {
  db.users.clear();
  db.households.clear();
  db.householdMembers.clear();
  db.plants.clear();
  db.tasks.clear();
  db.completions.clear();
  db.photos.clear();
  db.apiKeys.clear();
  db.activity.clear();
  db.pushSubscriptions.clear();
  db.notificationPrefs.clear();
  db.pendingConfirmations.clear();

  db.users.set(seedUserId, {
    id: seedUserId,
    email: 'test@example.com',
    password: 'password123',
    name: 'Test User',
    confirmed: true,
    householdId: seedHouseholdId,
    householdRole: 'admin',
    memberships: [{ householdId: seedHouseholdId, role: 'admin' }],
  });

  db.households.set(seedHouseholdId, {
    id: seedHouseholdId,
    name: 'Test Household',
    createdAt: new Date().toISOString(),
    createdBy: seedUserId,
  });

  seedPlantId = uuidv4();
  db.plants.set(seedPlantId, {
    id: seedPlantId,
    householdId: seedHouseholdId,
    name: 'Monstera',
    species: 'Monstera deliciosa',
    location: 'Living Room',
    imageUrl: null,
    notes: 'Needs indirect light',
    tags: ['tropical'],
    perenualSpeciesId: null,
    createdAt: new Date().toISOString(),
    createdBy: seedUserId,
    updatedAt: new Date().toISOString(),
  });

  seedTaskId = uuidv4();
  db.tasks.set(seedTaskId, {
    id: seedTaskId,
    householdId: seedHouseholdId,
    plantId: seedPlantId,
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue: new Date().toISOString(),
    assignedTo: null,
    notes: null,
    createdBy: seedUserId,
    createdAt: new Date().toISOString(),
  });
}

resetDb();

// Helper to generate mock JWT
function generateToken(userId: string): string {
  return `mock-token-${userId}-${Date.now()}`;
}

// Helper to find user by email
function findUserByEmail(email: string): User | undefined {
  for (const user of db.users.values()) {
    if (user.email === email) return user;
  }
  return undefined;
}

// Auth middleware for protected routes
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  // Extract userId from mock token format: mock-token-{userId}-{timestamp}
  // userId is a UUID containing dashes, so rejoin the middle segments.
  const parts = token.split('-');
  if (parts.length < 4 || parts[0] !== 'mock' || parts[1] !== 'token') {
    return res.status(401).json({ message: 'Invalid token' });
  }

  const userId = parts.slice(2, -1).join('-');
  const user = db.users.get(userId);

  if (!user) {
    return res.status(401).json({ message: 'User not found' });
  }

  // X-Household-Id header pins a non-default household per request — mirrors
  // the production middleware behavior. Locally we can be more accurate
  // about role because we have direct access to the memberships array;
  // production downgrades to 'member' and lets handler-level lookups
  // upgrade after a DDB read.
  let householdId = user.householdId;
  let householdRole = user.householdRole;
  const override = req.headers['x-household-id'];
  if (typeof override === 'string' && override.length > 0) {
    householdId = override;
    const membership = user.memberships.find(
      (m: { householdId: string }) => m.householdId === override
    );
    householdRole = membership?.role ?? 'member';
  }

  (req as any).user = {
    userId: user.id,
    email: user.email,
    householdId,
    householdRole,
  };

  next();
}

// Helper for emitting activity events. Mirrors `services/activity.ts`.
function recordActivity(input: {
  type: ActivityEvent['type'];
  householdId: string;
  actorId: string;
  actorName: string;
  payload: Record<string, unknown>;
}): void {
  const id = uuidv4();
  db.activity.set(id, {
    id,
    type: input.type,
    householdId: input.householdId,
    actorId: input.actorId,
    actorName: input.actorName,
    occurredAt: new Date().toISOString(),
    payload: input.payload,
  });
}

// Health check
app.get('/health', (req, res) => {
  // Public health check used by load balancers AND the marketing /status
  // page. We surface a small set of subsystem checks so the status page
  // can show component-by-component state rather than just a binary.
  // Local server is in-memory, so the values are deterministic; in
  // production the same shape comes from real reachability probes
  // (handlers/health/handler.ts, hits DDB + Cognito with a 1s timeout).
  res.json({
    status: 'ok',
    version: process.env.APP_VERSION ?? 'dev',
    checkedAt: new Date().toISOString(),
    components: {
      database: { status: 'ok' },
      auth: { status: 'ok' },
      mail: { status: 'ok' },
    },
  });
});

// ============ AUTH ROUTES ============

app.post('/auth/signup', (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ message: 'Email, password, and name are required' });
  }

  if (findUserByEmail(email)) {
    return res.status(400).json({ message: 'User already exists' });
  }

  const userId = uuidv4();
  const confirmationCode = '123456'; // Fixed code for local dev

  db.users.set(userId, {
    id: userId,
    email,
    password,
    name,
    confirmed: false,
    householdId: null,
    householdRole: null,
    memberships: [],
  });

  db.pendingConfirmations.set(email, confirmationCode);

  console.log('\n========================================');
  console.log('NEW USER SIGNUP');
  console.log(`Email: ${email}`);
  console.log(`Confirmation Code: ${confirmationCode}`);
  console.log('========================================\n');

  res.status(201).json({
    message: 'User created. Check terminal for confirmation code.',
    userId,
  });
});

app.post('/auth/confirm', (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ message: 'Email and code are required' });
  }

  const user = findUserByEmail(email);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  if (user.confirmed) {
    return res.status(400).json({ message: 'User already confirmed' });
  }

  const pendingCode = db.pendingConfirmations.get(email);
  if (pendingCode !== code) {
    return res.status(400).json({ message: 'Invalid confirmation code' });
  }

  user.confirmed = true;
  db.pendingConfirmations.delete(email);

  console.log(`User ${email} confirmed successfully`);

  // Return tokens so user is automatically logged in
  const accessToken = generateToken(user.id);
  const refreshToken = generateToken(user.id);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      householdId: user.householdId,
      householdRole: user.householdRole,
    },
    accessToken,
    refreshToken,
  });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  const user = findUserByEmail(email);
  if (!user) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  if (!user.confirmed) {
    return res.status(401).json({ message: 'Email not confirmed' });
  }

  if (user.password !== password) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const accessToken = generateToken(user.id);
  const refreshToken = generateToken(user.id);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      householdId: user.householdId,
      householdRole: user.householdRole,
    },
    accessToken,
    refreshToken,
  });
});

app.post('/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ message: 'Refresh token required' });
  }

  // For local dev, just generate new tokens
  const parts = refreshToken.split('-');
  if (parts.length < 4 || parts[0] !== 'mock' || parts[1] !== 'token') {
    return res.status(401).json({ message: 'Invalid token' });
  }

  const userId = parts.slice(2, -1).join('-');
  const user = db.users.get(userId);

  if (!user) {
    return res.status(401).json({ message: 'User not found' });
  }

  res.json({
    accessToken: generateToken(user.id),
    refreshToken: generateToken(user.id),
  });
});

app.delete('/me', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const dbUser = db.users.get(user.userId);
  if (!dbUser) return res.status(404).json({ message: 'User not found' });

  // Walk each membership: if the user is the lone admin in a multi-member
  // household, refuse. If they're the only member, wipe the household.
  for (const m of dbUser.memberships) {
    const others = [...db.users.values()].filter(
      (u) => u.id !== dbUser.id && u.memberships.some((mm) => mm.householdId === m.householdId)
    );
    const otherAdmins = others.filter((u) =>
      u.memberships.some((mm) => mm.householdId === m.householdId && mm.role === 'admin')
    );
    if (m.role === 'admin' && otherAdmins.length === 0 && others.length > 0) {
      return res.status(400).json({
        message: 'Promote another member to admin in each household before deleting your account',
      });
    }
  }
  for (const m of dbUser.memberships) {
    const others = [...db.users.values()].filter(
      (u) => u.id !== dbUser.id && u.memberships.some((mm) => mm.householdId === m.householdId)
    );
    if (others.length === 0) {
      for (const [pid, p] of db.plants.entries()) {
        if (p.householdId === m.householdId) db.plants.delete(pid);
      }
      for (const [tid, t] of db.tasks.entries()) {
        if (t.householdId === m.householdId) db.tasks.delete(tid);
      }
      db.households.delete(m.householdId);
    }
  }
  db.users.delete(user.userId);
  res.status(204).send();
});

app.get('/me/households', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const dbUser = db.users.get(user.userId);
  if (!dbUser) return res.json([]);
  const list = dbUser.memberships.map((m) => {
    const h = db.households.get(m.householdId);
    return {
      householdId: m.householdId,
      name: h?.name ?? '',
      role: m.role,
      joinedAt: h?.createdAt ?? '',
    };
  });
  res.json(list);
});

// GET /me/export
// GDPR-style data export: profile, notification prefs, memberships, and the
// plants + tasks of every household the caller belongs to, as a downloadable
// JSON document. Mirrors handlers/me/handler.ts:exportMe.
app.get('/me/export', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const dbUser = db.users.get(user.userId);
  if (!dbUser) return res.status(404).json({ message: 'User not found' });

  const households = dbUser.memberships.map((m) => {
    const h = db.households.get(m.householdId);
    return {
      id: m.householdId,
      name: h?.name ?? '',
      role: m.role,
      joinedAt: h?.createdAt ?? '',
      plants: [...db.plants.values()].filter((p) => p.householdId === m.householdId),
      tasks: [...db.tasks.values()].filter((t) => t.householdId === m.householdId),
    };
  });

  const payload = {
    format: 'family-greenhouse-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    user: { id: dbUser.id, email: dbUser.email, name: dbUser.name },
    notificationPreferences: db.notificationPrefs.get(user.userId) ?? defaultPrefs(user.userId),
    households,
  };

  res
    .status(200)
    .type('application/json; charset=utf-8')
    .set('Content-Disposition', 'attachment; filename="family-greenhouse-export.json"')
    .set('Cache-Control', 'no-store')
    .send(JSON.stringify(payload, null, 2));
});

// GET /me/calendar.ics
// Subscribe-able iCalendar feed. Tasks for the caller's active
// household, with RRULE-driven recurrence so the calendar app
// extrapolates locally.
app.get('/me/calendar.ics', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  if (!user.householdId) return res.status(400).type('text/plain').send('No household');
  const tasks = [...db.tasks.values()].filter((t) => t.householdId === user.householdId);
  const { buildIcs } = await import('./services/icsExport.js');
  const ics = buildIcs(tasks);
  res
    .status(200)
    .type('text/calendar; charset=utf-8')
    .set('Content-Disposition', 'attachment; filename="family-greenhouse.ics"')
    .send(ics);
});

// Get current user - used to verify session
app.get('/auth/me', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const dbUser = db.users.get(user.userId);

  if (!dbUser) {
    return res.status(401).json({ message: 'User not found' });
  }

  res.json({
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    householdId: dbUser.householdId,
    householdRole: dbUser.householdRole,
  });
});

app.post('/auth/resend-code', (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: 'Email required' });
  }
  // Find user; if missing, return 200 (don't leak existence).
  const user = findUserByEmail(email);
  if (!user) {
    return res.json({ message: 'If the account exists, a code was sent.' });
  }
  if (user.confirmed) {
    return res.status(400).json({ message: 'User is already confirmed' });
  }
  db.pendingConfirmations.set(email, '123456');
  console.log('\n========================================');
  console.log('CONFIRMATION CODE RESENT');
  console.log(`Email: ${email}`);
  console.log(`Confirmation Code: 123456`);
  console.log('========================================\n');
  res.json({ message: 'Confirmation code resent. Check terminal.' });
});

app.patch('/auth/me', authMiddleware, (req, res) => {
  const reqUser = (req as any).user;
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
    return res.status(400).json({ message: 'name must be a non-empty string up to 80 chars' });
  }
  const dbUser = db.users.get(reqUser.userId);
  if (!dbUser) return res.status(404).json({ message: 'User not found' });
  dbUser.name = name.trim();
  res.json({ id: dbUser.id, email: dbUser.email, name: dbUser.name });
});

app.post('/auth/change-password', authMiddleware, (req, res) => {
  const reqUser = (req as any).user;
  const { oldPassword, newPassword } = req.body ?? {};
  if (typeof oldPassword !== 'string' || oldPassword.length < 1) {
    return res.status(400).json({ message: 'oldPassword is required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ message: 'newPassword must be at least 8 chars' });
  }
  const dbUser = db.users.get(reqUser.userId);
  if (!dbUser) return res.status(404).json({ message: 'User not found' });
  if (dbUser.password !== oldPassword) {
    return res.status(401).json({ message: 'Current password is incorrect' });
  }
  dbUser.password = newPassword;
  res.json({ message: 'Password updated.' });
});

app.post('/auth/forgot-password', (req, res) => {
  const { email } = req.body;

  console.log('\n========================================');
  console.log('PASSWORD RESET REQUESTED');
  console.log(`Email: ${email}`);
  console.log('Reset Code: 123456');
  console.log('========================================\n');

  res.json({ message: 'Check terminal for reset code' });
});

app.post('/auth/reset-password', (req, res) => {
  const { email, code, newPassword } = req.body;

  if (code !== '123456') {
    return res.status(400).json({ message: 'Invalid reset code' });
  }

  const user = findUserByEmail(email);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  user.password = newPassword;
  console.log(`Password reset for ${email}`);

  res.json({ message: 'Password reset successfully' });
});

// ============ HOUSEHOLD ROUTES ============

app.post('/households', authMiddleware, (req, res) => {
  const { name } = req.body;
  const user = (req as any).user;

  const householdId = uuidv4();
  const dbUser = db.users.get(user.userId);

  if (!dbUser) {
    return res.status(404).json({ message: 'User not found' });
  }

  db.households.set(householdId, {
    id: householdId,
    name,
    createdAt: new Date().toISOString(),
    createdBy: user.userId,
  });

  // Always append to memberships (multi-household). Only mark as default
  // if the user doesn't already have one — first-household-wins to keep
  // legacy clients without an X-Household-Id header working.
  dbUser.memberships.push({ householdId, role: 'admin' });
  if (!dbUser.householdId) {
    dbUser.householdId = householdId;
    dbUser.householdRole = 'admin';
  }

  res.status(201).json({
    id: householdId,
    name,
    role: 'admin',
  });
});

app.get('/households/:id', authMiddleware, (req, res) => {
  const household = db.households.get(req.params.id);

  if (!household) {
    return res.status(404).json({ message: 'Household not found' });
  }

  // Get members. With multi-household, we walk each user's memberships
  // array rather than the legacy default-household pointer so a user who's
  // a member of multiple households shows up in each one's roster.
  const members: any[] = [];
  for (const user of db.users.values()) {
    const m = user.memberships.find((x) => x.householdId === req.params.id);
    if (m) {
      members.push({
        id: user.id,
        name: user.name,
        email: user.email,
        role: m.role,
      });
    }
  }

  res.json({
    ...household,
    members,
  });
});

// Climate endpoints. Local dev doesn't have an OpenWeatherMap key wired up;
// `getClimate` returns the saved location with `configured: false` and an
// empty tips array so the frontend exercises the disabled path. `setLocation`
// performs a no-op geocode that just stores the supplied city verbatim.
app.get('/households/:id/climate', authMiddleware, (req, res) => {
  const household = db.households.get(req.params.id);
  if (!household) return res.status(404).json({ message: 'Household not found' });
  res.json({
    configured: false,
    weather: null,
    tips: [],
    location: household.location ?? null,
  });
});

app.put('/households/:id/location', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const household = db.households.get(req.params.id);
  if (!household) return res.status(404).json({ message: 'Household not found' });
  if (user.householdRole !== 'admin') {
    return res.status(403).json({ message: 'Only household admins can set the location' });
  }
  const body = req.body;
  if (body === null) {
    household.location = null;
    return res.json(household);
  }
  if (!body || typeof body.city !== 'string' || body.city.trim().length === 0) {
    return res.status(400).json({ message: 'city is required' });
  }
  // Stub geocode for local dev: store the typed city with placeholder coords
  // so the frontend round-trip works end-to-end without a key.
  household.location = { city: body.city.trim(), lat: 0, lon: 0 };
  res.json(household);
});

app.post('/households/:id/invites', authMiddleware, (req, res) => {
  const code = uuidv4().slice(0, 12).replace(/-/g, '').toUpperCase();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const baseUrl =
    process.env.FRONTEND_URL || `http://localhost:${process.env.FRONTEND_PORT || 3000}`;

  // Mirror the Lambda response shape: { code, expiresAt, url }. The frontend
  // householdService and HouseholdPage both consume `data.url` directly.
  const payload = { code, expiresAt, url: `${baseUrl}/join/${code}` };

  console.log('\n========================================');
  console.log('HOUSEHOLD INVITE CREATED');
  console.log(`Household: ${req.params.id}`);
  console.log(`Invite Code: ${code}`);
  console.log(`URL: ${payload.url}`);
  console.log('========================================\n');

  res.status(201).json(payload);
});

app.put('/households/:householdId/members/:userId/role', authMiddleware, (req, res) => {
  const { householdId, userId } = req.params;
  const { role } = req.body;
  const caller = (req as any).user;
  if (caller.householdId !== householdId) {
    return res.status(403).json({ message: 'Access denied' });
  }
  if (caller.householdRole !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  if (!role || (role !== 'admin' && role !== 'member')) {
    return res.status(400).json({ message: 'role must be admin or member' });
  }
  if (caller.userId === userId && role !== 'admin') {
    return res.status(400).json({ message: 'Admins cannot demote themselves' });
  }
  const target = db.users.get(userId);
  if (!target || target.householdId !== householdId) {
    return res.status(404).json({ message: 'Member not found' });
  }
  target.householdRole = role;
  res.json({
    householdId,
    userId,
    name: target.name,
    email: target.email,
    role,
    joinedAt: new Date().toISOString(),
  });
});

app.post('/households/join', authMiddleware, (req, res) => {
  const _ignored = req.body;
  const user = (req as any).user;
  const dbUser = db.users.get(user.userId);

  if (!dbUser) {
    return res.status(404).json({ message: 'User not found' });
  }

  if (dbUser.memberships.some((m) => m.householdId === seedHouseholdId)) {
    return res.status(400).json({ message: 'You are already a member of this household' });
  }

  // For local dev, accept any invite code and join the seed household.
  dbUser.memberships.push({ householdId: seedHouseholdId, role: 'member' });
  if (!dbUser.householdId) {
    dbUser.householdId = seedHouseholdId;
    dbUser.householdRole = 'member';
  }

  const household = db.households.get(seedHouseholdId);

  res.json({
    id: seedHouseholdId,
    name: household?.name || 'Test Household',
    role: 'member',
  });
});

// ============ PLANT ROUTES ============

app.get('/plants', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const filter = req.query.filter === 'past' || req.query.filter === 'all' ? req.query.filter : 'active';
  const plants: Plant[] = [];

  for (const plant of db.plants.values()) {
    if (plant.householdId !== user.householdId) continue;
    const status = plant.status ?? 'active';
    if (filter === 'active' && status !== 'active') continue;
    if (filter === 'past' && status === 'active') continue;
    plants.push(plant);
  }

  res.json(plants);
});

app.post('/plants', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { name, species, location, notes, tags, perenualSpeciesId } = req.body;

  if (!user.householdId) {
    return res.status(400).json({ message: 'User must belong to a household' });
  }

  const h = db.households.get(user.householdId);
  const plan = PLANS[h?.planId ?? 'seedling'];
  const existing = [...db.plants.values()].filter(
    (p) => p.householdId === user.householdId && (p.status ?? 'active') === 'active'
  );
  if (existing.length >= plan.maxPlants) {
    return res.status(402).json({
      message: `Your ${plan.name} plan is limited to ${plan.maxPlants} plants. Upgrade to add more.`,
    });
  }

  const plantId = uuidv4();
  const now = new Date().toISOString();

  const plant: Plant = {
    id: plantId,
    householdId: user.householdId,
    name,
    species: species || null,
    location: location || null,
    imageUrl: null,
    notes: notes || null,
    status: 'active',
    statusChangedAt: null,
    tags: Array.isArray(tags)
      ? tags
          .map((t: unknown) => String(t).trim())
          .filter(Boolean)
          .slice(0, 10)
      : [],
    perenualSpeciesId:
      typeof perenualSpeciesId === 'number' && perenualSpeciesId > 0 ? perenualSpeciesId : null,
    createdAt: now,
    createdBy: user.userId,
    updatedAt: now,
  };

  db.plants.set(plantId, plant);
  recordActivity({
    type: 'plant.created',
    householdId: user.householdId,
    actorId: user.userId,
    actorName: db.users.get(user.userId)?.name ?? user.email.split('@')[0],
    payload: { plantId, plantName: plant.name },
  });

  res.status(201).json(plant);
});

app.get('/plants/:id', authMiddleware, (req, res) => {
  const plant = db.plants.get(req.params.id);

  if (!plant) {
    return res.status(404).json({ message: 'Plant not found' });
  }

  // Get tasks for this plant
  const upcomingTasks: (Task & { plantName: string })[] = [];
  for (const task of db.tasks.values()) {
    if (task.plantId === req.params.id) {
      upcomingTasks.push({ ...task, plantName: plant.name });
    }
  }
  const recentCompletions: Completion[] = [];
  for (const c of db.completions.values()) {
    if (c.plantId === req.params.id) recentCompletions.push(c);
  }
  recentCompletions.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));

  res.json({ ...plant, upcomingTasks, recentCompletions: recentCompletions.slice(0, 10) });
});

app.put('/plants/:id', authMiddleware, (req, res) => {
  const plant = db.plants.get(req.params.id);

  if (!plant) {
    return res.status(404).json({ message: 'Plant not found' });
  }

  const { name, species, location, notes, tags, perenualSpeciesId, status } = req.body;

  plant.name = name ?? plant.name;
  plant.species = species ?? plant.species;
  plant.location = location ?? plant.location;
  plant.notes = notes ?? plant.notes;
  if (Array.isArray(tags)) {
    plant.tags = tags
      .map((t: unknown) => String(t).trim())
      .filter(Boolean)
      .slice(0, 10);
  }
  if (perenualSpeciesId === null) {
    plant.perenualSpeciesId = null;
  } else if (typeof perenualSpeciesId === 'number' && perenualSpeciesId > 0) {
    plant.perenualSpeciesId = perenualSpeciesId;
  }
  if (status === 'active' || status === 'died' || status === 'gave_away') {
    plant.status = status;
    plant.statusChangedAt = new Date().toISOString();
  }
  plant.updatedAt = new Date().toISOString();

  res.json(plant);
});

app.delete('/plants/:id', authMiddleware, (req, res) => {
  const plant = db.plants.get(req.params.id);

  if (!plant) {
    return res.status(404).json({ message: 'Plant not found' });
  }

  db.plants.delete(req.params.id);

  // Delete associated tasks
  for (const [taskId, task] of db.tasks.entries()) {
    if (task.plantId === req.params.id) {
      db.tasks.delete(taskId);
    }
  }

  res.status(204).send();
});

app.post('/plants/identify', authMiddleware, async (req, res) => {
  const { image } = req.body ?? {};
  if (typeof image !== 'string' || image.length < 64) {
    return res.status(400).json({ message: 'image is required' });
  }
  if (!process.env.PLANT_ID_API_KEY) {
    // Local dev fallback: return a couple of suggestions so the UI flow can
    // be exercised without burning real API credits.
    return res.json({
      configured: false,
      suggestions: [
        { scientificName: 'Monstera deliciosa', commonName: 'Monstera', probability: 0.92 },
        {
          scientificName: 'Philodendron hederaceum',
          commonName: 'Heart-leaf philodendron',
          probability: 0.65,
        },
      ],
    });
  }
  try {
    const stripped = image.replace(/^data:image\/[a-z]+;base64,/i, '');
    const r = await fetch('https://plant.id/api/v3/identification?details=common_names', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': process.env.PLANT_ID_API_KEY,
      },
      body: JSON.stringify({ images: [stripped], similar_images: false }),
    });
    if (!r.ok) return res.status(502).json({ message: `plant.id ${r.status}` });
    const data: any = await r.json();
    const suggestions = (data?.result?.classification?.suggestions ?? [])
      .slice(0, 5)
      .map((s: any) => ({
        scientificName: s.name,
        commonName: s.details?.common_names?.[0] ?? null,
        probability: s.probability,
      }));
    res.json({ configured: true, suggestions });
  } catch (err: any) {
    res.status(502).json({ message: err.message });
  }
});

app.post('/plants/:id/image', authMiddleware, (req, res) => {
  res.json({
    uploadUrl: `http://localhost:${PORT}/mock-upload`,
    imageUrl: `http://localhost:${PORT}/mock-images/${req.params.id}-${uuidv4()}.jpg`,
  });
});

app.post('/plants/:id/image/confirm', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { imageUrl, caption } = req.body;
  const plant = db.plants.get(req.params.id);
  if (!plant) return res.status(404).json({ message: 'Plant not found' });
  if (typeof imageUrl !== 'string' || !imageUrl.includes(req.params.id)) {
    return res.status(400).json({ message: 'imageUrl does not match a key for this plant' });
  }
  plant.imageUrl = imageUrl;
  plant.updatedAt = new Date().toISOString();
  const photoId = uuidv4();
  const photo: PlantPhoto = {
    id: photoId,
    plantId: req.params.id,
    householdId: plant.householdId,
    imageUrl,
    uploadedBy: user.userId,
    uploadedAt: new Date().toISOString(),
    caption: typeof caption === 'string' ? caption : null,
  };
  db.photos.set(photoId, photo);
  recordActivity({
    type: 'photo.uploaded',
    householdId: plant.householdId,
    actorId: user.userId,
    actorName: db.users.get(user.userId)?.name ?? user.email.split('@')[0],
    payload: { plantId: req.params.id, photoId },
  });
  res.json({ imageUrl, photo });
});

app.get('/plants/:id/photos', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const plant = db.plants.get(req.params.id);
  if (!plant || plant.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Plant not found' });
  }
  const photos = [...db.photos.values()]
    .filter((p) => p.plantId === req.params.id)
    .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  res.json(photos);
});

// ============ TASK ROUTES ============

app.get('/tasks', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const tasks: any[] = [];

  for (const task of db.tasks.values()) {
    if (task.householdId === user.householdId) {
      const plant = db.plants.get(task.plantId);
      tasks.push({
        ...task,
        plantName: plant?.name || 'Unknown',
      });
    }
  }

  res.json(tasks);
});

app.get('/tasks/upcoming', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const tasks: any[] = [];

  for (const task of db.tasks.values()) {
    if (task.householdId === user.householdId) {
      const dueDate = new Date(task.nextDue);
      if (dueDate <= weekFromNow) {
        const plant = db.plants.get(task.plantId);
        tasks.push({
          ...task,
          plantName: plant?.name || 'Unknown',
        });
      }
    }
  }

  res.json(tasks);
});

app.post('/tasks', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { plantId, type, customType, frequency, notes, assignedTo } = req.body;

  if (!user.householdId) {
    return res.status(400).json({ message: 'User must belong to a household' });
  }

  const plant = db.plants.get(plantId);
  if (!plant || plant.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Plant not found' });
  }

  const taskId = uuidv4();
  const now = new Date();
  const nextDue = new Date(now.getTime() + frequency * 24 * 60 * 60 * 1000);

  const task: Task = {
    id: taskId,
    householdId: user.householdId,
    plantId,
    type,
    customType: customType || null,
    frequency,
    lastCompleted: null,
    nextDue: nextDue.toISOString(),
    assignedTo: assignedTo || null,
    notes: notes || null,
    createdBy: user.userId,
    createdAt: now.toISOString(),
  };

  db.tasks.set(taskId, task);

  res.status(201).json({
    ...task,
    plantName: plant.name,
  });
});

// Recurring task templates — pre-built bundles users apply to a plant. Mirrors
// `backend/src/models/taskTemplates.ts` for local dev parity.
const TASK_TEMPLATES = [
  {
    id: 'tropical-houseplant',
    name: 'Tropical houseplant',
    description: 'For monsteras, philodendrons, pothos, peace lilies.',
    suitsKeywords: ['monstera', 'philodendron', 'pothos', 'peace lily', 'tropical', 'aroid'],
    tasks: [
      { type: 'water', frequencyDays: 7, notes: 'Top inch of soil dry' },
      { type: 'fertilize', frequencyDays: 30, notes: 'Diluted balanced fertilizer' },
      { type: 'prune', frequencyDays: 90, notes: 'Trim yellowing or leggy growth' },
    ],
  },
  {
    id: 'succulent-or-cactus',
    name: 'Succulent / cactus',
    description: 'Drought-tolerant — infrequent water, lots of light.',
    suitsKeywords: [
      'succulent',
      'cactus',
      'echeveria',
      'jade',
      'aloe',
      'sansevieria',
      'snake plant',
    ],
    tasks: [
      { type: 'water', frequencyDays: 21, notes: 'Soil bone-dry first' },
      { type: 'fertilize', frequencyDays: 90, notes: 'Cactus food, half strength' },
    ],
  },
  {
    id: 'fern',
    name: 'Fern',
    description: 'Loves consistent moisture and indirect light.',
    suitsKeywords: ['fern', 'maidenhair', 'boston fern', 'asparagus'],
    tasks: [
      { type: 'water', frequencyDays: 4, notes: 'Keep soil consistently moist' },
      { type: 'fertilize', frequencyDays: 21 },
      { type: 'custom', customType: 'Mist', frequencyDays: 2, notes: 'Boost humidity' },
    ],
  },
  {
    id: 'orchid',
    name: 'Orchid',
    description: 'Soak weekly; weakly weekly feed.',
    suitsKeywords: ['orchid', 'phalaenopsis', 'cattleya'],
    tasks: [
      { type: 'water', frequencyDays: 7, notes: 'Soak-and-drain in bark' },
      { type: 'fertilize', frequencyDays: 14, notes: 'Weakly weekly' },
      { type: 'repot', frequencyDays: 730, notes: 'Fresh bark every 2 years' },
    ],
  },
  {
    id: 'flowering-houseplant',
    name: 'Flowering houseplant',
    description: 'Bloom-stage feed, deadhead spent flowers.',
    suitsKeywords: ['violet', 'anthurium', 'kalanchoe', 'flowering'],
    tasks: [
      { type: 'water', frequencyDays: 5 },
      { type: 'fertilize', frequencyDays: 14, notes: 'Bloom booster fertilizer' },
      { type: 'prune', frequencyDays: 30, notes: 'Deadhead spent blooms' },
    ],
  },
  {
    id: 'herb',
    name: 'Culinary herb',
    description: 'Sunny window, regular harvesting.',
    suitsKeywords: ['basil', 'mint', 'rosemary', 'thyme', 'oregano', 'herb'],
    tasks: [
      { type: 'water', frequencyDays: 3 },
      { type: 'fertilize', frequencyDays: 30 },
      { type: 'prune', frequencyDays: 14, notes: 'Pinch tops to encourage bushy growth' },
    ],
  },
];

app.get('/tasks/templates', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(TASK_TEMPLATES);
});

app.post('/plants/apply-template-bulk', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { plantIds, templateId } = req.body ?? {};
  if (!Array.isArray(plantIds) || plantIds.length === 0 || !templateId) {
    return res.status(400).json({ message: 'plantIds and templateId are required' });
  }
  const tpl = TASK_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return res.status(404).json({ message: 'Unknown template' });
  const applied: Array<{ plantId: string; taskIds: string[] }> = [];
  const skipped: Array<{ plantId: string; reason: string }> = [];
  for (const plantId of plantIds.slice(0, 50)) {
    const plant = db.plants.get(plantId);
    if (!plant || plant.householdId !== user.householdId) {
      skipped.push({ plantId, reason: 'not_found' });
      continue;
    }
    const taskIds: string[] = [];
    for (const def of tpl.tasks) {
      const taskId = uuidv4();
      const now = new Date();
      const task: Task = {
        id: taskId,
        householdId: user.householdId,
        plantId,
        type: def.type,
        customType: def.customType ?? null,
        frequency: def.frequencyDays,
        lastCompleted: null,
        nextDue: new Date(now.getTime() + def.frequencyDays * 24 * 60 * 60 * 1000).toISOString(),
        assignedTo: null,
        notes: def.notes ?? null,
        createdBy: user.userId,
        createdAt: now.toISOString(),
      };
      db.tasks.set(taskId, task);
      taskIds.push(taskId);
    }
    applied.push({ plantId, taskIds });
  }
  res.json({ applied, skipped });
});

app.post('/plants/:plantId/apply-template', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const plant = db.plants.get(req.params.plantId);
  if (!plant || plant.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Plant not found' });
  }
  const tpl = TASK_TEMPLATES.find((t) => t.id === req.body?.templateId);
  if (!tpl) return res.status(404).json({ message: 'Unknown template' });

  const created: Task[] = [];
  for (const def of tpl.tasks) {
    const taskId = uuidv4();
    const now = new Date();
    const task: Task = {
      id: taskId,
      householdId: user.householdId,
      plantId: plant.id,
      type: def.type,
      customType: def.customType ?? null,
      frequency: def.frequencyDays,
      lastCompleted: null,
      nextDue: new Date(now.getTime() + def.frequencyDays * 24 * 60 * 60 * 1000).toISOString(),
      assignedTo: null,
      notes: def.notes ?? null,
      createdBy: user.userId,
      createdAt: now.toISOString(),
    };
    db.tasks.set(taskId, task);
    created.push(task);
  }
  res.json({ created });
});

app.put('/tasks/:id', authMiddleware, (req, res) => {
  const task = db.tasks.get(req.params.id);

  if (!task) {
    return res.status(404).json({ message: 'Task not found' });
  }

  const { type, customType, frequency, notes, assignedTo } = req.body;

  task.type = type ?? task.type;
  task.customType = customType ?? task.customType;
  task.frequency = frequency ?? task.frequency;
  task.notes = notes ?? task.notes;
  task.assignedTo = assignedTo ?? task.assignedTo;

  const plant = db.plants.get(task.plantId);

  res.json({
    ...task,
    plantName: plant?.name || 'Unknown',
  });
});

app.delete('/tasks/:id', authMiddleware, (req, res) => {
  const task = db.tasks.get(req.params.id);

  if (!task) {
    return res.status(404).json({ message: 'Task not found' });
  }

  db.tasks.delete(req.params.id);
  res.status(204).send();
});

app.post('/tasks/:id/snooze', authMiddleware, (req, res) => {
  const task = db.tasks.get(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  const days = Number(req.body?.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return res.status(400).json({ message: 'days must be an integer between 1 and 365' });
  }
  const next = new Date(task.nextDue);
  if (Number.isNaN(next.getTime())) next.setTime(Date.now());
  next.setDate(next.getDate() + days);
  task.nextDue = next.toISOString();
  res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? 'Unknown' });
});

app.post('/tasks/:id/complete', authMiddleware, (req, res) => {
  const task = db.tasks.get(req.params.id);
  const user = (req as any).user;

  if (!task) {
    return res.status(404).json({ message: 'Task not found' });
  }

  const now = new Date();
  task.lastCompleted = now.toISOString();
  task.nextDue = new Date(now.getTime() + task.frequency * 24 * 60 * 60 * 1000).toISOString();

  const plant = db.plants.get(task.plantId);
  const dbUser = db.users.get(user.userId);
  const completionId = uuidv4();
  db.completions.set(completionId, {
    id: completionId,
    householdId: task.householdId,
    plantId: task.plantId,
    taskId: task.id,
    taskType: task.customType || task.type,
    completedBy: user.userId,
    completedByName: dbUser?.name ?? user.email.split('@')[0],
    completedAt: now.toISOString(),
    notes: typeof req.body?.notes === 'string' ? req.body.notes : null,
  });

  console.log(`Task completed: ${task.type} for ${plant?.name || 'Unknown plant'}`);

  res.json({
    ...task,
    plantName: plant?.name || 'Unknown',
    completedBy: user.userId,
  });
});

app.get('/households/:id/analytics/daily', authMiddleware, (req, res) => {
  const user = (req as any).user;
  if (user.householdId !== req.params.id) {
    return res.status(403).json({ message: 'Access denied' });
  }
  const daysRaw = req.query.days;
  const days = Math.max(
    1,
    Math.min(180, typeof daysRaw === 'string' ? parseInt(daysRaw, 10) || 30 : 30)
  );
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);
  const buckets = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const c of db.completions.values()) {
    if (c.householdId !== req.params.id) continue;
    if (c.completedAt < start.toISOString() || c.completedAt > now.toISOString()) continue;
    const key = c.completedAt.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  res.json({
    days,
    series: [...buckets.entries()].map(([date, count]) => ({ date, count })),
  });
});

app.get('/households/:id/year-in-review', authMiddleware, (req, res) => {
  const user = (req as any).user;
  if (user.householdId !== req.params.id) {
    return res.status(403).json({ message: 'Access denied' });
  }
  const yearRaw = req.query.year;
  const year = yearRaw ? parseInt(String(yearRaw), 10) : new Date().getFullYear();
  if (!Number.isFinite(year) || year < 2020 || year > 2100) {
    return res.status(400).json({ message: 'year must be between 2020 and 2100' });
  }
  const start = `${year}-01-01T00:00:00.000Z`;
  const end = `${year + 1}-01-01T00:00:00.000Z`;
  const items = [...db.completions.values()].filter(
    (c) => c.householdId === req.params.id && c.completedAt >= start && c.completedAt < end
  );
  const memberCounts = new Map<string, { name: string; count: number }>();
  const typeCounts = new Map<string, number>();
  const plantCounts = new Map<string, number>();
  for (const it of items) {
    const m = memberCounts.get(it.completedBy);
    memberCounts.set(it.completedBy, { name: it.completedByName, count: (m?.count ?? 0) + 1 });
    typeCounts.set(it.taskType, (typeCounts.get(it.taskType) ?? 0) + 1);
    plantCounts.set(it.plantId, (plantCounts.get(it.plantId) ?? 0) + 1);
  }
  res.json({
    year,
    totalCompletions: items.length,
    byMember: [...memberCounts.entries()]
      .map(([userId, v]) => ({ userId, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count),
    byTaskType: [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    topPlants: [...plantCounts.entries()]
      .map(([plantId, count]) => ({ plantId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  });
});

app.get('/households/:id/activity', authMiddleware, (req, res) => {
  const user = (req as any).user;
  if (user.householdId !== req.params.id) {
    return res.status(403).json({ message: 'Access denied' });
  }
  const limitRaw = req.query.limit;
  const limit = Math.max(
    1,
    Math.min(200, typeof limitRaw === 'string' ? parseInt(limitRaw, 10) || 50 : 50)
  );
  // Unified activity envelope: completions folded into the same shape as
  // typed events so the frontend renders everything uniformly.
  const events: Array<{
    id: string;
    type: string;
    householdId: string;
    actorId: string;
    actorName: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }> = [];
  for (const c of db.completions.values()) {
    if (c.householdId !== req.params.id) continue;
    events.push({
      id: c.id,
      type: 'task.completed',
      householdId: c.householdId,
      actorId: c.completedBy,
      actorName: c.completedByName,
      occurredAt: c.completedAt,
      payload: { plantId: c.plantId, taskId: c.taskId, taskType: c.taskType, notes: c.notes },
    });
  }
  for (const e of db.activity.values()) {
    if (e.householdId !== req.params.id) continue;
    events.push({ ...e });
  }
  events.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  res.json(events.slice(0, limit));
});

app.get('/plants/:id/history', authMiddleware, (req, res) => {
  const out: Completion[] = [];
  for (const c of db.completions.values()) {
    if (c.plantId === req.params.id) out.push(c);
  }
  out.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  res.json(out);
});

// ============ BILLING ============

const PLANS = {
  seedling: { id: 'seedling', name: 'Seedling', monthlyPrice: 0, maxPlants: 10, maxMembers: 1 },
  garden: { id: 'garden', name: 'Garden', monthlyPrice: 4.99, maxPlants: 500, maxMembers: 6 },
  greenhouse: {
    id: 'greenhouse',
    name: 'Greenhouse',
    monthlyPrice: 9.99,
    maxPlants: 5000,
    maxMembers: 50,
  },
} as const;

// Species autocomplete proxy. The local dev server doesn't have a Perenual
// API key wired up, so it reports `disabled` and lets the frontend fall back
// to its static catalog. This keeps local dev offline-friendly.
app.get('/species/search', authMiddleware, (req, res) => {
  res.json({ source: 'disabled', results: [] });
});

app.get('/species/:id', authMiddleware, (req, res) => {
  res.json({ result: null });
});

app.get('/species/:id/care-suggestions', authMiddleware, (req, res) => {
  res.json({ result: null });
});

app.get('/species/:id/thumbnail', authMiddleware, (req, res) => {
  // No Perenual data locally; treat as missing so the frontend keeps its
  // existing placeholder rendering.
  res.status(404).end();
});

app.get('/species/:id/guide', authMiddleware, (req, res) => {
  res.json({ result: null });
});

app.get('/billing/plans', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(Object.values(PLANS).map((p) => ({ ...p, description: '' })));
});

app.get('/billing/me', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const h = db.households.get(user.householdId);
  res.json({
    planId: h?.planId ?? 'seedling',
    stripeCustomerId: h?.stripeCustomerId,
    stripeSubscriptionId: h?.stripeSubscriptionId,
    status: h?.subscriptionStatus,
  });
});

app.post('/billing/checkout', authMiddleware, (req, res) => {
  const user = (req as any).user;
  if (user.householdRole !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  const { planId } = req.body ?? {};
  if (planId !== 'garden' && planId !== 'greenhouse') {
    return res.status(400).json({ message: 'planId must be garden or greenhouse' });
  }
  // Local dev "checkout": skip Stripe and apply the upgrade immediately so the
  // UI flow can be exercised end-to-end. Real prod returns a Stripe URL.
  const h = db.households.get(user.householdId);
  if (h) {
    h.planId = planId;
    h.subscriptionStatus = 'active';
  }
  console.log(
    `[billing] dev-mode upgrade: ${user.householdId} -> ${planId}. (Stripe is bypassed.)`
  );
  res.json({ url: `http://localhost:${PORT}/billing/dev-success` });
});

app.get('/billing/dev-success', (_req, res) => {
  res.send(
    '<html><body><h1>Mock checkout success</h1><p>You can close this window.</p></body></html>'
  );
});

app.post('/billing/portal', authMiddleware, (req, res) => {
  const user = (req as any).user;
  if (user.householdRole !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  res.json({ url: `http://localhost:${PORT}/billing/dev-portal` });
});

app.get('/billing/dev-portal', (_req, res) => {
  res.send(
    '<html><body><h1>Mock billing portal</h1><p>Stripe customer portal stub.</p></body></html>'
  );
});

// ============ NOTIFICATIONS ============

function defaultPrefs(userId: string): NotificationPrefsRecord {
  return {
    userId,
    browser: false,
    email: true,
    sms: false,
    phone: '',
    dndStart: '',
    dndEnd: '',
    timezone: 'UTC',
    pestAlerts: false,
    updatedAt: new Date().toISOString(),
  };
}

const E164_RE = /^\+[1-9]\d{6,14}$/;

app.get('/notifications/prefs', authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.json(db.notificationPrefs.get(user.userId) ?? defaultPrefs(user.userId));
});

app.put('/notifications/prefs', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { browser, email, sms, phone, dndStart, dndEnd, timezone, pestAlerts } = req.body ?? {};
  if (typeof browser !== 'boolean' || typeof email !== 'boolean' || typeof sms !== 'boolean') {
    return res.status(400).json({ message: 'browser/email/sms must be booleans' });
  }
  const phoneStr = typeof phone === 'string' ? phone : '';
  if (sms && !E164_RE.test(phoneStr)) {
    return res
      .status(400)
      .json({ message: 'A valid E.164 phone number is required to enable SMS' });
  }
  const updated: NotificationPrefsRecord = {
    userId: user.userId,
    browser,
    email,
    sms,
    phone: sms ? phoneStr : '',
    dndStart: typeof dndStart === 'string' ? dndStart : '',
    dndEnd: typeof dndEnd === 'string' ? dndEnd : '',
    timezone: typeof timezone === 'string' && timezone.length > 0 ? timezone : 'UTC',
    pestAlerts: typeof pestAlerts === 'boolean' ? pestAlerts : false,
    updatedAt: new Date().toISOString(),
  };
  db.notificationPrefs.set(user.userId, updated);
  res.json(updated);
});

app.post('/notifications/subscribe', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { endpoint, keys } = req.body ?? {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ message: 'endpoint and keys are required' });
  }
  db.pushSubscriptions.set(`${user.userId}|${endpoint}`, {
    userId: user.userId,
    endpoint,
    keys,
    createdAt: new Date().toISOString(),
  });
  res.json({ ok: true });
});

app.post('/notifications/unsubscribe', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { endpoint } = req.body ?? {};
  if (!endpoint) return res.status(400).json({ message: 'endpoint required' });
  db.pushSubscriptions.delete(`${user.userId}|${endpoint}`);
  res.status(204).send();
});

app.post('/notifications/run-reminders', authMiddleware, (req, res) => {
  const user = (req as any).user;
  if (user.householdRole !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  const now = new Date();
  const cutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  let sent = 0;
  for (const member of db.users.values()) {
    if (!member.memberships.some((m) => m.householdId === user.householdId)) continue;
    const due = [...db.tasks.values()].filter(
      (t) => t.householdId === user.householdId && t.assignedTo === member.id && t.nextDue <= cutoff
    );
    if (due.length === 0) continue;
    const prefs = db.notificationPrefs.get(member.id) ?? defaultPrefs(member.id);
    const headline = `${due.length} task${due.length === 1 ? '' : 's'} due`;
    if (prefs.browser) {
      console.log(`[push dry-run] -> ${member.email}: ${headline}`);
    }
    if (prefs.email) {
      console.log(`[email dry-run] -> ${member.email}: Plant care reminder — ${headline}`);
    }
    if (prefs.sms && prefs.phone) {
      console.log(`[sms dry-run] -> ${prefs.phone}: ${headline}`);
    }
    sent += 1;
  }
  res.json({ sent });
});

// ============ API KEYS (Greenhouse plan) ============

function generateApiKey(): string {
  // Web Crypto-equivalent random hex without crypto import in this dev file.
  const bytes = Array.from({ length: 24 }, () => Math.floor(Math.random() * 256));
  return `fg_${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

app.get('/api-keys', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const keys = [...db.apiKeys.values()]
    .filter((k) => k.householdId === user.householdId)
    .map(({ plaintext: _p, ...rest }) => rest);
  res.json(keys);
});

app.post('/api-keys', authMiddleware, (req, res) => {
  const user = (req as any).user;
  if (user.householdRole !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  const h = db.households.get(user.householdId);
  if ((h?.planId ?? 'seedling') !== 'greenhouse') {
    return res.status(402).json({
      message: 'API access is included with the Greenhouse plan. Upgrade to issue API keys.',
    });
  }
  const { label, scopes: rawScopes } = req.body ?? {};
  if (typeof label !== 'string' || label.length < 1 || label.length > 60) {
    return res.status(400).json({ message: 'label is required (1-60 chars)' });
  }
  if (
    rawScopes !== undefined &&
    (!Array.isArray(rawScopes) || rawScopes.some((s) => !API_SCOPES.includes(s)))
  ) {
    return res.status(400).json({ message: `scopes must be a subset of ${API_SCOPES.join(', ')}` });
  }
  // Omitted/empty → full read access (matches backend default).
  const scopes =
    Array.isArray(rawScopes) && rawScopes.length > 0 ? (rawScopes as string[]) : [...API_SCOPES];
  const id = uuidv4();
  const plaintext = generateApiKey();
  const record: ApiKey = {
    id,
    householdId: user.householdId,
    label,
    last4: plaintext.slice(-4),
    scopes,
    createdAt: new Date().toISOString(),
    createdBy: user.userId,
    lastUsedAt: null,
    plaintext,
  };
  db.apiKeys.set(id, record);
  console.log(`\n[api-keys] issued ${plaintext} for household ${user.householdId}\n`);
  const { plaintext: _p, ...publicShape } = record;
  res.status(201).json({ record: publicShape, plaintext });
});

app.delete('/api-keys/:id', authMiddleware, (req, res) => {
  const user = (req as any).user;
  if (user.householdRole !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  const key = db.apiKeys.get(req.params.id);
  if (!key || key.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Key not found' });
  }
  db.apiKeys.delete(req.params.id);
  res.status(204).send();
});

// ============ PUBLIC API v1 ============

function apiKeyMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.headers.authorization;
  const xKey = req.headers['x-api-key'];
  let plaintext: string | undefined;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) plaintext = auth.slice(7).trim();
  else if (typeof xKey === 'string') plaintext = xKey.trim();
  if (!plaintext) return res.status(401).json({ message: 'API key required' });
  const record = [...db.apiKeys.values()].find((k) => k.plaintext === plaintext);
  if (!record) return res.status(401).json({ message: 'Invalid API key' });
  record.lastUsedAt = new Date().toISOString();
  (req as any).user = {
    userId: `apikey:${record.id}`,
    email: '',
    householdId: record.householdId,
    householdRole: 'member',
  };
  (req as any).apiScopes = record.scopes ?? [...API_SCOPES];
  next();
}

/** Mirrors `requireApiScope` in middleware/apiKey.ts. */
function requireApiScope(scope: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const scopes = (req as any).apiScopes ?? [];
    if (!scopes.includes(scope)) {
      return res
        .status(403)
        .json({ message: `This API key is missing the required scope: ${scope}` });
    }
    next();
  };
}

app.get('/api/v1/me', apiKeyMiddleware, (req, res) => {
  const user = (req as any).user;
  res.json({ householdId: user.householdId, apiVersion: 'v1' });
});

app.get('/api/v1/plants', apiKeyMiddleware, requireApiScope('read:plants'), (req, res) => {
  const user = (req as any).user;
  const plants = [...db.plants.values()].filter((p) => p.householdId === user.householdId);
  res.json(plants);
});

app.get('/api/v1/plants/:id', apiKeyMiddleware, requireApiScope('read:plants'), (req, res) => {
  const user = (req as any).user;
  const plant = db.plants.get(req.params.id);
  if (!plant || plant.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Plant not found' });
  }
  res.json(plant);
});

app.get('/api/v1/tasks', apiKeyMiddleware, requireApiScope('read:tasks'), (req, res) => {
  const user = (req as any).user;
  const tasks = [...db.tasks.values()]
    .filter((t) => t.householdId === user.householdId)
    .map((t) => ({ ...t, plantName: db.plants.get(t.plantId)?.name ?? 'Unknown' }));
  res.json(tasks);
});

app.get('/api/v1/activity', apiKeyMiddleware, requireApiScope('read:activity'), (req, res) => {
  const user = (req as any).user;
  const limitRaw = req.query.limit;
  const limit = Math.max(
    1,
    Math.min(200, typeof limitRaw === 'string' ? parseInt(limitRaw, 10) || 50 : 50)
  );
  const items = [...db.completions.values()]
    .filter((c) => c.householdId === user.householdId)
    .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1))
    .slice(0, limit);
  res.json(items);
});

// ============ MOCK UPLOAD ENDPOINT ============

app.post('/mock-upload', (req, res) => {
  res.json({ success: true });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log('\n========================================');
    console.log('Family Greenhouse Local Dev Server');
    console.log(`Running on http://localhost:${PORT}`);
    console.log('========================================');
    console.log('\nTest account:');
    console.log('  Email: test@example.com');
    console.log('  Password: password123');
    console.log('\nFor new signups, use confirmation code: 123456');
    console.log('========================================\n');
  });
}
