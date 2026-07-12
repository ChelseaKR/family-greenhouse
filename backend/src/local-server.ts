// Development-only mock server. Express handlers here mix early-`return res.x()`
// with implicit-returning success paths, which trips `noImplicitReturns`.
// This file is never deployed (build pipeline uses esbuild on Lambda handlers),
// so suppress strict-mode return checks rather than rewriting every handler.
//
// CONTRACT: this server mirrors the production Lambda API (handlers/**) as
// closely as an in-memory mock can. The integration tests run against this
// app, so any divergence from production makes CI blind — when production
// behavior changes, change this file to match, never the other way around.
// tests/integration/route-parity.test.ts asserts the route surface stays in
// lockstep with the production route tables.
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  signupSchema,
  loginSchema,
  confirmEmailSchema,
  forgotPasswordSchema,
  resendCodeSchema,
  resetPasswordSchema,
  refreshTokenSchema,
  createHouseholdSchema,
  updateMemberRoleSchema,
  createPlantSchema,
  updatePlantSchema,
  importPlantsSchema,
  confirmImageUploadSchema,
  createTaskSchema,
  updateTaskSchema,
  completeTaskSchema,
  snoozeTaskSchema,
  setVacationSchema,
  applyTemplateSchema,
  applyTemplateBulkSchema,
  createSitterLinkSchema,
} from './models/schemas.js';
import { TEMPLATES } from './models/taskTemplates.js';
import { PLANS, planSummary } from './models/plans.js';
import { lookupToxicity } from './models/petToxicity.js';

// Hard refusal to boot in production — this server has no real auth, no
// persistence, and a well-known seed account. Mirrors the resolveCorsOrigin
// fail-fast in middleware/handler.ts.
if (process.env.NODE_ENV === 'production') {
  throw new Error('local-server.ts is a development mock and must never run in production');
}

export const app = express();
const PORT = process.env.PORT || 4000;

// Mirror API Gateway's unauthenticated OPTIONS /{proxy+} route. The general
// CORS middleware below also answers preflights, but registering the route
// explicitly keeps the mock and production route surfaces in lockstep.
app.options('/*proxy', cors());
app.use(cors());
app.use(express.json());

// In-memory storage for local development
interface Membership {
  householdId: string;
  role: 'admin' | 'member';
  joinedAt: string;
}

interface User {
  id: string;
  email: string;
  password: string;
  name: string;
  confirmed: boolean;
  /** Default household — kept on the JWT claims in production. The first
   *  household the user joins becomes their default. */
  householdId: string | null;
  householdRole: 'admin' | 'member' | null;
  /** All households the user is a member of. Mirrors the production
   *  HouseholdMember rows: this — never the claim/default pointer — is the
   *  source of truth for membership AND role (middleware/auth.ts). */
  memberships: Membership[];
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

interface Invite {
  code: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

interface Plant {
  id: string;
  householdId: string;
  name: string;
  species: string | null;
  location: string | null;
  imageUrl: string | null;
  notes: string | null;
  status: 'active' | 'died' | 'gave_away' | 'archived';
  statusChangedAt: string | null;
  tags: string[];
  perenualSpeciesId: number | null;
  /** Propagation lineage: same-household parent plant, if a cutting. */
  parentPlantId: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/** Mirrors plantService.PlantShare (SHARE#{code} row, 14-day TTL). */
interface PlantShare {
  code: string;
  plantId: string;
  householdId: string;
  plantSnapshot: {
    name: string;
    species: string | null;
    notes: string | null;
    imageUrl: string | null;
    tags: string[];
  };
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

interface Task {
  id: string;
  householdId: string;
  plantId: string;
  plantName: string;
  type: string;
  customType: string | null;
  frequency: number;
  lastCompleted: string | null;
  nextDue: string;
  assignedTo: string | null;
  assignedToName: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
}

/** Mirrors sitterService.SitterLink (SITTER#{token} row). The token is the
 *  256-bit secret; id is the non-secret handle used by list/revoke. */
interface SitterLink {
  id: string;
  token: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  startsAt: string;
  expiresAt: string;
  status: 'active' | 'revoked';
  label: string | null;
}

interface PushSubscriptionRecord {
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

interface DeviceTokenRecord {
  userId: string;
  platform: 'ios' | 'android';
  token: string;
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
  weeklyDigest: boolean;
  phoneVerified: boolean;
  updatedAt: string;
}

/** Mirrors the `USER#{id}/PHONE_VERIFY` row (services/notificationPrefs.ts).
 *  DEV ONLY: the mock stores the code in plaintext so it can echo it back. */
interface PhoneVerificationRecord {
  phone: string;
  code: string;
  expiresAt: number; // epoch ms
  attempts: number;
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

/** Mirrors taskService.VacationWindow (PK=HOUSEHOLD#{id}, SK=VACATION#{userId}). */
interface VacationWindow {
  householdId: string;
  userId: string;
  coveredBy: string;
  coveredByName: string | null;
  startDate: string;
  endDate: string;
  createdBy: string;
  createdAt: string;
}

interface ActivityEvent {
  id: string;
  type:
    | 'task.completed'
    | 'task.snoozed'
    | 'task.claimed'
    | 'task.unclaimed'
    | 'plant.created'
    | 'plants.imported'
    | 'plant.deleted'
    | 'plant.died'
    | 'plant.gave_away'
    | 'plant.archived'
    | 'plant.restored'
    | 'plant.propagated'
    | 'plant.shared_accepted'
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
const API_SCOPES = ['read:plants', 'read:tasks', 'read:activity', 'write:tasks'];
/** Mirrors `apiKeys.READ_API_SCOPES` — implicit scope defaults expand to
 *  read-only; `write:tasks` must always be granted explicitly. */
const READ_API_SCOPES = ['read:plants', 'read:tasks', 'read:activity'];

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
  invites: new Map<string, Invite>(),
  plants: new Map<string, Plant>(),
  shares: new Map<string, PlantShare>(),
  tasks: new Map<string, Task>(),
  completions: new Map<string, Completion>(),
  photos: new Map<string, PlantPhoto>(),
  apiKeys: new Map<string, ApiKey>(),
  activity: new Map<string, ActivityEvent>(),
  // Vacation windows, keyed `${householdId}|${userId}` (one window per
  // member per household — mirrors the VACATION#{userId} SK in production).
  vacations: new Map<string, VacationWindow>(),
  pushSubscriptions: new Map<string, PushSubscriptionRecord>(),
  deviceTokens: new Map<string, DeviceTokenRecord>(), // `${userId}|${token}` native push
  notificationPrefs: new Map<string, NotificationPrefsRecord>(),
  phoneVerifications: new Map<string, PhoneVerificationRecord>(), // userId -> pending code
  recapSent: new Set<string>(), // `${householdId}|${year}` once-per-year markers
  pendingConfirmations: new Map<string, string>(), // email -> confirmation code
  sitterLinks: new Map<string, SitterLink>(), // keyed by token (the secret)
};

export const seedHouseholdId = '550e8400-e29b-41d4-a716-446655440001';
export const seedUserId = '550e8400-e29b-41d4-a716-446655440000';
export let seedPlantId = '';
export let seedTaskId = '';

export function resetDb(): void {
  db.users.clear();
  db.households.clear();
  db.invites.clear();
  db.plants.clear();
  db.shares.clear();
  db.tasks.clear();
  db.completions.clear();
  db.photos.clear();
  db.apiKeys.clear();
  db.activity.clear();
  db.vacations.clear();
  db.pushSubscriptions.clear();
  db.deviceTokens.clear();
  db.notificationPrefs.clear();
  db.phoneVerifications.clear();
  db.recapSent.clear();
  db.pendingConfirmations.clear();
  db.sitterLinks.clear();

  const now = new Date().toISOString();

  db.users.set(seedUserId, {
    id: seedUserId,
    email: 'test@example.com',
    password: 'password123',
    name: 'Test User',
    confirmed: true,
    householdId: seedHouseholdId,
    householdRole: 'admin',
    memberships: [{ householdId: seedHouseholdId, role: 'admin', joinedAt: now }],
  });

  db.households.set(seedHouseholdId, {
    id: seedHouseholdId,
    name: 'Test Household',
    createdAt: now,
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
    status: 'active',
    statusChangedAt: null,
    tags: ['tropical'],
    perenualSpeciesId: null,
    parentPlantId: null,
    createdAt: now,
    createdBy: seedUserId,
    updatedAt: now,
  });

  seedTaskId = uuidv4();
  db.tasks.set(seedTaskId, {
    id: seedTaskId,
    householdId: seedHouseholdId,
    plantId: seedPlantId,
    plantName: 'Monstera',
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue: now,
    assignedTo: null,
    assignedToName: null,
    notes: null,
    createdBy: seedUserId,
    createdAt: now,
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

/**
 * Zod body validation, mirroring middleware/validation.ts exactly: failures
 * are 400 `{ message: 'Validation failed', details: { '<path>': [msgs] } }`.
 * The validated (stripped) body is stashed on `req.validatedBody`.
 */
function validateBody(schema: z.ZodTypeAny) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Express 5's bundled body-parser leaves req.body as `undefined` (rather
    // than `{}`) when a request has no matching Content-Type, e.g. a POST
    // with no body at all. Normalize to `null` so schemas written as
    // `.nullable()` for "no body" clients keep validating as before.
    const result = schema.safeParse(req.body ?? null);
    if (!result.success) {
      const details = result.error.errors.reduce(
        (acc, err) => {
          const path = err.path.join('.');
          if (!acc[path]) acc[path] = [];
          acc[path].push(err.message);
          return acc;
        },
        {} as Record<string, string[]>
      );
      return res.status(400).json({ message: 'Validation failed', details });
    }
    (req as any).validatedBody = result.data;
    next();
  };
}

/**
 * Auth middleware for protected routes. Mirrors production middleware/auth.ts:
 * the requested household — whether it comes from the `X-Household-Id`
 * override header or from the user's default (claim) household — is ALWAYS
 * validated against the membership records before it is attached to the
 * request. A caller who is not a member of the requested household gets a
 * 403, and the role always comes from the membership record, never from a
 * header or the default-role pointer.
 */
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

  const override = req.headers['x-household-id'];
  const requestedHouseholdId =
    typeof override === 'string' && override.length > 0 ? override : user.householdId;

  let householdId: string | null = null;
  let householdRole: 'admin' | 'member' | null = null;
  if (requestedHouseholdId) {
    const membership = user.memberships.find(
      (m: Membership) => m.householdId === requestedHouseholdId
    );
    if (!membership) {
      // Same message + status as production middleware/auth.ts.
      return res.status(403).json({ message: 'Not a member of the requested household' });
    }
    householdId = requestedHouseholdId;
    // Membership record is authoritative — never the claim's role.
    householdRole = membership.role;
  }

  (req as any).user = {
    userId: user.id,
    email: user.email,
    householdId,
    householdRole,
  };

  next();
}

/** Mirrors `requireHousehold` in middleware/auth.ts. */
function requireHousehold(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!(req as any).user?.householdId) {
    return res.status(403).json({ message: 'User must belong to a household' });
  }
  next();
}

/** Mirrors `requireAdmin` in middleware/auth.ts. */
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if ((req as any).user?.householdRole !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
}

/** Production HouseholdMember row shape for a household's roster. */
function membersOf(householdId: string) {
  const members: Array<{
    householdId: string;
    userId: string;
    name: string;
    email: string;
    role: 'admin' | 'member';
    joinedAt: string;
  }> = [];
  for (const user of db.users.values()) {
    const m = user.memberships.find((x) => x.householdId === householdId);
    if (m) {
      members.push({
        householdId,
        userId: user.id,
        name: user.name,
        email: user.email,
        role: m.role,
        joinedAt: m.joinedAt,
      });
    }
  }
  return members;
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

app.post('/auth/signup', validateBody(signupSchema), (req, res) => {
  const { email, password, name } = (req as any).validatedBody;

  if (findUserByEmail(email)) {
    return res.status(400).json({ message: 'An account with this email already exists' });
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

  // Production returns only a message (the Cognito user id is never exposed).
  res.status(201).json({
    message: 'User created. Please check your email for confirmation code.',
  });
});

app.post('/auth/confirm', validateBody(confirmEmailSchema), (req, res) => {
  const { email, code } = (req as any).validatedBody;

  const user = findUserByEmail(email);
  if (!user) {
    // Dev convenience: production surfaces this as an unhandled Cognito
    // UserNotFoundException (500); a explicit 404 is more debuggable locally.
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

  // Production does NOT auto-login on confirm — Cognito only confirms the
  // account; the client must call POST /auth/login next.
  res.json({ message: 'Email confirmed successfully. Please login.' });
});

app.post('/auth/login', validateBody(loginSchema), (req, res) => {
  const { email, password } = (req as any).validatedBody;

  const user = findUserByEmail(email);
  if (!user || user.password !== password) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  if (!user.confirmed) {
    return res.status(401).json({ message: 'Please confirm your email first' });
  }

  const idToken = generateToken(user.id);
  const accessToken = generateToken(user.id);
  const refreshToken = generateToken(user.id);

  // Production returns BOTH tokens plus expiresIn: the ID token rides the
  // Authorization header for API calls; the access token is for
  // Cognito-direct calls. The mock accepts either, but the shape must match.
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      householdId: user.householdId,
      householdRole: user.householdRole,
    },
    idToken,
    accessToken,
    refreshToken,
    expiresIn: 3600,
  });
});

app.post('/auth/refresh', validateBody(refreshTokenSchema), (req, res) => {
  const { refreshToken } = (req as any).validatedBody;

  const parts = refreshToken.split('-');
  if (parts.length < 4 || parts[0] !== 'mock' || parts[1] !== 'token') {
    return res.status(401).json({ message: 'Invalid or expired refresh token' });
  }

  const userId = parts.slice(2, -1).join('-');
  const user = db.users.get(userId);

  if (!user) {
    return res.status(401).json({ message: 'Invalid or expired refresh token' });
  }

  // Cognito's refresh flow does not rotate the refresh token — production
  // echoes the original back. Mirror that.
  res.json({
    idToken: generateToken(user.id),
    accessToken: generateToken(user.id),
    refreshToken,
    expiresIn: 3600,
  });
});

app.delete('/me', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const dbUser = db.users.get(user.userId);
  if (!dbUser) return res.status(404).json({ message: 'User not found' });

  // Guard pass FIRST (mirrors handlers/me/handler.ts): if the user is the
  // lone admin in any multi-member household, refuse before any deletion.
  for (const m of dbUser.memberships) {
    const members = membersOf(m.householdId);
    const admins = members.filter((x) => x.role === 'admin');
    const isLoneAdmin = admins.length === 1 && admins[0].userId === dbUser.id;
    if (isLoneAdmin && members.length > 1) {
      return res.status(400).json({
        message: 'Promote another member to admin before deleting your account',
      });
    }
  }

  // Destructive pass: solo households are abandoned — wipe plants (cascading
  // tasks + photos) and revoke API keys; then remove the membership row.
  for (const m of dbUser.memberships) {
    const members = membersOf(m.householdId);
    if (members.length === 1) {
      for (const [pid, p] of db.plants.entries()) {
        if (p.householdId === m.householdId) db.plants.delete(pid);
      }
      for (const [tid, t] of db.tasks.entries()) {
        if (t.householdId === m.householdId) db.tasks.delete(tid);
      }
      for (const [phid, ph] of db.photos.entries()) {
        if (ph.householdId === m.householdId) db.photos.delete(phid);
      }
      for (const [kid, k] of db.apiKeys.entries()) {
        if (k.householdId === m.householdId) db.apiKeys.delete(kid);
      }
      db.households.delete(m.householdId);
    }
  }
  dbUser.memberships = [];

  // User-scoped personal data: push subscriptions + notification prefs.
  for (const [key, sub] of db.pushSubscriptions.entries()) {
    if (sub.userId === dbUser.id) db.pushSubscriptions.delete(key);
  }
  for (const [key, device] of db.deviceTokens.entries()) {
    if (device.userId === dbUser.id) db.deviceTokens.delete(key);
  }
  db.notificationPrefs.delete(dbUser.id);

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
      joinedAt: m.joinedAt,
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
      joinedAt: m.joinedAt,
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
  // 403 (not 400) — matches handlers/me/handler.ts + requireHousehold.
  if (!user.householdId) return res.status(403).json({ message: 'No household selected' });
  // Same lifecycle filter as production taskService.getTasks: tasks of
  // died / gave_away plants don't surface in the feed.
  const tasks = [...db.tasks.values()].filter(
    (t) =>
      t.householdId === user.householdId &&
      (db.plants.get(t.plantId)?.status ?? 'active') === 'active'
  );
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

  // Household context comes from the resolved request user (which honors a
  // membership-validated X-Household-Id override), like production.
  res.json({
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    householdId: user.householdId,
    householdRole: user.householdRole,
  });
});

app.post('/auth/resend-code', validateBody(resendCodeSchema), (req, res) => {
  const { email } = (req as any).validatedBody;
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
  res.json({ message: 'Confirmation code resent. Check your email.' });
});

// Mirrors updateProfileSchema in handlers/auth/handler.ts.
const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

app.patch('/auth/me', authMiddleware, validateBody(updateProfileSchema), (req, res) => {
  const reqUser = (req as any).user;
  const { name } = (req as any).validatedBody;
  const dbUser = db.users.get(reqUser.userId);
  if (!dbUser) return res.status(404).json({ message: 'User not found' });
  dbUser.name = name;
  res.json({ id: dbUser.id, email: dbUser.email, name: dbUser.name });
});

// Mirrors changePasswordSchema in handlers/auth/handler.ts.
const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

app.post(
  '/auth/change-password',
  authMiddleware,
  validateBody(changePasswordSchema),
  (req, res) => {
    const reqUser = (req as any).user;
    const { oldPassword, newPassword } = (req as any).validatedBody;
    const dbUser = db.users.get(reqUser.userId);
    if (!dbUser) return res.status(404).json({ message: 'User not found' });
    if (dbUser.password !== oldPassword) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }
    dbUser.password = newPassword;
    res.json({ message: 'Password updated.' });
  }
);

app.post('/auth/forgot-password', validateBody(forgotPasswordSchema), (req, res) => {
  const { email } = (req as any).validatedBody;

  console.log('\n========================================');
  console.log('PASSWORD RESET REQUESTED');
  console.log(`Email: ${email}`);
  console.log('Reset Code: 123456');
  console.log('========================================\n');

  // Never reveal whether the account exists.
  res.json({ message: 'If an account exists, a reset code has been sent.' });
});

app.post('/auth/reset-password', validateBody(resetPasswordSchema), (req, res) => {
  const { email, code, newPassword } = (req as any).validatedBody;

  const user = findUserByEmail(email);
  // Unknown user folds into the invalid-code answer — don't leak existence.
  if (!user || code !== '123456') {
    return res.status(400).json({ message: 'Invalid reset code' });
  }

  user.password = newPassword;
  console.log(`Password reset for ${email}`);

  res.json({ message: 'Password reset successfully. Please login with your new password.' });
});

// ============ HOUSEHOLD ROUTES ============

app.post('/households', authMiddleware, validateBody(createHouseholdSchema), (req, res) => {
  const { name } = (req as any).validatedBody;
  const user = (req as any).user;

  const householdId = uuidv4();
  const dbUser = db.users.get(user.userId);

  if (!dbUser) {
    return res.status(404).json({ message: 'User not found' });
  }

  const now = new Date().toISOString();
  const household: Household = {
    id: householdId,
    name,
    createdAt: now,
    createdBy: user.userId,
  };
  db.households.set(householdId, household);

  // Always append to memberships (multi-household). Only mark as default
  // if the user doesn't already have one — first-household-wins to keep
  // legacy clients without an X-Household-Id header working.
  dbUser.memberships.push({ householdId, role: 'admin', joinedAt: now });
  if (!dbUser.householdId) {
    dbUser.householdId = householdId;
    dbUser.householdRole = 'admin';
  }

  // Production returns the household record itself (no `role` field).
  res.status(201).json(household);
});

app.get('/households/:id', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  // Path must match the caller's resolved (membership-validated) household.
  if (user.householdId !== req.params.id) {
    return res.status(403).json({ message: 'Access denied' });
  }

  const household = db.households.get(req.params.id);
  if (!household) {
    return res.status(404).json({ message: 'Household not found' });
  }

  res.json({
    ...household,
    members: membersOf(req.params.id),
  });
});

// Climate endpoints. Local dev doesn't have an OpenWeatherMap key wired up;
// `getClimate` reports `configured: false` with `weather: null` and an empty
// tips array so the frontend exercises the disabled path (production returns
// exactly these three fields — no `location`). `setLocation` performs a
// no-op geocode that just stores the supplied city verbatim.
app.get('/households/:id/climate', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  if (req.params.id !== user.householdId) {
    return res.status(403).json({ message: 'Access denied' });
  }
  const household = db.households.get(req.params.id);
  if (!household) return res.status(404).json({ message: 'Household not found' });
  res.json({
    configured: false,
    weather: null,
    tips: [],
  });
});

// Mirrors locationSchema in handlers/climate/handler.ts.
const locationSchema = z.union([
  z.null(),
  z.object({
    city: z.string().min(1).max(120),
  }),
]);

app.put(
  '/households/:id/location',
  authMiddleware,
  requireHousehold,
  validateBody(locationSchema),
  (req, res) => {
    const user = (req as any).user;
    if (req.params.id !== user.householdId) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (user.householdRole !== 'admin') {
      return res.status(403).json({ message: 'Only household admins can set the location' });
    }
    const household = db.households.get(req.params.id);
    if (!household) return res.status(404).json({ message: 'Household not found' });
    const body = (req as any).validatedBody;
    if (body === null) {
      household.location = null;
      return res.json(household);
    }
    const city = body.city.trim();
    if (city.length === 0) {
      // Production geocodes the city and 400s when nothing matches.
      return res.status(400).json({
        message:
          'Could not find that location. Try adding the country (e.g. "Austin, US") or a more specific spelling.',
      });
    }
    // Stub geocode for local dev: store the typed city with placeholder coords
    // so the frontend round-trip works end-to-end without a key.
    household.location = { city, lat: 0, lon: 0 };
    res.json(household);
  }
);

app.post('/households/:id/invites', authMiddleware, requireHousehold, requireAdmin, (req, res) => {
  const user = (req as any).user;
  if (user.householdId !== req.params.id) {
    return res.status(403).json({ message: 'Access denied' });
  }
  if (!db.households.has(req.params.id)) {
    return res.status(404).json({ message: 'Household not found' });
  }

  // 32 hex chars, like householdService.createInvite.
  const code = uuidv4().replace(/-/g, '');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.invites.set(code, {
    code,
    householdId: req.params.id,
    createdBy: user.userId,
    createdAt: now.toISOString(),
    expiresAt,
  });

  const baseUrl =
    process.env.FRONTEND_URL ||
    process.env.ALLOWED_ORIGIN ||
    `http://localhost:${process.env.FRONTEND_PORT || 3000}`;

  // Mirror the Lambda response shape: { code, expiresAt, url }. The frontend
  // householdService and HouseholdPage both consume `data.url` directly.
  const payload = { code, expiresAt, url: `${baseUrl}/join/${code}` };

  console.log('\n========================================');
  console.log('HOUSEHOLD INVITE CREATED');
  console.log(`Household: ${String(req.params.id)}`);
  console.log(`Invite Code: ${code}`);
  console.log(`URL: ${payload.url}`);
  console.log('========================================\n');

  res.status(201).json(payload);
});

// --- Plant-sitter links (authed management) -------------------------------
// Mirrors handlers/households/handler.ts: createSitterLink / listSitterLinks /
// revokeSitterLink. Admin-gated, like invites.

/** Non-secret view of a sitter link (no token). Mirrors toSummary. */
function sitterSummary(link: SitterLink) {
  const { token: _token, ...summary } = link;
  void _token;
  return summary;
}

// POST /households/:id/sitter-links
app.post(
  '/households/:id/sitter-links',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  validateBody(createSitterLinkSchema),
  (req, res) => {
    const user = (req as any).user;
    if (user.householdId !== req.params.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const body = (req as any).validatedBody;
    const now = new Date();
    const token = randomBytes(32).toString('hex'); // 256-bit, like the service
    const link: SitterLink = {
      id: uuidv4(),
      token,
      householdId: req.params.id,
      createdBy: user.userId,
      createdAt: now.toISOString(),
      startsAt: body.startsAt ?? now.toISOString(),
      expiresAt: body.expiresAt,
      status: 'active',
      label: body.label ?? null,
    };
    db.sitterLinks.set(token, link);

    const baseUrl =
      process.env.FRONTEND_URL ||
      process.env.ALLOWED_ORIGIN ||
      `http://localhost:${process.env.FRONTEND_PORT || 3000}`;

    res.status(201).json({ ...sitterSummary(link), token, url: `${baseUrl}/sit/${token}` });
  }
);

// GET /households/:id/sitter-links
app.get(
  '/households/:id/sitter-links',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  (req, res) => {
    const user = (req as any).user;
    if (user.householdId !== req.params.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const links = [...db.sitterLinks.values()]
      .filter((l) => l.householdId === req.params.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(sitterSummary);
    res.json(links);
  }
);

// DELETE /households/:id/sitter-links/:linkId
app.delete(
  '/households/:id/sitter-links/:linkId',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  (req, res) => {
    const user = (req as any).user;
    if (user.householdId !== req.params.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const target = [...db.sitterLinks.values()].find(
      (l) => l.householdId === req.params.id && l.id === req.params.linkId
    );
    if (!target) {
      return res.status(404).json({ message: 'Sitter link not found' });
    }
    target.status = 'revoked';
    res.status(204).end();
  }
);

/** Token → link only if active and within [startsAt, expiresAt]. Generic
 *  null on any miss, mirroring sitterService.getActiveLink. */
function getActiveSitterLink(token: string): SitterLink | null {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const link = db.sitterLinks.get(token);
  if (!link || link.status !== 'active') return null;
  const nowIso = new Date().toISOString();
  if (nowIso < link.startsAt || nowIso > link.expiresAt) return null;
  return link;
}

/** Expiry-checked invite lookup; mirrors householdService.getInvite. */
function getValidInvite(code: string): Invite | null {
  const invite = db.invites.get(code);
  if (!invite) return null;
  if (new Date(invite.expiresAt) < new Date()) return null;
  return invite;
}

// GET /households/invites/:inviteCode
// Unauthenticated by design — invite recipients haven't signed in yet.
app.get('/households/invites/:inviteCode', (req, res) => {
  const invite = getValidInvite(req.params.inviteCode);
  if (!invite) {
    return res.json({ valid: false });
  }
  const household = db.households.get(invite.householdId);
  res.json({
    valid: true,
    household: household ? { id: household.id, name: household.name } : null,
  });
});

// POST /households/join/:inviteCode
// Mirrors handlers/households/handler.ts:joinHousehold — invite validation
// (existence + expiry), member-cap check against the household's plan, and
// an already-a-member guard.
app.post('/households/join/:inviteCode', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const dbUser = db.users.get(user.userId);
  if (!dbUser) {
    return res.status(404).json({ message: 'User not found' });
  }

  const invite = getValidInvite(req.params.inviteCode);
  if (!invite) {
    return res.status(400).json({ message: 'Invalid or expired invite' });
  }

  const household = db.households.get(invite.householdId);
  if (!household) {
    return res.status(400).json({ message: 'Household not found' });
  }

  const plan = PLANS[household.planId ?? 'seedling'];
  const existingMembers = membersOf(invite.householdId);
  if (existingMembers.length >= plan.maxMembers) {
    return res.status(402).json({
      message: `This household is on the ${plan.name} plan, limited to ${plan.maxMembers} members.`,
    });
  }

  if (dbUser.memberships.some((m) => m.householdId === invite.householdId)) {
    return res.status(400).json({ message: 'You are already a member of this household' });
  }

  dbUser.memberships.push({
    householdId: invite.householdId,
    role: 'member',
    joinedAt: new Date().toISOString(),
  });
  // Same default-household rule as createHousehold: only stamp the claim
  // on the first one.
  if (!dbUser.householdId) {
    dbUser.householdId = invite.householdId;
    dbUser.householdRole = 'member';
  }

  recordActivity({
    type: 'member.joined',
    householdId: invite.householdId,
    actorId: dbUser.id,
    actorName: dbUser.name,
    payload: { role: 'member' },
  });

  // Production returns the household record.
  res.json(household);
});

app.put(
  '/households/:householdId/members/:userId/role',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  validateBody(updateMemberRoleSchema),
  (req, res) => {
    const { householdId, userId } = req.params;
    const { role } = (req as any).validatedBody;
    const caller = (req as any).user;
    if (caller.householdId !== householdId) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (caller.userId === userId && role !== 'admin') {
      return res.status(400).json({ message: 'Admins cannot demote themselves' });
    }
    const target = db.users.get(userId);
    const membership = target?.memberships.find((m) => m.householdId === householdId);
    if (!target || !membership) {
      return res.status(404).json({ message: 'Member not found' });
    }
    membership.role = role;
    // Claims hygiene (production: only rewrite the target's claims when THIS
    // household is their current default household).
    if (target.householdId === householdId) {
      target.householdRole = role;
    }
    res.json({
      householdId,
      userId,
      name: target.name,
      email: target.email,
      role,
      joinedAt: membership.joinedAt,
    });
  }
);

// DELETE /households/:householdId/members/:userId
app.delete(
  '/households/:householdId/members/:userId',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  (req, res) => {
    const { householdId, userId } = req.params;
    const caller = (req as any).user;
    if (caller.householdId !== householdId) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (caller.userId === userId) {
      return res.status(400).json({ message: 'Cannot remove yourself from household' });
    }
    const target = db.users.get(userId);
    const membership = target?.memberships.find((m) => m.householdId === householdId);
    if (!target || !membership) {
      return res.status(404).json({ message: 'Member not found' });
    }
    target.memberships = target.memberships.filter((m) => m.householdId !== householdId);
    // Claims hygiene, mirroring production removeMember: only re-point the
    // default household when the removed one WAS the default; pick another
    // remaining membership or clear.
    if (target.householdId === householdId) {
      const next = target.memberships[0];
      if (next) {
        target.householdId = next.householdId;
        target.householdRole = next.role;
      } else {
        target.householdId = null;
        target.householdRole = null;
      }
    }
    res.status(204).send();
  }
);

// ============ PLANT ROUTES ============

app.get('/plants', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const filter =
    req.query.filter === 'past' || req.query.filter === 'all' ? req.query.filter : 'active';
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

app.post(
  '/plants',
  authMiddleware,
  requireHousehold,
  validateBody(createPlantSchema),
  (req, res) => {
    const user = (req as any).user;
    const { name, species, location, notes, tags, perenualSpeciesId, parentPlantId } = (req as any)
      .validatedBody;

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

    // Propagation: the parent must exist in the SAME household (mirrors the
    // production handler's pre-create check).
    let parentPlant: Plant | undefined;
    if (parentPlantId) {
      parentPlant = db.plants.get(parentPlantId);
      if (!parentPlant || parentPlant.householdId !== user.householdId) {
        return res.status(400).json({ message: 'Parent plant not found in this household' });
      }
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
      tags: (tags ?? [])
        .map((t: string) => t.trim())
        .filter(Boolean)
        .slice(0, 10),
      perenualSpeciesId: perenualSpeciesId ?? null,
      parentPlantId: parentPlantId ?? null,
      createdAt: now,
      createdBy: user.userId,
      updatedAt: now,
    };

    db.plants.set(plantId, plant);
    // Parented creates record 'plant.propagated' instead of 'plant.created'
    // (one feed row per create), like production.
    recordActivity({
      type: parentPlant ? 'plant.propagated' : 'plant.created',
      householdId: user.householdId,
      actorId: user.userId,
      actorName: db.users.get(user.userId)?.name ?? user.email.split('@')[0],
      payload: parentPlant
        ? {
            plantId,
            plantName: plant.name,
            parentPlantId: parentPlant.id,
            parentPlantName: parentPlant.name,
          }
        : { plantId, plantName: plant.name },
    });

    res.status(201).json(plant);
  }
);

// Mirrors handlers/plants/import.ts: partial success, per-row results, plan
// cap enforced per row, ONE 'plants.imported' activity entry for the batch.
app.post(
  '/plants/import',
  authMiddleware,
  requireHousehold,
  validateBody(importPlantsSchema),
  (req, res) => {
    const user = (req as any).user;
    const { plants } = (req as any).validatedBody;

    const h = db.households.get(user.householdId);
    const plan = PLANS[h?.planId ?? 'seedling'];
    const planLimitMessage = `Plan limit reached: your ${plan.name} plan is limited to ${plan.maxPlants} plants. Upgrade to import more.`;

    const results: Array<{
      index: number;
      status: 'created' | 'skipped';
      plantId?: string;
      error?: string;
    }> = [];
    let created = 0;
    let planLimitHit = false;

    for (let index = 0; index < plants.length; index++) {
      if (planLimitHit) {
        results.push({ index, status: 'skipped', error: planLimitMessage });
        continue;
      }
      // Same active-plant cap check as POST /plants.
      const active = [...db.plants.values()].filter(
        (p) => p.householdId === user.householdId && (p.status ?? 'active') === 'active'
      );
      if (active.length >= plan.maxPlants) {
        planLimitHit = true;
        results.push({ index, status: 'skipped', error: planLimitMessage });
        continue;
      }

      const { tasks, acquiredAt: _acquiredAt, ...input } = plants[index];
      const plantId = uuidv4();
      const now = new Date().toISOString();
      const plant: Plant = {
        id: plantId,
        householdId: user.householdId,
        name: input.name,
        species: input.species || null,
        location: input.location || null,
        imageUrl: null,
        notes: input.notes || null,
        status: 'active',
        statusChangedAt: null,
        tags: (input.tags ?? [])
          .map((t: string) => t.trim())
          .filter(Boolean)
          .slice(0, 10),
        perenualSpeciesId: input.perenualSpeciesId ?? null,
        parentPlantId: null,
        createdAt: now,
        createdBy: user.userId,
        updatedAt: now,
      };
      db.plants.set(plantId, plant);

      for (const def of tasks ?? []) {
        buildTask({ ...def, plantId }, user.householdId, user.userId, plant.name);
      }

      created += 1;
      results.push({ index, status: 'created', plantId });
    }

    if (created > 0) {
      recordActivity({
        type: 'plants.imported',
        householdId: user.householdId,
        actorId: user.userId,
        actorName: db.users.get(user.userId)?.name ?? user.email.split('@')[0],
        payload: { count: created },
      });
    }

    res.json({ results, created, skipped: results.length - created, planLimitHit });
  }
);

app.get('/plants/:id', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const plant = db.plants.get(req.params.id);

  // Household-scoped, like plantService.getPlant(householdId, plantId).
  if (!plant || plant.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Plant not found' });
  }

  // Get tasks for this plant
  const upcomingTasks: Task[] = [];
  for (const task of db.tasks.values()) {
    if (task.plantId === req.params.id && task.householdId === user.householdId) {
      upcomingTasks.push({ ...task, plantName: plant.name });
    }
  }
  upcomingTasks.sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime());
  const recentCompletions: Completion[] = [];
  for (const c of db.completions.values()) {
    if (c.plantId === req.params.id && c.householdId === user.householdId) {
      recentCompletions.push(c);
    }
  }
  recentCompletions.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));

  // Propagation lineage, mirroring plantService.getLineage: children by
  // filtering the household's plants (died children included); parent
  // omitted if it was hard-deleted.
  const lineage: {
    parent?: { id: string; name: string; status: string };
    children: Array<{ id: string; name: string; status: string; createdAt: string }>;
  } = {
    children: [...db.plants.values()]
      .filter((p) => p.householdId === user.householdId && p.parentPlantId === plant.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((p) => ({ id: p.id, name: p.name, status: p.status, createdAt: p.createdAt })),
  };
  if (plant.parentPlantId) {
    const parent = db.plants.get(plant.parentPlantId);
    if (parent && parent.householdId === user.householdId) {
      lineage.parent = { id: parent.id, name: parent.name, status: parent.status };
    }
  }

  res.json({ ...plant, upcomingTasks, recentCompletions: recentCompletions.slice(0, 10), lineage });
});

app.put(
  '/plants/:id',
  authMiddleware,
  requireHousehold,
  validateBody(updatePlantSchema),
  (req, res) => {
    const user = (req as any).user;
    const plant = db.plants.get(req.params.id);

    if (!plant || plant.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Plant not found' });
    }

    const body = (req as any).validatedBody;

    if (body.name !== undefined) plant.name = body.name;
    if (body.species !== undefined) plant.species = body.species;
    if (body.location !== undefined) plant.location = body.location;
    if (body.notes !== undefined) plant.notes = body.notes;
    if (body.tags !== undefined) {
      plant.tags = body.tags
        .map((t: string) => t.trim())
        .filter(Boolean)
        .slice(0, 10);
    }
    if (body.perenualSpeciesId !== undefined) {
      plant.perenualSpeciesId = body.perenualSpeciesId;
    }
    if (body.parentPlantId !== undefined) {
      // Mirrors the production handler: reject self-parenting, parents
      // outside this household, and parents that would close a cycle; null
      // detaches.
      if (body.parentPlantId !== null) {
        if (body.parentPlantId === plant.id) {
          return res.status(400).json({ message: 'A plant cannot be its own parent' });
        }
        const parent = db.plants.get(body.parentPlantId);
        if (!parent || parent.householdId !== user.householdId) {
          return res.status(400).json({ message: 'Parent plant not found in this household' });
        }
        if (plant.parentPlantId !== body.parentPlantId) {
          // Cycle guard: walk the proposed parent's ancestors looking for
          // this plant. Capped at 50 hops — real chains never get that deep,
          // so hitting the cap means reject rather than loop forever.
          let ancestorId: string | null = parent.parentPlantId;
          let hops = 0;
          while (ancestorId) {
            if (ancestorId === plant.id) {
              return res.status(400).json({
                message:
                  'That plant is already a descendant of this one; setting it as parent would create a circular lineage',
              });
            }
            if (++hops >= 50) {
              return res.status(400).json({ message: 'Propagation chain is too long to validate' });
            }
            const ancestor: typeof parent | undefined = db.plants.get(ancestorId);
            ancestorId = ancestor?.parentPlantId ?? null;
          }
        }
      }
      plant.parentPlantId = body.parentPlantId;
    }
    if (body.status !== undefined && body.status !== plant.status) {
      const previousStatus = plant.status;
      plant.status = body.status;
      plant.statusChangedAt = new Date().toISOString();
      const lifecycleType = {
        active: 'plant.restored',
        archived: 'plant.archived',
        died: 'plant.died',
        gave_away: 'plant.gave_away',
      }[body.status] as ActivityEvent['type'];
      recordActivity({
        type: lifecycleType,
        householdId: user.householdId,
        actorId: user.userId,
        actorName: db.users.get(user.userId)?.name ?? user.email.split('@')[0],
        payload: { plantId: plant.id, plantName: plant.name, previousStatus },
      });
    }
    plant.updatedAt = new Date().toISOString();

    res.json(plant);
  }
);

app.delete('/plants/:id', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const plant = db.plants.get(req.params.id);

  if (!plant || plant.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Plant not found' });
  }

  db.plants.delete(req.params.id);

  // Cascade tasks + photos, like plantService.deletePlant.
  for (const [taskId, task] of db.tasks.entries()) {
    if (task.plantId === req.params.id) {
      db.tasks.delete(taskId);
    }
  }
  for (const [photoId, photo] of db.photos.entries()) {
    if (photo.plantId === req.params.id) {
      db.photos.delete(photoId);
    }
  }

  res.status(204).send();
});

// Mirrors identifySchema in handlers/plants/identify.ts.
const identifySchema = z.object({
  image: z.string().min(64).max(350_000, 'Image too large; resize to under 256 KB'),
});

// Mirrors services/identifyBudget.ts: in-memory monthly identification usage
// keyed `${yyyy-mm}#${householdId | user:userId}`. Enforcement only when
// IDENTIFY_METERING_ENABLED=1, matching production (default off for beta).
const IDENTIFY_ALLOWANCES: Record<string, number> = { seedling: 3, garden: 30, greenhouse: 100 };
const identifyUsage = new Map<string, number>();

function identifyMeterFor(user: { userId: string; householdId: string | null }) {
  const ym = new Date().toISOString().slice(0, 7);
  const bucketId = user.householdId ?? `user:${user.userId}`;
  const key = `${ym}#${bucketId}`;
  const planId = user.householdId
    ? (db.households.get(user.householdId)?.planId ?? 'seedling')
    : 'seedling';
  const plan = PLANS[planId] ?? PLANS.seedling;
  return {
    key,
    planName: plan.name,
    allowance: IDENTIFY_ALLOWANCES[planId] ?? IDENTIFY_ALLOWANCES.seedling,
    used: identifyUsage.get(key) ?? 0,
    meteringEnabled: process.env.IDENTIFY_METERING_ENABLED === '1',
  };
}

app.post('/plants/identify', authMiddleware, validateBody(identifySchema), async (req, res) => {
  const { image } = (req as any).validatedBody;
  const meter = identifyMeterFor((req as any).user);
  if (meter.meteringEnabled && meter.used >= meter.allowance) {
    // Mirrors the production 402 contract: plan name + upgrade pointer.
    return res.status(402).json({
      message: `Your ${meter.planName} plan is limited to ${meter.allowance} plant identifications per month. Upgrade for a higher monthly allowance.`,
    });
  }
  if (!process.env.PLANT_ID_API_KEY) {
    // Local dev fallback: return a couple of suggestions so the UI flow can
    // be exercised without burning real API credits. Not-configured calls
    // consume no upstream credit, so usage is not incremented (matches prod).
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
      usage: {
        used: meter.used,
        allowance: meter.allowance,
        meteringEnabled: meter.meteringEnabled,
      },
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
    const used = meter.used + 1;
    identifyUsage.set(meter.key, used);
    res.json({
      configured: true,
      suggestions,
      usage: { used, allowance: meter.allowance, meteringEnabled: meter.meteringEnabled },
    });
  } catch (err: any) {
    res.status(502).json({ message: err.message });
  }
});

// Mirrors healthCheckSchema in handlers/plants/health.ts.
const healthCheckSchema = z.object({
  imageBase64: z.string().min(64).max(350_000, 'Image too large; resize to under 256 KB'),
});

// POST /plants/:id/health-check — leaf-health check (handlers/plants/health.ts).
// The mock always returns the canned demo assessment (the production handler
// does the same when Bedrock access is unavailable), so the dialog flow can be
// exercised locally without AWS credentials.
app.post(
  '/plants/:id/health-check',
  authMiddleware,
  requireHousehold,
  validateBody(healthCheckSchema),
  (req, res) => {
    const user = (req as any).user;
    const plant = db.plants.get(req.params.id);
    // Household-scoped, like plantService.getPlant(householdId, plantId).
    if (!plant || plant.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Plant not found' });
    }
    res.json({
      demo: true,
      overall: 'monitor',
      observations: [
        {
          sign: 'demo mode',
          confidence: 'low',
          note: 'Image analysis is not configured on this server, so this is a canned example result.',
        },
      ],
      suggestion:
        'Keep an eye on the leaf over the next week and compare against a new photo. (Demo response — no analysis was performed.)',
      disclaimer:
        'This is a cosmetic visual check from a single photo, not a plant-health diagnosis.',
    });
  }
);

// Image upload contract (mirrors handlers/plants/handler.ts):
//   POST /plants/:id/image           — optional { contentType } ∈ jpeg/png/webp
//                                      (default jpeg); key extension matches.
//   POST /plants/:id/image/confirm   — imageUrl must match a key we'd mint for
//                                      this plant (either URL form); the mock
//                                      skips the S3 HeadObject size check.
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Mirrors imageUploadRequestSchema in handlers/plants/handler.ts (body is
// optional/nullable for legacy clients that POST with no body).
const imageUploadRequestSchema = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
  })
  .nullable();

const IMAGES_BUCKET = process.env.IMAGES_BUCKET || 'family-greenhouse-images-local';

/** Same base-URL policy as production publicImageUrl(). */
function imageBaseUrl(): string {
  const base = process.env.ASSETS_BASE_URL?.replace(/\/+$/, '');
  if (base) return base;
  return `https://${IMAGES_BUCKET}.s3.amazonaws.com`;
}

app.post(
  '/plants/:id/image',
  authMiddleware,
  requireHousehold,
  validateBody(imageUploadRequestSchema),
  (req, res) => {
    const user = (req as any).user;
    const plant = db.plants.get(req.params.id);
    if (!plant || plant.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Plant not found' });
    }
    const body = (req as any).validatedBody;
    const contentType = body?.contentType ?? 'image/jpeg';
    const ext = IMAGE_CONTENT_TYPES[contentType];
    const key = `plants/${user.householdId}/${String(req.params.id)}/${uuidv4()}.${ext}`;
    res.json({
      uploadUrl: `http://127.0.0.1:${PORT}/mock-upload`,
      imageUrl: `${imageBaseUrl()}/${key}`,
    });
  }
);

app.post(
  '/plants/:id/image/confirm',
  authMiddleware,
  requireHousehold,
  validateBody(confirmImageUploadSchema),
  (req, res) => {
    const user = (req as any).user;
    const { imageUrl } = (req as any).validatedBody;
    const keyPrefix = `plants/${user.householdId}/${String(req.params.id)}/`;
    // Accept whichever URL forms production can mint; both map to one S3 key.
    const assetsBase = process.env.ASSETS_BASE_URL?.replace(/\/+$/, '');
    const expectedPrefixes = [`https://${IMAGES_BUCKET}.s3.amazonaws.com/${keyPrefix}`];
    if (assetsBase) expectedPrefixes.unshift(`${assetsBase}/${keyPrefix}`);
    const matchedPrefix = expectedPrefixes.find((p) => imageUrl.startsWith(p));
    if (!matchedPrefix) {
      return res
        .status(400)
        .json({ message: 'imageUrl does not match a key issued for this plant' });
    }
    // The remainder must look exactly like a key we minted (uuid.ext) — no
    // slashes, dots, or query strings smuggling a different object.
    const filename = imageUrl.slice(matchedPrefix.length);
    if (!/^[A-Za-z0-9-]+\.(jpg|png|webp)$/.test(filename)) {
      return res
        .status(400)
        .json({ message: 'imageUrl does not match a key issued for this plant' });
    }
    const plant = db.plants.get(req.params.id);
    if (!plant || plant.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Plant not found' });
    }
    // Production HeadObjects the key here and rejects objects > 5 MiB; the
    // mock has no object store, so it accepts and skips the size check.
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
      caption: null,
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
  }
);

app.get('/plants/:id/photos', authMiddleware, requireHousehold, (req, res) => {
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

// ============ CUTTING SHARES ============

/** Expiry-checked share lookup; mirrors plantService.getPlantShare. Shares
 *  are multi-redeem within their TTL (cutting card, not a security token). */
function getValidShare(code: string): PlantShare | null {
  const share = db.shares.get(code);
  if (!share) return null;
  if (new Date(share.expiresAt) < new Date()) return null;
  return share;
}

// POST /plants/:id/share — mint a share code with a frozen card snapshot
// (later edits/deletes of the source plant don't change the share).
app.post('/plants/:id/share', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const plant = db.plants.get(req.params.id);
  if (!plant || plant.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Plant not found' });
  }

  // 32 hex chars + 14-day TTL, like plantService.createPlantShare.
  const code = uuidv4().replace(/-/g, '');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
  db.shares.set(code, {
    code,
    plantId: plant.id,
    householdId: plant.householdId,
    plantSnapshot: {
      name: plant.name,
      species: plant.species,
      notes: plant.notes,
      imageUrl: plant.imageUrl,
      tags: [...plant.tags],
    },
    createdBy: user.userId,
    createdAt: now.toISOString(),
    expiresAt,
  });

  const baseUrl =
    process.env.FRONTEND_URL ||
    process.env.ALLOWED_ORIGIN ||
    `http://localhost:${process.env.FRONTEND_PORT || 3000}`;

  res.status(201).json({ code, expiresAt, url: `${baseUrl}/shared/${code}` });
});

// GET /plants/shared/:code
// PUBLIC (no auth) by design — recipients usually aren't signed in yet,
// exactly like the invite preview. 404 for unknown/expired codes.
app.get('/plants/shared/:code', (req, res) => {
  const share = getValidShare(req.params.code);
  if (!share) {
    return res.status(404).json({ message: 'This share link is invalid or has expired' });
  }
  const household = db.households.get(share.householdId);
  res.json({
    plant: share.plantSnapshot,
    householdName: household?.name ?? 'A Family Greenhouse household',
    expiresAt: share.expiresAt,
  });
});

// --- Plant-sitter PUBLIC endpoints (no auth) ------------------------------
// Mirrors handlers/tasks/handler.ts: getSitterView / completeSitterTask. The
// 256-bit token in the path is the only credential; we validate it on every
// call and expose ONLY the PII-free due-task projection.

/** PII-free due/overdue tasks for a household. Mirrors taskService.getSitterTasks:
 *  due within 7 days OR overdue, active plants only, minimal fields. */
function sitterTasksFor(householdId: string) {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + 7);
  const cutoffIso = cutoff.toISOString();
  const nowIso = now.toISOString();
  return [...db.tasks.values()]
    .filter((t) => t.householdId === householdId)
    .filter((t) => (db.plants.get(t.plantId)?.status ?? 'active') === 'active')
    .filter((t) => t.nextDue <= cutoffIso)
    .sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime())
    .map((t) => ({
      taskId: t.id,
      plantName: t.plantName,
      taskType: t.customType || t.type,
      dueDate: t.nextDue,
      overdue: t.nextDue < nowIso,
    }));
}

// GET /sitter/:token
app.get('/sitter/:token', (req, res) => {
  const link = getActiveSitterLink(req.params.token);
  if (!link) {
    return res.status(404).json({ message: 'This sitter link is invalid or has expired.' });
  }
  res.json({
    label: link.label,
    expiresAt: link.expiresAt,
    tasks: sitterTasksFor(link.householdId),
  });
});

// POST /sitter/:token/tasks/:taskId/complete
app.post('/sitter/:token/tasks/:taskId/complete', (req, res) => {
  const link = getActiveSitterLink(req.params.token);
  if (!link) {
    return res.status(404).json({ message: 'This sitter link is invalid or has expired.' });
  }
  const task = db.tasks.get(req.params.taskId);
  // Cross-household guard: the task must live in the token's household.
  if (!task || task.householdId !== link.householdId) {
    return res.status(404).json({ message: 'Task not found' });
  }

  const now = new Date();
  const nextDue = new Date(now);
  nextDue.setDate(nextDue.getDate() + task.frequency);
  task.lastCompleted = now.toISOString();
  task.nextDue = nextDue.toISOString();

  const completionId = uuidv4();
  db.completions.set(completionId, {
    id: completionId,
    householdId: task.householdId,
    plantId: task.plantId,
    taskId: task.id,
    taskType: task.customType || task.type,
    completedBy: `sitter:${link.id}`,
    completedByName: 'a plant sitter',
    completedAt: now.toISOString(),
    notes: null,
  });
  recordActivity({
    type: 'task.completed',
    householdId: task.householdId,
    actorId: `sitter:${link.id}`,
    actorName: 'a plant sitter',
    payload: {
      taskId: task.id,
      plantId: task.plantId,
      plantName: task.plantName,
      taskType: task.customType || task.type,
      viaSitter: true,
    },
  });

  res.json({
    taskId: task.id,
    plantName: task.plantName,
    taskType: task.customType || task.type,
    dueDate: task.nextDue,
    overdue: false,
  });
});

// POST /plants/shared/:code/accept — copy the card into the CALLER's
// household via the normal create path (plan cap applies → 402). Accepting
// into the source household is allowed (harmless duplicate); the image is
// not copied (the S3 object belongs to the source household).
app.post('/plants/shared/:code/accept', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const share = getValidShare(req.params.code);
  if (!share) {
    return res.status(404).json({ message: 'This share link is invalid or has expired' });
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

  const fromName = db.households.get(share.householdId)?.name ?? 'another household';
  const prefix = `Cutting from ${fromName}`;
  const notes = (
    share.plantSnapshot.notes ? `${prefix}\n\n${share.plantSnapshot.notes}` : prefix
  ).slice(0, 1000);

  const plantId = uuidv4();
  const now = new Date().toISOString();
  const plant: Plant = {
    id: plantId,
    householdId: user.householdId,
    name: share.plantSnapshot.name,
    species: share.plantSnapshot.species,
    location: null,
    imageUrl: null,
    notes,
    status: 'active',
    statusChangedAt: null,
    tags: [...share.plantSnapshot.tags],
    perenualSpeciesId: null,
    parentPlantId: null,
    createdAt: now,
    createdBy: user.userId,
    updatedAt: now,
  };
  db.plants.set(plantId, plant);

  recordActivity({
    type: 'plant.shared_accepted',
    householdId: user.householdId,
    actorId: user.userId,
    actorName: db.users.get(user.userId)?.name ?? user.email.split('@')[0],
    payload: { plantId, plantName: plant.name, fromHouseholdName: fromName },
  });

  res.status(201).json(plant);
});

// ============ TASK ROUTES ============

/** Lifecycle filter shared by every task list view (taskService.getTasks). */
function isActivePlant(plantId: string): boolean {
  return (db.plants.get(plantId)?.status ?? 'active') === 'active';
}

/** Mirrors taskService.getActiveVacationMap: away-userId → active window. */
function activeVacationMap(householdId: string, nowIso = new Date().toISOString()) {
  const map = new Map<string, VacationWindow>();
  for (const w of db.vacations.values()) {
    if (w.householdId === householdId && w.startDate <= nowIso && nowIso <= w.endDate) {
      map.set(w.userId, w);
    }
  }
  return map;
}

/** Mirrors taskService.annotateTasksWithCoverage (read-time, no rewrite). */
function annotateCoverage(tasks: Task[], householdId: string) {
  const vacations = activeVacationMap(householdId);
  if (vacations.size === 0) return tasks;
  return tasks.map((t) => {
    const w = t.assignedTo ? vacations.get(t.assignedTo) : undefined;
    if (!w || w.coveredBy === t.assignedTo) return t;
    return {
      ...t,
      effectiveAssignee: w.coveredBy,
      effectiveAssigneeName: w.coveredByName,
      coveringFor: t.assignedToName,
    };
  });
}

app.get('/tasks', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;

  // Query filters, mirroring handlers/tasks/handler.ts:listTasks.
  let dueWithin: number | undefined;
  if (req.query.dueWithin) {
    const days = Number(req.query.dueWithin);
    if (!Number.isInteger(days) || days < 0) {
      return res.status(400).json({ message: 'dueWithin must be a non-negative integer' });
    }
    dueWithin = Math.min(days, 365);
  }

  let tasks = [...db.tasks.values()].filter(
    (t) => t.householdId === user.householdId && isActivePlant(t.plantId)
  );
  if (typeof req.query.plantId === 'string' && req.query.plantId.length > 0) {
    tasks = tasks.filter((t) => t.plantId === req.query.plantId);
  }
  if (typeof req.query.assignedTo === 'string' && req.query.assignedTo.length > 0) {
    tasks = tasks.filter((t) => t.assignedTo === req.query.assignedTo);
  }
  if (req.query.overdue === 'true') {
    const now = new Date().toISOString();
    tasks = tasks.filter((t) => t.nextDue < now);
  }
  if (dueWithin !== undefined) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + dueWithin);
    tasks = tasks.filter((t) => new Date(t.nextDue) <= cutoff);
  }

  res.json(
    annotateCoverage(
      tasks.map((t) => ({ ...t, plantName: db.plants.get(t.plantId)?.name ?? t.plantName })),
      user.householdId
    )
  );
});

app.get('/tasks/upcoming', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const tasks = [...db.tasks.values()]
    .filter(
      (t) =>
        t.householdId === user.householdId &&
        isActivePlant(t.plantId) &&
        new Date(t.nextDue) <= weekFromNow
    )
    .sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime())
    .map((t) => ({ ...t, plantName: db.plants.get(t.plantId)?.name ?? t.plantName }));

  res.json(annotateCoverage(tasks, user.householdId));
});

/** Mirrors taskService.createTask (denormalized plantName/assignedToName). */
function buildTask(
  input: {
    plantId: string;
    type: string;
    customType?: string | null;
    frequency: number;
    assignedTo?: string | null;
    notes?: string | null;
    nextDue?: string;
  },
  householdId: string,
  userId: string,
  plantName: string
): Task {
  const id = uuidv4();
  const now = new Date();
  // Production: nextDue defaults to NOW (the task is due immediately), not
  // now + frequency.
  const nextDue = input.nextDue || now.toISOString();
  let assignedToName: string | null = null;
  if (input.assignedTo) {
    assignedToName = db.users.get(input.assignedTo)?.name ?? null;
  }
  const task: Task = {
    id,
    householdId,
    plantId: input.plantId,
    plantName,
    type: input.type,
    customType: input.type === 'custom' ? input.customType || null : null,
    frequency: input.frequency,
    lastCompleted: null,
    nextDue,
    assignedTo: input.assignedTo || null,
    assignedToName,
    notes: input.notes || null,
    createdBy: userId,
    createdAt: now.toISOString(),
  };
  db.tasks.set(id, task);
  return task;
}

app.post('/tasks', authMiddleware, requireHousehold, validateBody(createTaskSchema), (req, res) => {
  const user = (req as any).user;
  const body = (req as any).validatedBody;

  const plant = db.plants.get(body.plantId);
  if (!plant || plant.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Plant not found' });
  }

  const task = buildTask(body, user.householdId, user.userId, plant.name);
  res.status(201).json(task);
});

app.get('/tasks/templates', (_req, res) => {
  // Same catalog module production serves (models/taskTemplates.ts).
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(TEMPLATES);
});

// ---- Vacation windows (care handoff) ----
// NOTE: registered BEFORE /tasks/:id so Express doesn't swallow "vacation"
// as a task id (API Gateway prefers the literal route automatically).

// GET /tasks/vacation — active + upcoming windows (ended ones filtered out,
// mirroring listVacationWindows' endDate >= now check = the auto-revert).
app.get('/tasks/vacation', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const nowIso = new Date().toISOString();
  const windows = [...db.vacations.values()].filter(
    (w) => w.householdId === user.householdId && w.endDate >= nowIso
  );
  res.json(windows);
});

// PUT /tasks/vacation — upsert; mirrors handlers/tasks setVacation.
app.put(
  '/tasks/vacation',
  authMiddleware,
  requireHousehold,
  validateBody(setVacationSchema),
  (req, res) => {
    const user = (req as any).user;
    const body = (req as any).validatedBody;
    const targetUserId = body.userId ?? user.userId;

    if (targetUserId !== user.userId && user.householdRole !== 'admin') {
      return res
        .status(403)
        .json({ message: 'Admin role required to set vacation for another member' });
    }
    if (body.coveredBy === targetUserId) {
      return res.status(400).json({ message: 'coveredBy must be a different household member' });
    }
    const coverMember = membersOf(user.householdId).find((m) => m.userId === body.coveredBy);
    if (!coverMember) {
      return res.status(400).json({ message: 'coveredBy must be a household member' });
    }
    const targetMember = membersOf(user.householdId).find((m) => m.userId === targetUserId);
    if (!targetMember) {
      return res.status(404).json({ message: 'Member not found' });
    }

    const window: VacationWindow = {
      householdId: user.householdId,
      userId: targetUserId,
      coveredBy: body.coveredBy,
      coveredByName: coverMember.name,
      startDate: body.startDate,
      endDate: body.endDate,
      createdBy: user.userId,
      createdAt: new Date().toISOString(),
    };
    db.vacations.set(`${user.householdId}|${targetUserId}`, window);
    res.json(window);
  }
);

// DELETE /tasks/vacation/:userId — cancel (self or admin).
app.delete('/tasks/vacation/:userId', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const targetUserId = String(req.params.userId);
  if (targetUserId !== user.userId && user.householdRole !== 'admin') {
    return res
      .status(403)
      .json({ message: 'Admin role required to cancel another member’s vacation' });
  }
  const key = `${user.householdId}|${targetUserId}`;
  if (!db.vacations.has(key)) {
    return res.status(404).json({ message: 'Vacation window not found' });
  }
  db.vacations.delete(key);
  res.status(204).send();
});

// ---- Task claiming ("up for grabs") ----

// POST /tasks/:id/claim — mirrors taskService.claimTask: 409 when already
// assigned (the mock can't race, so the sequential check is equivalent to
// production's conditional write).
app.post('/tasks/:id/claim', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const task = db.tasks.get(req.params.id);
  if (!task || task.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Task not found' });
  }
  if (task.assignedTo) {
    return res.status(409).json({ message: 'Already claimed' });
  }
  const dbUser = db.users.get(user.userId);
  task.assignedTo = user.userId;
  task.assignedToName = dbUser?.name ?? null;
  recordActivity({
    type: 'task.claimed',
    householdId: user.householdId,
    actorId: user.userId,
    actorName: dbUser?.name ?? '',
    payload: {
      taskId: task.id,
      plantId: task.plantId,
      plantName: task.plantName,
      taskType: task.customType || task.type,
    },
  });
  res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
});

// POST /tasks/:id/unclaim — only the current assignee may release.
app.post('/tasks/:id/unclaim', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const task = db.tasks.get(req.params.id);
  if (!task || task.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Task not found' });
  }
  if (task.assignedTo !== user.userId) {
    return res.status(403).json({ message: 'Only the current assignee can unclaim this task' });
  }
  task.assignedTo = null;
  task.assignedToName = null;
  const dbUser = db.users.get(user.userId);
  recordActivity({
    type: 'task.unclaimed',
    householdId: user.householdId,
    actorId: user.userId,
    actorName: dbUser?.name ?? '',
    payload: {
      taskId: task.id,
      plantId: task.plantId,
      plantName: task.plantName,
      taskType: task.customType || task.type,
    },
  });
  res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
});

app.post(
  '/plants/apply-template-bulk',
  authMiddleware,
  requireHousehold,
  validateBody(applyTemplateBulkSchema),
  (req, res) => {
    const user = (req as any).user;
    const { plantIds, templateId } = (req as any).validatedBody;
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return res.status(404).json({ message: 'Unknown template' });
    const applied: Array<{ plantId: string; taskIds: string[] }> = [];
    const skipped: Array<{ plantId: string; reason: string }> = [];
    for (const plantId of plantIds) {
      const plant = db.plants.get(plantId);
      if (!plant || plant.householdId !== user.householdId) {
        skipped.push({ plantId, reason: 'not_found' });
        continue;
      }
      const taskIds: string[] = [];
      for (const def of tpl.tasks) {
        const task = buildTask(
          {
            plantId,
            type: def.type,
            customType: def.customType,
            frequency: def.frequencyDays,
            notes: def.notes,
          },
          user.householdId,
          user.userId,
          plant.name
        );
        taskIds.push(task.id);
      }
      applied.push({ plantId, taskIds });
    }
    res.json({ applied, skipped });
  }
);

app.post(
  '/plants/:plantId/apply-template',
  authMiddleware,
  requireHousehold,
  validateBody(applyTemplateSchema),
  (req, res) => {
    const user = (req as any).user;
    const tpl = TEMPLATES.find((t) => t.id === (req as any).validatedBody.templateId);
    if (!tpl) return res.status(404).json({ message: 'Unknown template' });
    const plant = db.plants.get(req.params.plantId);
    if (!plant || plant.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Plant not found' });
    }

    const created: Task[] = [];
    for (const def of tpl.tasks) {
      created.push(
        buildTask(
          {
            plantId: plant.id,
            type: def.type,
            customType: def.customType,
            frequency: def.frequencyDays,
            notes: def.notes,
          },
          user.householdId,
          user.userId,
          plant.name
        )
      );
    }
    res.json({ created });
  }
);

app.get('/tasks/:id', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const task = db.tasks.get(req.params.id);
  if (!task || task.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Task not found' });
  }
  res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
});

app.put(
  '/tasks/:id',
  authMiddleware,
  requireHousehold,
  validateBody(updateTaskSchema),
  (req, res) => {
    const user = (req as any).user;
    const task = db.tasks.get(req.params.id);

    if (!task || task.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const body = (req as any).validatedBody;

    // Mirror taskService.updateTask: explicit nulls clear, undefined skips.
    if (body.type !== undefined) task.type = body.type;
    if (body.customType !== undefined) task.customType = body.customType;
    if (body.frequency !== undefined) task.frequency = body.frequency;
    if (body.notes !== undefined) task.notes = body.notes;
    if (body.nextDue !== undefined) task.nextDue = body.nextDue;
    if (body.assignedTo !== undefined) {
      task.assignedTo = body.assignedTo || null;
      task.assignedToName = body.assignedTo ? (db.users.get(body.assignedTo)?.name ?? null) : null;
    }

    res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
  }
);

app.delete('/tasks/:id', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const task = db.tasks.get(req.params.id);

  if (!task || task.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Task not found' });
  }

  db.tasks.delete(req.params.id);
  res.status(204).send();
});

app.post(
  '/tasks/:id/snooze',
  authMiddleware,
  requireHousehold,
  validateBody(snoozeTaskSchema),
  (req, res) => {
    const user = (req as any).user;
    const task = db.tasks.get(req.params.id);
    if (!task || task.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Task not found' });
    }
    const { days, reason, note } = (req as any).validatedBody;
    // Mirror taskService.snoozeTask: base the snooze on max(now, current
    // nextDue) so snoozing an overdue task pushes it into the *future*.
    const current = new Date(task.nextDue);
    const baseMs = Number.isNaN(current.getTime())
      ? Date.now()
      : Math.max(Date.now(), current.getTime());
    const next = new Date(baseMs);
    next.setDate(next.getDate() + days);
    task.nextDue = next.toISOString();

    // Mirror handlers/tasks snoozeTask: feed entry with the optional reason
    // ("snoozed (rain expected)").
    recordActivity({
      type: 'task.snoozed',
      householdId: user.householdId,
      actorId: user.userId,
      actorName: user.email.split('@')[0],
      payload: {
        taskId: task.id,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        days,
        reason: reason ?? null,
        note: note ?? null,
      },
    });

    res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
  }
);

app.post(
  '/tasks/:id/complete',
  authMiddleware,
  requireHousehold,
  validateBody(completeTaskSchema),
  (req, res) => {
    const user = (req as any).user;
    const task = db.tasks.get(req.params.id);

    if (!task || task.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Mirror taskService.completeTask: advance the schedule from NOW (the
    // production write is conditioned on the just-read nextDue, which makes
    // a concurrent double-complete a no-op; this single-threaded mock can't
    // race, so the sequential semantics below are identical).
    const now = new Date();
    const nextDue = new Date(now);
    nextDue.setDate(nextDue.getDate() + task.frequency);
    task.lastCompleted = now.toISOString();
    task.nextDue = nextDue.toISOString();

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
      notes: (req as any).validatedBody.notes || null,
    });

    res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
  }
);

app.get('/households/:id/analytics/daily', authMiddleware, requireHousehold, (req, res) => {
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

app.get('/households/:id/year-in-review', authMiddleware, requireHousehold, (req, res) => {
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

app.get('/households/:id/activity', authMiddleware, requireHousehold, (req, res) => {
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

app.get('/plants/:plantId/history', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const out: Completion[] = [];
  for (const c of db.completions.values()) {
    // Household-scoped, like taskService.getTaskCompletions's partition key.
    if (c.plantId === req.params.plantId && c.householdId === user.householdId) out.push(c);
  }
  out.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  res.json(out);
});

// ============ SPECIES ============

// Species autocomplete proxy. The local dev server doesn't have a Perenual
// API key wired up, so it reports `disabled` and lets the frontend fall back
// to its static catalog. This keeps local dev offline-friendly.
app.get('/species/search', authMiddleware, (req, res) => {
  res.json({ source: 'disabled', results: [] });
});

// PUBLIC route (no auth) — the free "is this plant safe for pets?" lookup.
// Mirrors handlers/species/handler.ts:toxicity exactly: resolves the typed
// name against the same hand-curated static table (no Perenual, no DB), so
// the mock returns real answers and the integration tests exercise the live
// matcher. Registered BEFORE `/species/:id` so Express matches the exact
// segment first (API Gateway does this automatically in production).
app.get('/species/toxicity', (req, res) => {
  const q = (typeof req.query.q === 'string' ? req.query.q : '').trim();
  const results = q.length >= 2 ? lookupToxicity(q.slice(0, 80)) : [];
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ query: q, results });
});

app.get('/species/:id', authMiddleware, (req, res) => {
  // When enrichment exists, production also surfaces `thumbnailUrl` on the
  // result; the mock has no enrichment cache, so result stays null.
  res.json({ result: null });
});

app.get('/species/:id/care-suggestions', authMiddleware, (req, res) => {
  res.json({ result: null });
});

// PUBLIC route (no auth) — production serves this to anonymous <img> tags.
app.get('/species/:id/thumbnail', (req, res) => {
  // No Perenual data locally; treat as missing so the frontend keeps its
  // existing placeholder rendering.
  res.status(404).end();
});

app.get('/species/:id/guide', authMiddleware, (req, res) => {
  res.json({ result: null });
});

// ============ BILLING ============

app.get('/billing/plans', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  // Reuse the production projection so the dev server can't drift from the
  // real /billing/plans contract (annualPrice, lifetimePrice, …) and never
  // leaks stripePriceEnv.
  res.json(Object.values(PLANS).map(planSummary));
});

app.get('/billing/me', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const h = db.households.get(user.householdId);
  // Usage mirrors the production METADATA counters: active plants + members.
  const planId = h?.planId ?? 'seedling';
  const plan = PLANS[planId] ?? PLANS.seedling;
  const plantCount = [...db.plants.values()].filter(
    (p) => p.householdId === user.householdId && (p.status ?? 'active') === 'active'
  ).length;
  const memberCount = membersOf(user.householdId).length;
  res.json({
    planId,
    stripeCustomerId: h?.stripeCustomerId,
    stripeSubscriptionId: h?.stripeSubscriptionId,
    status: h?.subscriptionStatus,
    usage: {
      plantCount,
      maxPlants: plan.maxPlants,
      memberCount,
      maxMembers: plan.maxMembers,
    },
  });
});

// Mirrors checkoutSchema in handlers/billing/handler.ts.
const checkoutSchema = z.object({
  planId: z.enum(['garden', 'greenhouse']),
});

app.post(
  '/billing/checkout',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  validateBody(checkoutSchema),
  (req, res) => {
    const user = (req as any).user;
    const { planId } = (req as any).validatedBody;
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
  }
);

app.get('/billing/dev-success', (_req, res) => {
  res.send(
    '<html><body><h1>Mock checkout success</h1><p>You can close this window.</p></body></html>'
  );
});

app.post('/billing/portal', authMiddleware, requireHousehold, requireAdmin, (req, res) => {
  res.json({ url: `http://localhost:${PORT}/billing/dev-portal` });
});

app.get('/billing/dev-portal', (_req, res) => {
  res.send(
    '<html><body><h1>Mock billing portal</h1><p>Stripe customer portal stub.</p></body></html>'
  );
});

// POST /billing/webhook — Stripe webhook receiver. Local dev has no Stripe
// signature secret; mirror production's config/signature failure modes.
app.post('/billing/webhook', (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    // Production throws an exposed 500 here ("operator-facing" message).
    return res.status(500).json({ message: 'Webhook secret not configured' });
  }
  if (!signature || typeof signature !== 'string') {
    return res.status(400).json({ message: 'Missing Stripe signature' });
  }
  // The mock can't verify a real Stripe signature; accept and no-op.
  res.json({ received: true });
});

// ============ CHAT ============

// Mirrors sendMessageSchema in handlers/chat/handler.ts. The mock has no
// Bedrock; it returns a canned RunChatTurnResult-shaped response so the
// frontend chat UI can be exercised offline.
const sendMessageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  // Idempotency key (#3). The mock has no Bedrock/budget so it just accepts it.
  turnId: z.string().uuid().optional(),
});

const CHAT_BUDGET = {
  maxInputTokensPerMonth: Number(process.env.CHAT_BUDGET_INPUT_TOKENS || '250000'),
  maxOutputTokensPerMonth: Number(process.env.CHAT_BUDGET_OUTPUT_TOKENS || '50000'),
};

app.post(
  '/chat/messages',
  authMiddleware,
  requireHousehold,
  validateBody(sendMessageSchema),
  (req, res) => {
    const body = (req as any).validatedBody;
    res.json({
      conversationId: body.conversationId ?? uuidv4(),
      assistantText:
        '[local dev] The chat assistant requires Bedrock and is stubbed in the mock server.',
      proposals: [],
      budgetRemaining: {
        inputTokens: CHAT_BUDGET.maxInputTokensPerMonth,
        outputTokens: CHAT_BUDGET.maxOutputTokensPerMonth,
      },
    });
  }
);

// SSE mock of the streaming chat endpoint (production: Lambda Function URL
// running handlers/chat/streamHandler.ts). Speaks the same `data: <json>\n\n`
// protocol — start / delta / done events — by fake-chunking the canned sync
// reply, so the frontend's VITE_CHAT_STREAM_URL path is exercisable offline.
app.post(
  '/chat/messages/stream',
  authMiddleware,
  requireHousehold,
  validateBody(sendMessageSchema),
  (req, res) => {
    const body = (req as any).validatedBody;
    const conversationId = body.conversationId ?? uuidv4();
    const text =
      '[local dev] The chat assistant requires Bedrock and is stubbed in the mock server. ' +
      'This reply is fake-chunked so you can watch the streaming UI render incrementally.';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ type: 'start', conversationId });

    const words = text.split(' ');
    let i = 0;
    const timer = setInterval(() => {
      if (i < words.length) {
        send({ type: 'delta', text: (i === 0 ? '' : ' ') + words[i] });
        i += 1;
        return;
      }
      clearInterval(timer);
      send({
        type: 'done',
        result: {
          conversationId,
          assistantText: text,
          proposals: [],
          budgetRemaining: {
            inputTokens: CHAT_BUDGET.maxInputTokensPerMonth,
            outputTokens: CHAT_BUDGET.maxOutputTokensPerMonth,
          },
        },
      });
      res.end();
    }, 40);
    req.on('close', () => clearInterval(timer));
  }
);

app.get('/chat/conversations/:id/messages', authMiddleware, requireHousehold, (req, res) => {
  res.json([]);
});

app.get('/chat/budget', authMiddleware, requireHousehold, (req, res) => {
  res.json({
    yearMonth: new Date().toISOString().slice(0, 7),
    inputTokensUsed: 0,
    outputTokensUsed: 0,
    inputTokensCap: CHAT_BUDGET.maxInputTokensPerMonth,
    outputTokensCap: CHAT_BUDGET.maxOutputTokensPerMonth,
    costUsd: 0,
  });
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
    // Mirrors production read-defaulting: weeklyDigest on iff email is on.
    weeklyDigest: true,
    phoneVerified: false,
    updatedAt: new Date().toISOString(),
  };
}

const TIME_HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

// Mirrors prefsSchema in handlers/notifications/handler.ts.
const prefsSchema = z.object({
  browser: z.boolean(),
  email: z.boolean(),
  sms: z.boolean(),
  phone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/u, 'Phone must be in E.164 format, e.g. +15551234567')
    .or(z.literal(''))
    .default(''),
  dndStart: z.string().regex(TIME_HHMM).or(z.literal('')).default(''),
  dndEnd: z.string().regex(TIME_HHMM).or(z.literal('')).default(''),
  timezone: z.string().min(1).max(64).default('UTC'),
  pestAlerts: z.boolean().default(false),
  weeklyDigest: z.boolean().optional(),
});

// Mirrors startVerificationSchema / confirmVerificationSchema / recapSchema
// in handlers/notifications/handler.ts.
const startVerificationSchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/u, 'Phone must be in E.164 format, e.g. +15551234567'),
});

const confirmVerificationSchema = z.object({
  code: z.string().regex(/^\d{6}$/u, 'Verification code is 6 digits'),
});

const recapSchema = z
  .object({ year: z.number().int().min(2000).max(2100).optional() })
  .nullish()
  .transform((v) => v ?? {});

// Mirrors subscribeSchema / unsubscribeSchema in handlers/notifications/handler.ts.
const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(8),
    auth: z.string().min(8),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

// Mirrors registerDeviceSchema / unregisterDeviceSchema (native Capacitor push).
const registerDeviceSchema = z.object({
  platform: z.enum(['ios', 'android']),
  token: z.string().min(16).max(4096),
});

const unregisterDeviceSchema = z.object({
  token: z.string().min(16).max(4096),
});

app.get('/notifications/prefs', authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.json(db.notificationPrefs.get(user.userId) ?? defaultPrefs(user.userId));
});

app.put('/notifications/prefs', authMiddleware, validateBody(prefsSchema), (req, res) => {
  const user = (req as any).user;
  const body = (req as any).validatedBody;
  if (body.sms && !body.phone) {
    return res.status(400).json({ message: 'A phone number is required to enable SMS reminders' });
  }
  const current = db.notificationPrefs.get(user.userId) ?? defaultPrefs(user.userId);
  // Mirrors notificationPrefs.setPreferences: verified status carries over
  // only while the number is unchanged; enabling SMS requires a verified
  // number unless SMS was already on for that same number (grandfathered).
  const phoneVerified = body.phone !== '' && current.phoneVerified && current.phone === body.phone;
  if (body.sms && !phoneVerified && !(current.sms && current.phone === body.phone)) {
    return res
      .status(400)
      .json({ message: 'Phone number must be verified before enabling SMS reminders' });
  }
  const updated: NotificationPrefsRecord = {
    userId: user.userId,
    browser: body.browser,
    email: body.email,
    sms: body.sms,
    phone: body.phone,
    dndStart: body.dndStart,
    dndEnd: body.dndEnd,
    timezone: body.timezone,
    pestAlerts: body.pestAlerts,
    weeklyDigest: body.weeklyDigest ?? current.weeklyDigest,
    phoneVerified,
    updatedAt: new Date().toISOString(),
  };
  db.notificationPrefs.set(user.userId, updated);
  res.json(updated);
});

app.post(
  '/notifications/phone/start-verification',
  authMiddleware,
  validateBody(startVerificationSchema),
  (req, res) => {
    const user = (req as any).user;
    const { phone } = (req as any).validatedBody;
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    db.phoneVerifications.set(user.userId, {
      phone,
      code,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0,
    });
    console.log(`[sms dry-run] -> ${phone}: Family Greenhouse verification code: ${code}`);
    // DEV ONLY: `devCode` is echoed so the flow is completable without real
    // SMS. Production never returns the code (it only ever leaves via SNS).
    res.json({ sent: true, devCode: code });
  }
);

app.post(
  '/notifications/phone/confirm-verification',
  authMiddleware,
  validateBody(confirmVerificationSchema),
  (req, res) => {
    const user = (req as any).user;
    const { code } = (req as any).validatedBody;
    const pending = db.phoneVerifications.get(user.userId);
    if (!pending || pending.expiresAt <= Date.now()) {
      return res
        .status(400)
        .json({ message: 'Verification code expired or not found. Request a new code.' });
    }
    if (pending.attempts >= 5) {
      return res.status(429).json({ message: 'Too many incorrect attempts. Request a new code.' });
    }
    if (pending.code !== code) {
      pending.attempts += 1;
      return res.status(400).json({ message: 'Incorrect verification code.' });
    }
    db.phoneVerifications.delete(user.userId);
    const current = db.notificationPrefs.get(user.userId) ?? defaultPrefs(user.userId);
    const updated: NotificationPrefsRecord = {
      ...current,
      phone: pending.phone,
      phoneVerified: true,
      updatedAt: new Date().toISOString(),
    };
    db.notificationPrefs.set(user.userId, updated);
    res.json(updated);
  }
);

app.post('/notifications/subscribe', authMiddleware, validateBody(subscribeSchema), (req, res) => {
  const user = (req as any).user;
  if (!user.householdId) {
    return res.status(403).json({ message: 'User must belong to a household' });
  }
  const { endpoint, keys } = (req as any).validatedBody;
  db.pushSubscriptions.set(`${user.userId}|${endpoint}`, {
    userId: user.userId,
    endpoint,
    keys,
    createdAt: new Date().toISOString(),
  });
  res.json({ ok: true });
});

app.post(
  '/notifications/unsubscribe',
  authMiddleware,
  validateBody(unsubscribeSchema),
  (req, res) => {
    const user = (req as any).user;
    const { endpoint } = (req as any).validatedBody;
    db.pushSubscriptions.delete(`${user.userId}|${endpoint}`);
    res.status(204).send();
  }
);

app.post(
  '/notifications/devices',
  authMiddleware,
  validateBody(registerDeviceSchema),
  (req, res) => {
    const user = (req as any).user;
    if (!user.householdId) {
      return res.status(403).json({ message: 'User must belong to a household' });
    }
    const { platform, token } = (req as any).validatedBody;
    db.deviceTokens.set(`${user.userId}|${token}`, {
      userId: user.userId,
      platform,
      token,
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  }
);

app.post(
  '/notifications/devices/remove',
  authMiddleware,
  validateBody(unregisterDeviceSchema),
  (req, res) => {
    const user = (req as any).user;
    const { token } = (req as any).validatedBody;
    db.deviceTokens.delete(`${user.userId}|${token}`);
    res.status(204).send();
  }
);

app.post(
  '/notifications/run-reminders',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  (req, res) => {
    const user = (req as any).user;
    const now = new Date();
    const cutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    let sent = 0;
    for (const member of db.users.values()) {
      if (!member.memberships.some((m) => m.householdId === user.householdId)) continue;
      const due = [...db.tasks.values()].filter(
        (t) =>
          t.householdId === user.householdId && t.assignedTo === member.id && t.nextDue <= cutoff
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
        // Mirrors notifier.sendToUser: unverified numbers are skipped, never sent.
        if (prefs.phoneVerified) {
          console.log(`[sms dry-run] -> ${prefs.phone}: ${headline}`);
        } else {
          console.log(`[sms skipped — unverified phone] -> ${member.email}`);
        }
      }
      sent += 1;
    }
    res.json({ sent });
  }
);

// Mirrors digestHousehold in services/digest.ts (per-household manual
// trigger; the weekly all-household scan is EventBridge-only in production).
app.post(
  '/notifications/run-digests',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  (req, res) => {
    const user = (req as any).user;
    const now = Date.now();
    const atRiskByPlant = new Map<
      string,
      { plantName: string; taskType: string; daysOverdue: number }
    >();
    for (const t of db.tasks.values()) {
      if (t.householdId !== user.householdId) continue;
      const due = Date.parse(t.nextDue);
      if (!(due < now)) continue;
      const plant = db.plants.get(t.plantId);
      if (!plant || plant.status !== 'active') continue;
      const daysOverdue = Math.floor((now - due) / (24 * 60 * 60 * 1000));
      const current = atRiskByPlant.get(t.plantId);
      if (!current || daysOverdue > current.daysOverdue) {
        atRiskByPlant.set(t.plantId, {
          plantName: plant.name,
          taskType: t.type === 'custom' ? (t.customType ?? 'custom') : t.type,
          daysOverdue,
        });
      }
    }
    const atRisk = [...atRiskByPlant.values()]
      .sort((a, b) => b.daysOverdue - a.daysOverdue)
      .slice(0, 5);
    if (atRisk.length === 0) {
      return res.json({ sent: 0 });
    }
    let sent = 0;
    for (const member of db.users.values()) {
      if (!member.memberships.some((m) => m.householdId === user.householdId)) continue;
      const prefs = db.notificationPrefs.get(member.id) ?? defaultPrefs(member.id);
      if (!prefs.email || !prefs.weeklyDigest) continue;
      console.log(
        `[email dry-run] -> ${member.email}: Weekly digest — ${atRisk
          .map((p) => `${p.plantName} (${p.taskType}, ${p.daysOverdue}d overdue)`)
          .join(', ')}`
      );
      sent += 1;
    }
    res.json({ sent });
  }
);

// Mirrors recapHousehold in services/digest.ts, including the once-per-year
// per-household marker (in-memory here, TTL'd DDB row in production).
app.post(
  '/notifications/run-year-recap',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  validateBody(recapSchema),
  (req, res) => {
    const user = (req as any).user;
    const body = (req as any).validatedBody;
    const year = body.year ?? new Date().getUTCFullYear() - 1;
    const completions = [...db.completions.values()].filter(
      (c) =>
        c.householdId === user.householdId &&
        c.completedAt >= `${year}-01-01` &&
        c.completedAt < `${year + 1}-01-01`
    );
    if (completions.length === 0) {
      return res.json({ sent: 0, year });
    }
    const markerKey = `${user.householdId}|${year}`;
    if (db.recapSent.has(markerKey)) {
      return res.json({ sent: 0, year });
    }
    db.recapSent.add(markerKey);
    let sent = 0;
    for (const member of db.users.values()) {
      if (!member.memberships.some((m) => m.householdId === user.householdId)) continue;
      const prefs = db.notificationPrefs.get(member.id) ?? defaultPrefs(member.id);
      if (!prefs.email) continue;
      console.log(
        `[email dry-run] -> ${member.email}: Your ${year} plant care year in review — ${completions.length} tasks completed`
      );
      sent += 1;
    }
    res.json({ sent, year });
  }
);

// ============ API KEYS (Greenhouse plan) ============

function generateApiKey(): string {
  // Web Crypto-equivalent random hex without crypto import in this dev file.
  const bytes = Array.from({ length: 24 }, () => Math.floor(Math.random() * 256));
  return `fg_${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// Mirrors createSchema in handlers/apiKeys/handler.ts.
const createApiKeySchema = z.object({
  label: z.string().min(1).max(60),
  scopes: z.array(z.enum(API_SCOPES as [string, ...string[]])).optional(),
});

app.get('/api-keys', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const keys = [...db.apiKeys.values()]
    .filter((k) => k.householdId === user.householdId)
    .map(({ plaintext: _p, ...rest }) => rest);
  res.json(keys);
});

app.post(
  '/api-keys',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  validateBody(createApiKeySchema),
  (req, res) => {
    const user = (req as any).user;
    const h = db.households.get(user.householdId);
    if ((h?.planId ?? 'seedling') !== 'greenhouse') {
      return res.status(402).json({
        message: 'API access is included with the Greenhouse plan. Upgrade to issue API keys.',
      });
    }
    const { label, scopes: rawScopes } = (req as any).validatedBody;
    // Omitted/empty → full READ access (matches backend default; write is
    // never implicit).
    const scopes =
      Array.isArray(rawScopes) && rawScopes.length > 0
        ? (rawScopes as string[])
        : [...READ_API_SCOPES];
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
  }
);

app.delete('/api-keys/:id', authMiddleware, requireHousehold, requireAdmin, (req, res) => {
  const user = (req as any).user;
  const key = db.apiKeys.get(req.params.id);
  if (!key || key.householdId !== user.householdId) {
    return res.status(404).json({ message: 'API key not found' });
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
  (req as any).apiScopes = record.scopes ?? [...READ_API_SCOPES];
  (req as any).apiKeyRecord = record;
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

// Mirrors apiCompleteTaskSchema / apiSnoozeTaskSchema in handlers/api/handler.ts
// (bodies are optional on the public write routes).
const apiCompleteTaskSchema = z.object({ notes: z.string().max(500).optional() }).nullish();
const apiSnoozeTaskSchema = z
  .object({ days: z.number().int().min(1).max(365).optional() })
  .nullish();

// POST /api/v1/tasks/:id/complete (scope: write:tasks)
// Mirrors handlers/api/handler.ts:completeTask — the actor is the synthetic
// `apikey:<id>` principal with the key's label as display name.
app.post(
  '/api/v1/tasks/:id/complete',
  apiKeyMiddleware,
  requireApiScope('write:tasks'),
  validateBody(apiCompleteTaskSchema),
  (req, res) => {
    const user = (req as any).user;
    const keyRecord = (req as any).apiKeyRecord as ApiKey | undefined;
    const task = db.tasks.get(req.params.id);
    if (!task || task.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Task not found' });
    }
    const now = new Date();
    const nextDue = new Date(now);
    nextDue.setDate(nextDue.getDate() + task.frequency);
    task.lastCompleted = now.toISOString();
    task.nextDue = nextDue.toISOString();

    const completionId = uuidv4();
    db.completions.set(completionId, {
      id: completionId,
      householdId: task.householdId,
      plantId: task.plantId,
      taskId: task.id,
      taskType: task.customType || task.type,
      completedBy: user.userId,
      completedByName: keyRecord?.label ?? 'API',
      completedAt: now.toISOString(),
      notes: (req as any).validatedBody?.notes || null,
    });

    res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
  }
);

// POST /api/v1/tasks/:id/snooze (scope: write:tasks)
// Omitted days defaults to the task's frequency (skip one cycle), mirroring
// handlers/api/handler.ts:snoozeTask.
app.post(
  '/api/v1/tasks/:id/snooze',
  apiKeyMiddleware,
  requireApiScope('write:tasks'),
  validateBody(apiSnoozeTaskSchema),
  (req, res) => {
    const user = (req as any).user;
    const task = db.tasks.get(req.params.id);
    if (!task || task.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Task not found' });
    }
    const days = (req as any).validatedBody?.days ?? task.frequency;
    const current = new Date(task.nextDue);
    const baseMs = Number.isNaN(current.getTime())
      ? Date.now()
      : Math.max(Date.now(), current.getTime());
    const next = new Date(baseMs);
    next.setDate(next.getDate() + days);
    task.nextDue = next.toISOString();
    res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
  }
);

// ============ MOCK UPLOAD ENDPOINT ============

app.post('/mock-upload', (req, res) => {
  res.json({ success: true });
});

// ============ FALLBACKS ============

// Unknown routes: same JSON 404 shape as production's router dispatcher.
app.use((req, res) => {
  res.status(404).json({ message: `No route handler for ${req.method} ${req.path}` });
});

// Final error handler: mirror the production jsonErrorHandler contract —
// malformed JSON bodies are a client error; anything else unexpected is a
// generic 500 that never leaks internals.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }
  console.error('[local-server] unhandled error:', err);
  res.status(500).json({ message: 'Internal Server Error' });
});

if (process.env.NODE_ENV !== 'test') {
  // Bind to loopback only — this server has a well-known seed account and
  // must never be reachable from the local network.
  app.listen(PORT, '127.0.0.1', () => {
    console.log('\n========================================');
    console.log('Family Greenhouse Local Dev Server');
    console.log(`Running on http://127.0.0.1:${PORT}`);
    console.log('========================================');
    console.log('\nTest account:');
    console.log('  Email: test@example.com');
    console.log('  Password: password123');
    console.log('\nFor new signups, use confirmation code: 123456');
    console.log('========================================\n');
  });
}
