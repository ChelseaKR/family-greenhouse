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
import expressRateLimit, { MemoryStore } from 'express-rate-limit';
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
  cognitoPasswordSchema,
  refreshTokenSchema,
  createHouseholdSchema,
  updateMemberRoleSchema,
  createPlantSchema,
  updatePlantSchema,
  movePlantsSchema,
  createSpaceSchema,
  updateSpaceSchema,
  importPlantsSchema,
  confirmImageUploadSchema,
  createTaskSchema,
  updateTaskSchema,
  completeTaskSchema,
  snoozeTaskSchema,
  askForHelpSchema,
  setVacationSchema,
  applyTemplateSchema,
  applyTemplateBulkSchema,
  createSitterLinkSchema,
  setEscalationRuleSchema,
} from './models/schemas.js';
import type { SpaceRotation } from './models/types.js';
import { resolveInheritedAssignee, isExplicitAssignment } from './services/assignmentResolver.js';
import { ASK_HELP_WINDOW_MS, normalizeHelpNote } from './services/askFamilyRule.js';
import { TEMPLATES } from './models/taskTemplates.js';
import {
  PLANS,
  planSummary,
  planHasFeature,
  hasHouseholdToolkit,
  planIncludesAwayKit,
  planIncludesCrossHomeToday,
  planHasMoveDay,
  atCap,
  limitOf,
  strongestPlan,
} from './models/plans.js';
// From models/, NOT services/kioskService.js: that module imports
// utils/dynamodb.ts, which calls requireEnv('TABLE_NAME') at import time and
// would take this whole dev server down before it could serve a request.
import {
  KIOSK_DEFAULT_POLL_SECONDS,
  KIOSK_MIN_POLL_SECONDS,
  KIOSK_MAX_POLL_SECONDS,
  KIOSK_LOOKAHEAD_DAYS,
} from './models/kiosk.js';
import {
  computeScheduleDrift,
  nextDueAfterMatch,
  pickRecentDuplicate,
} from './services/doubleCareRules.js';
import {
  UPGRADE_FEATURES,
  REQUEST_WINDOW_MS,
  composeUpgradeRequestEmail,
  resolveTargetPlan,
  type UpgradeFeature,
} from './models/upgradeFeatures.js';
import {
  CROSS_HOME_TODAY_LOCKED_MESSAGE,
  InvalidUntilError,
  isDueBy,
  resolveCutoff,
} from './models/crossHomeToday.js';
import {
  assignRoundRobin,
  isMoveDayApplicable,
  moveTaskLabel,
  planMoves,
} from './services/moveDayPlan.js';
import type { MoveDayList } from './services/moveDayPlan.js';
import { identifyTopUpSummary } from './models/identifyTopUp.js';
import { analyticsWindow } from './services/analyticsWindow.js';
import { lookupToxicity } from './models/petToxicity.js';
import {
  checkSitterLinkPlanGate,
  countLiveSitterLinks,
  sitterBriefIncluded,
  sitterWindowDays,
} from './services/sitterPlanGate.js';
// From models/, NOT services/sitterBrief.js: that module imports
// plantService/spaceService/taskService, which reach utils/dynamodb.ts and
// call requireEnv('TABLE_NAME') at import time — which took this dev server
// down before it could answer /health.
import { resolveCareNote, resolvePetSafety } from './models/sitterBriefFields.js';
import { frontendTelemetrySchema, productTelemetrySchema } from './models/telemetry.js';
import type { ActivityEvent, RecordActivityInput } from './services/activity.js';
import {
  registerPlantTagRoutes,
  type LocalPlantTag,
  type LocalPlantTagPin,
} from './local-server-plant-tags.js';
import { isAllowedPushEndpoint } from './services/pushEndpoint.js';
import { composeInviteEmail, normalizeEmailLocale } from './services/emailCopy.js';
import {
  SITTER_PHOTO_BODY_MAX_BYTES,
  SITTER_PHOTO_EXTENSIONS,
  SITTER_PHOTO_MAX_PER_LINK,
  admitSitterPhoto,
  sitterActorId,
  sitterPhotoUploadSchema,
  takeSitterPhotoToken,
} from './services/sitterPhotoPolicy.js';
import { buildAwayRecap, pickRecapLink, recapWindow } from './services/awayRecapModel.js';
import {
  isEmailCategory,
  signToken,
  verifyTokenWithSecret,
} from './services/email/capabilityToken.js';
import {
  renderConfirmPage,
  renderDonePage,
  renderInvalidPage,
} from './services/email/unsubscribePage.js';
import {
  COMMERCIAL_HOLD_ACTIVE,
  COMMERCIAL_HOLD_EFFECTIVE_DATE,
  paymentsAreAvailable,
  publicRegistrationIsAvailable,
} from './config/commercialStatus.js';

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
// Production caps bodies per route (middleware/bodySize.ts); the largest is
// the sitter photo-back upload (SITTER_PHOTO_BODY_MAX_BYTES). Express's
// 100 KB default would reject that route's in-spec bodies before it ran.
app.use(express.json({ limit: SITTER_PHOTO_BODY_MAX_BYTES }));

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
  /** Auto-handoff rule (ADR 0018); null/absent = off. */
  escalateAfterDays?: number | null;
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
  spaceId: string | null;
  placementNote: string | null;
  summerSpaceId: string | null;
  winterSpaceId: string | null;
  imageUrl: string | null;
  notes: string | null;
  /** House rule (≤140 chars); null/absent = no rule. Mirrors models/types.ts. */
  careRule?: string | null;
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

interface PlantSpace {
  id: string;
  householdId: string;
  name: string;
  environment: 'inside' | 'outside';
  rainExposure: 'exposed' | 'sheltered';
  lightLevel: 'low' | 'medium' | 'bright' | null;
  petAccess: boolean | null;
  defaultCaregiverId: string | null;
  /** Care rotation (ADR 0018); mirrors models/types.ts SpaceRotation. */
  rotation: SpaceRotation | null;
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
  assignmentSource: 'space_default' | 'move_day' | 'rotation' | null;
  notes: string | null;
  /** Auto-handoff marker; mirrors models/types.ts. */
  escalatedAt?: string | null;
  escalatedForDue?: string | null;
  escalatedFrom?: string | null;
  /** "Ask family to do it" marker (ADR 0024); mirrors models/types.ts. */
  helpAskedAt?: string | null;
  helpAskedBy?: string | null;
  helpAskedByName?: string | null;
  helpAskedNote?: string | null;
  helpAskedForDue?: string | null;
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
  /** Photos stored through this link (Away Kit photo-back). Mirrors the
   *  `photoCount` attribute the production row carries. */
  photoCount?: number;
}

/** Mirrors kioskService.KioskLink (KIOSK#{token} row). Long-lived by design —
 *  no expiry, revocation is the control. See services/kioskService.ts for the
 *  design rule and threat model. */
interface KioskLink {
  id: string;
  token: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  status: 'active' | 'revoked';
  pollIntervalSeconds: number;
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

interface ChatReportRecord {
  id: string;
  userId: string;
  householdId: string;
  conversationId: string;
  responseText: string;
  reason: 'incorrect' | 'unsafe' | 'offensive' | 'other';
  details: string | null;
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
  memberJoined: boolean;
  taskUpForGrabs: boolean;
  coverageUpdates: boolean;
  careCredit: boolean;
  yearRecap: boolean;
  emailLocale: '' | 'en' | 'es';
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

/** Mirrors the `EMAIL#{address}/DELIVERY_STATE` row in its suppressed state
 *  (services/emailSuppression.ts). The mock only models the terminal state —
 *  the soft-bounce counter has no local trigger to increment it. */
interface EmailSuppressionRecord {
  reason: 'hard_bounce' | 'complaint' | 'soft_bounce_limit';
  suppressedAt: string;
}

interface PlantPhoto {
  id: string;
  plantId: string;
  householdId: string;
  imageUrl: string;
  uploadedBy: string;
  uploadedAt: string;
  caption: string | null;
  /** Mirrors plantService.PlantPhoto: set on sitter photo-back uploads. */
  viaSitter?: boolean;
  sitterLinkId?: string;
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

/** Mirrors `calendarTokens.CalendarTokenRecord`. Dev-only: the Map is keyed
 *  by the plaintext token so the public feed route can match it; production
 *  stores only a scrypt hash (services/calendarTokens.ts). */
interface CalendarToken {
  userId: string;
  householdId: string;
  createdAt: string;
  lastUsedAt: string | null;
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
  /** Double-care: the other member's completion this one knowingly duplicates. */
  duplicateOfCompletionId?: string | null;
}

interface MockUploadGrant {
  key: string;
  contentType: string;
}

interface MockImageObject {
  body: Buffer;
  contentType: string;
}

export const db = {
  users: new Map<string, User>(),
  households: new Map<string, Household>(),
  invites: new Map<string, Invite>(),
  plants: new Map<string, Plant>(),
  spaces: new Map<string, PlantSpace>(),
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
  chatReports: new Map<string, ChatReportRecord>(),
  notificationPrefs: new Map<string, NotificationPrefsRecord>(),
  phoneVerifications: new Map<string, PhoneVerificationRecord>(), // userId -> pending code
  // Suppressed outbound addresses, keyed by the lowercased email —
  // mirrors EMAIL#<addr>/DELIVERY_STATE in production
  // (services/emailSuppression.ts). Seeded empty; a dev/e2e run puts an
  // entry here to exercise the undeliverable surfaces.
  emailSuppressions: new Map<string, EmailSuppressionRecord>(),
  recapSent: new Set<string>(), // `${userId}|${householdId}|${year}` recipient markers
  reminderSent: new Set<string>(), // `${userId}|${householdId}|${localDate}|${channel}` markers
  pendingConfirmations: new Map<string, string>(), // email -> confirmation code
  sitterLinks: new Map<string, SitterLink>(), // keyed by token (the secret)
  calendarTokens: new Map<string, CalendarToken>(), // keyed by token (the secret)
  plantTags: new Map<string, LocalPlantTag>(), // ADR 0016 — keyed by token (the secret)
  plantTagPins: new Map<string, LocalPlantTagPin>(), // householdId -> PIN hash, never the PIN
  kioskLinks: new Map<string, KioskLink>(), // keyed by token (the secret)
  // Member → admin upgrade asks, keyed `${householdId}|${feature}|${userId}`
  // (mirrors the UPGRADE_REQUEST#{feature}#{userId} marker + its 7-day window).
  upgradeRequests: new Map<string, { requestedAt: string }>(),
  // "Ask family to do it" rate-limit markers, keyed
  // `${householdId}|${taskId}|${userId}` (mirrors the
  // TASK_HELP_ASK#{taskId}#{userId} marker + its 24-hour window, ADR 0024).
  helpAsks: new Map<string, { askedAt: string }>(),
  // Tiny local object store used by the real browser upload flow. A presign
  // creates a capability token, PUT stores the bytes, confirm verifies the
  // object exists, and /mock-images serves the confirmed URL from this API.
  mockUploadGrants: new Map<string, MockUploadGrant>(),
  mockImages: new Map<string, MockImageObject>(),
  // Invite-email abuse bounds, mirrored from services/inviteEmail.ts so the
  // 429 and cooldown branches are reachable in development.
  inviteEmailCounts: new Map<string, number>(), // `${householdId}|${utcDay}` -> count
  inviteEmailRecipients: new Set<string>(), // `${householdId}|${utcDay}|${address}`
};

/** Mirrors DAILY_INVITE_EMAIL_CAP in services/inviteEmail.ts. */
const LOCAL_DAILY_INVITE_EMAIL_CAP = 10;

export const seedHouseholdId = '550e8400-e29b-41d4-a716-446655440001';
export const seedUserId = '550e8400-e29b-41d4-a716-446655440000';
export let seedPlantId = '';
export let seedTaskId = '';

export function resetDb(): void {
  db.users.clear();
  db.households.clear();
  db.invites.clear();
  db.inviteEmailCounts.clear();
  db.inviteEmailRecipients.clear();
  db.plants.clear();
  db.spaces.clear();
  db.shares.clear();
  db.tasks.clear();
  db.completions.clear();
  db.photos.clear();
  db.apiKeys.clear();
  db.activity.clear();
  db.vacations.clear();
  db.pushSubscriptions.clear();
  db.deviceTokens.clear();
  db.chatReports.clear();
  db.notificationPrefs.clear();
  db.phoneVerifications.clear();
  db.emailSuppressions.clear();
  db.recapSent.clear();
  db.reminderSent.clear();
  db.pendingConfirmations.clear();
  db.sitterLinks.clear();
  db.calendarTokens.clear();
  db.plantTags.clear();
  db.plantTagPins.clear();
  db.kioskLinks.clear();
  db.upgradeRequests.clear();
  db.helpAsks.clear();
  db.mockUploadGrants.clear();
  db.mockImages.clear();

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

  const seedSpaceId = uuidv4();
  db.spaces.set(seedSpaceId, {
    id: seedSpaceId,
    householdId: seedHouseholdId,
    name: 'Living Room',
    environment: 'inside',
    rainExposure: 'sheltered',
    lightLevel: null,
    petAccess: null,
    defaultCaregiverId: null,
    rotation: null,
    createdAt: now,
    createdBy: seedUserId,
    updatedAt: now,
  });

  seedPlantId = uuidv4();
  db.plants.set(seedPlantId, {
    id: seedPlantId,
    householdId: seedHouseholdId,
    name: 'Monstera',
    species: 'Monstera deliciosa',
    location: 'Living Room',
    spaceId: seedSpaceId,
    placementNote: null,
    summerSpaceId: null,
    winterSpaceId: null,
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
    assignmentSource: null,
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
 * Direct local fixture helper. Integration tests use this in-process helper,
 * and browser tests use the explicitly enabled `__test__` endpoint below.
 */
export function provisionLocalUserFixture({
  email,
  password,
  name,
  confirmed = true,
}: {
  email: string;
  password: string;
  name: string;
  confirmed?: boolean;
}): User {
  if (findUserByEmail(email)) {
    throw new Error('An account with this email already exists');
  }

  const user: User = {
    id: uuidv4(),
    email,
    password,
    name,
    confirmed,
    householdId: null,
    householdRole: null,
    memberships: [],
  };
  db.users.set(user.id, user);

  if (!confirmed) {
    db.pendingConfirmations.set(email, '123456');
  }

  return user;
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
      const details = result.error.issues.reduce<Record<string, string[]>>((acc, err) => {
        const path = err.path.join('.');
        if (!acc[path]) acc[path] = [];
        acc[path].push(err.message);
        return acc;
      }, {});
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
/**
 * Mirrors services/homesGate.ts (ADR 0014): the strongest plan across every
 * household the user is in — plus the one being joined — decides the homes
 * cap. A user already above it keeps every home and is refused only the next
 * one. Returns the 402 message, or null when the add is allowed.
 */
function homesRefusal(
  dbUser: { memberships: Membership[] },
  joiningHouseholdId: string | null
): string | null {
  const ids = new Set(dbUser.memberships.map((m) => m.householdId));
  if (joiningHouseholdId) ids.add(joiningHouseholdId);
  const plan = strongestPlan([...ids].map((id) => db.households.get(id)?.planId));
  const limit = limitOf(plan, 'homes');
  const count = dbUser.memberships.length;
  if (!atCap(count, limit)) return null;
  const homes = limit === 1 ? '1 home' : `${limit} homes`;
  const belongs = count === 1 ? '1 household' : `${count} households`;
  return `Your ${plan.name} plan includes ${homes} and you already belong to ${belongs}. Upgrade to Greenhouse for unlimited homes.`;
}

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
function recordActivity(input: RecordActivityInput): void {
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

/** Mirrors handlers/tasks resolvePlanBestEffort + hasHouseholdToolkit. */
function householdHasToolkit(householdId: string): boolean {
  return hasHouseholdToolkit(PLANS[db.households.get(householdId)?.planId ?? 'seedling']);
}

// Health check
app.get('/health', (req, res) => {
  // Public health check used by load balancers AND the marketing /status
  // page. We surface a small set of subsystem checks so the status page
  // can show component-by-component state rather than just a binary.
  // Local server is in-memory, so the values are deterministic; in
  // production the same shape comes from a real DynamoDB reachability probe;
  // providers without an active probe are explicitly reported as unknown.
  res.json({
    status: 'ok',
    version: process.env.APP_VERSION ?? 'dev',
    checkedAt: new Date().toISOString(),
    components: {
      database: { status: 'ok' },
      auth: { status: 'unknown' },
      mail: { status: 'unknown' },
    },
  });
});

app.post('/telemetry/frontend', validateBody(frontendTelemetrySchema), (req, res) => {
  console.info(JSON.stringify({ ...(req as any).validatedBody, msg: 'frontend_telemetry' }));
  res.status(204).end();
});

app.post('/telemetry/product', authMiddleware, validateBody(productTelemetrySchema), (req, res) => {
  const user = (req as any).user;
  console.info(
    JSON.stringify({
      ...(req as any).validatedBody,
      msg: 'product_event',
      actorId: user.userId,
      householdId: user.householdId ?? undefined,
    })
  );
  res.status(204).end();
});

// ============ AUTH ROUTES ============

app.post('/auth/signup', validateBody(signupSchema), (req, res) => {
  if (!publicRegistrationIsAvailable()) {
    return res.status(503).json({ message: 'New account registration is currently paused.' });
  }

  const { email, password, name } = (req as any).validatedBody;

  try {
    provisionLocalUserFixture({ email, password, name, confirmed: false });
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }

  console.log('\n========================================');
  console.log('NEW USER SIGNUP');
  console.log(`Email: ${email}`);
  console.log('Confirmation Code: 123456');
  console.log('========================================\n');

  return res.status(201).json({
    message: 'User created. Please check your email for confirmation code.',
  });
});

// Browser-test fixture provisioning is intentionally separate from the public
// route and exists only in this non-deployed local server. The exact opt-in is
// set by playwright.config.ts; without it the endpoint is indistinguishable
// from an unknown route.
app.post('/__test__/accounts', validateBody(signupSchema), (req, res) => {
  if (process.env.ALLOW_TEST_ACCOUNT_PROVISIONING !== '1') {
    return res.status(404).json({ message: 'Not found' });
  }

  const { email, password, name } = (req as any).validatedBody;
  try {
    provisionLocalUserFixture({ email, password, name });
    return res.status(201).json({ message: 'Local test account provisioned.' });
  } catch (error) {
    return res.status(400).json({ message: (error as Error).message });
  }
});

const testPlanSchema = z.object({
  planId: z.enum(['seedling', 'garden', 'greenhouse']),
});

// Browser-test entitlement fixture, behind the same opt-in and the same
// indistinguishable-from-unknown 404 as the account route above. A paid tier
// cannot be BOUGHT here — /billing/checkout mirrors production's commercial
// hold with a 503 — so an in-process test seeds `db` directly and a browser
// test, which has no such access, seeds it through this. It sets the plan and
// nothing else: no Stripe ids, no subscription row, so it can never stand in
// for the webhook path those tests cover.
app.post('/__test__/households/:id/plan', validateBody(testPlanSchema), (req, res) => {
  if (process.env.ALLOW_TEST_ACCOUNT_PROVISIONING !== '1') {
    return res.status(404).json({ message: 'Not found' });
  }

  const household = db.households.get(req.params.id);
  if (!household) return res.status(404).json({ message: 'Household not found' });
  household.planId = (req as any).validatedBody.planId;
  return res.json({ id: household.id, planId: household.planId });
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
      for (const [sid, space] of db.spaces.entries()) {
        if (space.householdId === m.householdId) db.spaces.delete(sid);
      }
      for (const [cid, completion] of db.completions.entries()) {
        if (completion.householdId === m.householdId) db.completions.delete(cid);
      }
      for (const [eid, event] of db.activity.entries()) {
        if (event.householdId === m.householdId) db.activity.delete(eid);
      }
      for (const [vid, vacation] of db.vacations.entries()) {
        if (vacation.householdId === m.householdId) db.vacations.delete(vid);
      }
      for (const [kid, k] of db.apiKeys.entries()) {
        if (k.householdId === m.householdId) db.apiKeys.delete(kid);
      }
      for (const [token, link] of db.sitterLinks.entries()) {
        if (link.householdId === m.householdId) db.sitterLinks.delete(token);
      }
      for (const [token, link] of db.kioskLinks.entries()) {
        if (link.householdId === m.householdId) db.kioskLinks.delete(token);
      }
      for (const [token, tag] of db.plantTags.entries()) {
        if (tag.householdId === m.householdId) db.plantTags.delete(token);
      }
      db.plantTagPins.delete(m.householdId);
      for (const [code, invite] of db.invites.entries()) {
        if (invite.householdId === m.householdId) db.invites.delete(code);
      }
      for (const [code, share] of db.shares.entries()) {
        if (share.householdId === m.householdId) db.shares.delete(code);
      }
      for (const [rid, report] of db.chatReports.entries()) {
        if (report.householdId === m.householdId) db.chatReports.delete(rid);
      }
      db.households.delete(m.householdId);
    }

    // Retained shared records preserve the household's care history without
    // retaining the departing member's name or stable account id.
    const household = db.households.get(m.householdId);
    if (household?.createdBy === dbUser.id) household.createdBy = 'deleted-user';
    for (const plant of db.plants.values()) {
      if (plant.householdId === m.householdId && plant.createdBy === dbUser.id) {
        plant.createdBy = 'deleted-user';
      }
    }
    for (const task of db.tasks.values()) {
      if (task.householdId !== m.householdId) continue;
      if (task.createdBy === dbUser.id) task.createdBy = 'deleted-user';
      if (task.assignedTo === dbUser.id) {
        task.assignedTo = null;
        task.assignedToName = null;
        task.assignmentSource = null;
      }
    }
    for (const space of db.spaces.values()) {
      if (space.householdId !== m.householdId) continue;
      if (space.createdBy === dbUser.id) space.createdBy = 'deleted-user';
      if (space.defaultCaregiverId === dbUser.id) space.defaultCaregiverId = null;
    }
    for (const [key, vacation] of db.vacations.entries()) {
      if (
        vacation.householdId === m.householdId &&
        (vacation.userId === dbUser.id || vacation.coveredBy === dbUser.id)
      ) {
        db.vacations.delete(key);
      }
    }
    for (const photo of db.photos.values()) {
      if (photo.householdId === m.householdId && photo.uploadedBy === dbUser.id) {
        photo.uploadedBy = 'deleted-user';
      }
    }
    for (const link of db.sitterLinks.values()) {
      if (link.householdId === m.householdId && link.createdBy === dbUser.id) {
        link.createdBy = 'deleted-user';
      }
    }
    for (const link of db.kioskLinks.values()) {
      if (link.householdId === m.householdId && link.createdBy === dbUser.id) {
        link.createdBy = 'deleted-user';
      }
    }
    for (const tag of db.plantTags.values()) {
      if (tag.householdId === m.householdId && tag.createdBy === dbUser.id) {
        tag.createdBy = 'deleted-user';
      }
    }
    for (const report of db.chatReports.values()) {
      if (report.householdId === m.householdId && report.userId === dbUser.id) {
        report.userId = 'deleted-user';
      }
    }
    for (const completion of db.completions.values()) {
      if (completion.householdId === m.householdId && completion.completedBy === dbUser.id) {
        completion.completedBy = 'deleted-user';
        completion.completedByName = 'Former member';
      }
    }
    for (const event of db.activity.values()) {
      if (event.householdId === m.householdId && event.actorId === dbUser.id) {
        event.actorId = 'deleted-user';
        event.actorName = 'Former member';
      }
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
  // Calendar-feed tokens live in the user's partition in production and go
  // with the generic USER# sweep; mirror that here.
  for (const [token, grant] of db.calendarTokens.entries()) {
    if (grant.userId === dbUser.id) db.calendarTokens.delete(token);
  }
  db.phoneVerifications.delete(dbUser.id);
  for (const key of [...db.recapSent]) {
    if (key.startsWith(`${dbUser.id}|`)) db.recapSent.delete(key);
  }
  for (const key of [...db.reminderSent]) {
    if (key.startsWith(`${dbUser.id}|`)) db.reminderSent.delete(key);
  }
  db.pendingConfirmations.delete(dbUser.email.toLowerCase());

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

// GET /me/today
// Cross-home Today (ADR 0017). Mirrors handlers/me/today.ts +
// services/crossHomeToday.ts: due-by-cutoff and overdue tasks across EVERY
// membership, grouped by household with the household name on every row,
// the membership's own role per group, and a household whose row is gone
// returned as an explicit `unavailable` entry rather than dropped. Not
// household-pinned; the gate is per user across every membership.
app.get('/me/today', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const memberships = db.users.get(user.userId)?.memberships ?? [];

  let cutoff: string;
  try {
    cutoff = resolveCutoff(typeof req.query.until === 'string' ? req.query.until : undefined);
  } catch (err) {
    if (err instanceof InvalidUntilError) return res.status(400).json({ message: err.message });
    throw err;
  }

  const entitled = memberships.some((m) =>
    planIncludesCrossHomeToday(PLANS[db.households.get(m.householdId)?.planId ?? 'seedling'])
  );
  if (!entitled) {
    return res.status(402).json({ message: CROSS_HOME_TODAY_LOCKED_MESSAGE });
  }

  const households = memberships.map((m) => {
    const h = db.households.get(m.householdId);
    if (!h) {
      return {
        householdId: m.householdId,
        name: null,
        role: m.role,
        status: 'unavailable' as const,
      };
    }
    const due = [...db.tasks.values()]
      .filter(
        (t) => t.householdId === h.id && isActivePlant(t.plantId) && isDueBy(t.nextDue, cutoff)
      )
      .sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime())
      .map((t) => ({ ...t, plantName: db.plants.get(t.plantId)?.name ?? t.plantName }));
    const tasks = annotateCoverage(due, h.id).map((t) => ({ ...t, householdName: h.name }));
    return { householdId: m.householdId, name: h.name, role: m.role, status: 'ok' as const, tasks };
  });

  res.set('Cache-Control', 'private, no-store');
  res.json({ generatedAt: new Date().toISOString(), cutoff, households });
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

/** Same lifecycle filter as production taskService.getTasks: tasks of
 *  died / gave_away plants don't surface in either ICS route. */
function icsTasksFor(householdId: string) {
  return [...db.tasks.values()].filter(
    (t) =>
      t.householdId === householdId && (db.plants.get(t.plantId)?.status ?? 'active') === 'active'
  );
}

async function sendIcs(res: express.Response, householdId: string) {
  const { buildIcs } = await import('./services/icsExport.js');
  res
    .status(200)
    .type('text/calendar; charset=utf-8')
    .set('Content-Disposition', 'attachment; filename="family-greenhouse.ics"')
    .set('Cache-Control', 'private, max-age=300')
    .send(buildIcs(icsTasksFor(householdId)));
}

// GET /me/calendar.ics
// AUTHENTICATED one-shot iCalendar download (mirrors handlers/me/handler.ts).
// Not a subscription URL: calendar apps carry no session and get 401 here.
app.get('/me/calendar.ics', authMiddleware, async (req, res) => {
  const user = (req as any).user;
  // 403 (not 400) — matches handlers/me/handler.ts + requireHousehold.
  if (!user.householdId) return res.status(403).json({ message: 'No household selected' });
  await sendIcs(res, user.householdId);
});

// --- Calendar-feed link (mirrors handlers/me/handler.ts) -------------------
// Per-user, per-household capability URL for calendar-app subscriptions.
// Dev clone keeps the plaintext in memory; production hashes it.

function calendarTokenStatus(grant: CalendarToken | null) {
  return {
    active: grant !== null,
    createdAt: grant?.createdAt ?? null,
    lastUsedAt: grant?.lastUsedAt ?? null,
  };
}

function findCalendarToken(userId: string, householdId: string): [string, CalendarToken] | null {
  for (const entry of db.calendarTokens.entries()) {
    if (entry[1].userId === userId && entry[1].householdId === householdId) return entry;
  }
  return null;
}

// GET /me/calendar-token
app.get('/me/calendar-token', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const found = findCalendarToken(user.userId, user.householdId);
  res.json(calendarTokenStatus(found ? found[1] : null));
});

// POST /me/calendar-token
app.post('/me/calendar-token', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  // Regenerate semantics: the previous token for this (user, household) dies.
  const existing = findCalendarToken(user.userId, user.householdId);
  if (existing) db.calendarTokens.delete(existing[0]);
  const token = randomBytes(32).toString('hex'); // 256-bit, like the service
  const grant: CalendarToken = {
    userId: user.userId,
    householdId: user.householdId,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  db.calendarTokens.set(token, grant);
  // Deliberately NOT echoed to the console (unlike dev API keys): the token
  // is a bearer credential for the feed and the response already carries it.
  res.status(201).json({
    ...calendarTokenStatus(grant),
    token,
    path: `/calendar/${token}/family-greenhouse.ics`,
  });
});

// DELETE /me/calendar-token
app.delete('/me/calendar-token', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const existing = findCalendarToken(user.userId, user.householdId);
  if (!existing) return res.status(404).json({ message: 'No calendar link to revoke' });
  db.calendarTokens.delete(existing[0]);
  res.status(204).end();
});

// GET /calendar/:token/family-greenhouse.ics
// PUBLIC (no auth): the token is the only credential. Generic 404 on every
// miss (unknown / revoked / regenerated / membership gone), like sitter links.
app.get('/calendar/:token/family-greenhouse.ics', async (req, res) => {
  const token = req.params.token;
  const grant = /^[0-9a-f]{64}$/.test(token) ? db.calendarTokens.get(token) : undefined;
  const isMember =
    grant &&
    db.users
      .get(grant.userId)
      ?.memberships.some((m: Membership) => m.householdId === grant.householdId);
  if (!grant || !isMember) {
    return res.status(404).json({ message: 'This calendar link is invalid or has been revoked.' });
  }
  grant.lastUsedAt = new Date().toISOString();
  await sendIcs(res, grant.householdId);
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
  newPassword: cognitoPasswordSchema,
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

  // Homes gate — mirrors handlers/households/handler.ts (ADR 0014). The first
  // household is always allowed; a user already above the cap keeps every
  // home and is refused only this next one.
  if (dbUser.memberships.length > 0) {
    const refused = homesRefusal(dbUser, null);
    if (refused) return res.status(402).json({ message: refused });
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
    // `emailStatus` mirrors getHouseholdMembersPublic: deliverability without
    // the address. The mock has no failing store, so it never reports the
    // third state (`unknown`) that production returns on a failed lookup.
    members: membersOf(req.params.id).map((member) => ({
      ...member,
      emailStatus: db.emailSuppressions.has(member.email.trim().toLowerCase())
        ? 'undeliverable'
        : 'ok',
    })),
  });
});

// Climate endpoints. Local dev doesn't have an OpenWeatherMap key wired up;
// `getClimate` reports `configured: false` with `weather: null` and an empty
// tips array so the frontend exercises the disabled path. The saved location
// is still part of the response contract: the dashboard uses it to
// distinguish "not set" from "weather temporarily unavailable".
// `setLocation` performs a no-op geocode that stores the supplied city.
app.get('/households/:id/climate', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  if (req.params.id !== user.householdId) {
    return res.status(403).json({ message: 'Access denied' });
  }
  const household = db.households.get(req.params.id);
  if (!household) return res.status(404).json({ message: 'Household not found' });
  res.json({
    configured: false,
    location: household.location ?? null,
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

// Seasonal Move Day — mirrors handlers/climate/moveDay.ts + services/moveDay.ts
// over the in-memory store, sharing the pure rules in services/moveDayPlan.ts.
// Local dev has no weather integration, so the cached snapshot is never
// available and the production answer is `unavailable`. Pass
// `?season=winter|summer` to simulate the frost/heat line being crossed; the
// `signal` numbers are then the simulation's, not a measurement.
const moveDayRecords = new Map<string, MoveDayList>(); // `${householdId}#${season}`
const MOVE_DAY_CARD_MS = 14 * 24 * 60 * 60 * 1000;
const MOVE_DAY_REFIRE_GAP_MS = 180 * 24 * 60 * 60 * 1000;

app.post('/households/:id/move-day', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  if (req.params.id !== user.householdId) {
    return res.status(403).json({ message: 'Access denied' });
  }
  const household = db.households.get(req.params.id);
  if (!household) return res.status(404).json({ message: 'Household not found' });
  if (!planHasMoveDay(PLANS[household.planId ?? 'seedling'])) {
    return res.json({ status: 'locked' });
  }

  const plants = [...db.plants.values()].filter(
    (p) => p.householdId === household.id && p.status === 'active'
  );
  const spaces = [...db.spaces.values()].filter((s) => s.householdId === household.id);
  if (!isMoveDayApplicable(plants, spaces)) return res.json({ status: 'not_applicable' });

  const now = Date.now();
  const recent = (['winter', 'summer'] as const)
    .map((season) => moveDayRecords.get(`${household.id}#${season}`))
    .filter((r): r is MoveDayList => !!r && now - Date.parse(r.firedAt) < MOVE_DAY_CARD_MS)
    .sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0];
  if (recent) return res.json({ status: 'ready', list: recent });

  const requested = req.query.season;
  const season = requested === 'winter' || requested === 'summer' ? requested : null;
  if (!season) return res.json({ status: 'unavailable' });

  const key = `${household.id}#${season}`;
  const same = moveDayRecords.get(key);
  if (same && now - Date.parse(same.firedAt) < MOVE_DAY_REFIRE_GAP_MS) {
    return res.json({ status: 'quiet' });
  }
  const items = planMoves(plants, spaces, season);
  if (items.length === 0) return res.json({ status: 'quiet' });

  const nowIso = new Date(now).toISOString();
  const away = new Set(
    [...db.vacations.values()]
      .filter((w) => w.householdId === household.id && w.startDate <= nowIso && nowIso <= w.endDate)
      .map((w) => w.userId)
  );
  const assignees = [...db.users.values()]
    .flatMap((u) => {
      const membership = u.memberships.find((m) => m.householdId === household.id);
      return membership && !away.has(u.id)
        ? [{ userId: u.id, name: u.name, joinedAt: membership.joinedAt }]
        : [];
    })
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId));
  assignRoundRobin(items, assignees);

  for (const item of items) {
    const task = buildTask(
      {
        plantId: item.plantId,
        type: 'custom',
        customType: moveTaskLabel(item.toSpaceName),
        frequency: 365,
        nextDue: nowIso,
      },
      household.id,
      user.userId,
      item.plantName
    );
    task.assignedTo = item.assigneeId;
    task.assignedToName = item.assigneeName;
    task.assignmentSource = item.assigneeId ? 'move_day' : null;
    item.taskId = task.id;
  }

  const list: MoveDayList = {
    season,
    firedAt: nowIso,
    // Simulated — mirrors FROST_LOW_C / HEAT_HIGH_C in services/climate.ts.
    signal: {
      tempC: season === 'summer' ? 34 : 9,
      lowC: season === 'winter' ? 3 : 18,
      frostLineC: 5,
      heatLineC: 32,
    },
    items,
    tenderWithoutWinterHome: [],
  };
  moveDayRecords.set(key, list);
  res.json({ status: 'ready', list });
});

// PUT /households/:id/escalation — mirrors handlers/households setEscalationRule:
// admin-only, plan-gated (402 without the household toolkit), 5-day floor via
// the shared schema. Stored on the household so GET /households/:id returns it.
app.put(
  '/households/:id/escalation',
  authMiddleware,
  requireHousehold,
  validateBody(setEscalationRuleSchema),
  (req, res) => {
    const user = (req as any).user;
    if (user.householdId !== req.params.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (user.householdRole !== 'admin') {
      return res.status(403).json({ message: 'Admin role required' });
    }
    const household = db.households.get(req.params.id);
    if (!household) return res.status(404).json({ message: 'Household not found' });
    const plan = PLANS[household.planId ?? 'seedling'];
    if (!plan.householdToolkit) {
      return res.status(402).json({
        message: `Auto-handoff is part of the household toolkit, which the ${plan.name} plan does not include. Upgrade to turn it on.`,
      });
    }
    const { escalateAfterDays } = (req as any).validatedBody as {
      escalateAfterDays: number | null;
    };
    household.escalateAfterDays = escalateAfterDays;
    res.json({ escalateAfterDays });
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

// Mirrors inviteEmailSchema in handlers/households/handler.ts.
const inviteEmailSchema = z.object({
  email: z.string().trim().email().max(254),
  locale: z.enum(['en', 'es']).optional(),
});

/**
 * POST /households/:id/invites/email — mirrors handlers/households/handler.ts.
 *
 * The mock's delivery channel is the console: it composes the real localized
 * email through `services/emailCopy.ts` and prints it, so the copy can be read
 * (in both languages) without SES. That is why it answers `accepted` rather
 * than `unavailable` — something really was delivered, to the terminal.
 *
 * The two abuse bounds are mirrored in memory so the 429 and cooldown paths
 * are reachable in development: a per-household daily cap and one email per
 * address per household per day.
 */
app.post(
  '/households/:id/invites/email',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  validateBody(inviteEmailSchema),
  (req, res) => {
    const user = (req as any).user;
    const body = (req as any).validatedBody as { email: string; locale?: 'en' | 'es' };
    const householdId = String(req.params.id);
    if (user.householdId !== householdId) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const household = db.households.get(householdId);
    if (!household) {
      return res.status(404).json({ message: 'Household not found' });
    }
    const inviter = membersOf(householdId).find((m) => m.userId === user.userId);
    if (!inviter?.name || !household.name) {
      return res.status(503).json({
        message:
          'We could not load your name or the household name, so we did not send an invitation that could not say who it was from. Generate a link instead.',
      });
    }

    const day = new Date().toISOString().slice(0, 10);
    const recipientKey = `${householdId}|${day}|${body.email.trim().toLowerCase()}`;
    if (db.inviteEmailRecipients.has(recipientKey)) {
      return res.status(200).json({ status: 'recipient_cooldown' });
    }
    const countKey = `${householdId}|${day}`;
    const used = db.inviteEmailCounts.get(countKey) ?? 0;
    if (used >= LOCAL_DAILY_INVITE_EMAIL_CAP) {
      return res.status(429).json({
        message: `This household has sent its ${LOCAL_DAILY_INVITE_EMAIL_CAP} invite emails for today. The link below still works.`,
      });
    }

    const code = uuidv4().replace(/-/g, '');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    db.invites.set(code, {
      code,
      householdId,
      createdBy: user.userId,
      createdAt: now.toISOString(),
      expiresAt,
    });
    const baseUrl =
      process.env.FRONTEND_URL ||
      process.env.ALLOWED_ORIGIN ||
      `http://localhost:${process.env.FRONTEND_PORT || 3000}`;
    const url = `${baseUrl}/join/${code}`;

    db.inviteEmailCounts.set(countKey, used + 1);
    db.inviteEmailRecipients.add(recipientKey);

    const { subject, text } = composeInviteEmail(
      {
        inviterName: inviter.name,
        householdName: household.name,
        joinUrl: url,
        expiresAt,
      },
      normalizeEmailLocale(body.locale)
    );
    console.log('\n========================================');
    console.log('INVITE EMAIL (console delivery)');
    console.log(`To: ${body.email}`);
    console.log(`Subject: ${subject}`);
    console.log('----------------------------------------');
    console.log(text);
    console.log('========================================\n');

    res.status(201).json({ code, expiresAt, url, status: 'accepted' });
  }
);

// --- Plant-sitter links (authed management) -------------------------------
// Mirrors handlers/households/handler.ts: createSitterLink / listSitterLinks /
// revokeSitterLink. Open to every household member (ADR 0015); an admin can
// revoke any link, a member only their own; create/revoke are named in the
// activity feed.

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
  validateBody(createSitterLinkSchema),
  (req, res) => {
    const user = (req as any).user;
    if (user.householdId !== req.params.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const body = (req as any).validatedBody;
    const now = new Date();
    // Plan gate — mirrors the handler: window length + live-link count.
    const plan = PLANS[db.households.get(req.params.id)?.planId ?? 'seedling'] ?? PLANS.seedling;
    const startsAt: string = body.startsAt ?? now.toISOString();
    const gate = checkSitterLinkPlanGate(plan, {
      windowDays: sitterWindowDays(startsAt, body.expiresAt),
      liveLinks: countLiveSitterLinks(
        [...db.sitterLinks.values()].filter((l) => l.householdId === req.params.id),
        now
      ),
    });
    if (!gate.ok) {
      return res.status(402).json({ message: gate.message });
    }
    const token = randomBytes(32).toString('hex'); // 256-bit, like the service
    const link: SitterLink = {
      id: uuidv4(),
      token,
      householdId: req.params.id,
      createdBy: user.userId,
      createdAt: now.toISOString(),
      startsAt,
      expiresAt: body.expiresAt,
      status: 'active',
      label: body.label ?? null,
    };
    db.sitterLinks.set(token, link);
    recordActivity({
      type: 'sitter_link.created',
      householdId: req.params.id,
      actorId: user.userId,
      actorName: db.users.get(user.userId)?.name ?? user.email.split('@')[0],
      payload: {
        linkId: link.id,
        label: link.label,
        startsAt: link.startsAt,
        expiresAt: link.expiresAt,
      },
    });

    const baseUrl =
      process.env.FRONTEND_URL ||
      process.env.ALLOWED_ORIGIN ||
      `http://localhost:${process.env.FRONTEND_PORT || 3000}`;

    res.status(201).json({ ...sitterSummary(link), token, url: `${baseUrl}/sit/${token}` });
  }
);

// GET /households/:id/sitter-links
app.get('/households/:id/sitter-links', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  if (user.householdId !== req.params.id) {
    return res.status(403).json({ message: 'Access denied' });
  }
  const links = [...db.sitterLinks.values()]
    .filter((l) => l.householdId === req.params.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(sitterSummary);
  res.json(links);
});

// DELETE /households/:id/sitter-links/:linkId
app.delete('/households/:id/sitter-links/:linkId', authMiddleware, requireHousehold, (req, res) => {
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
  if (user.householdRole !== 'admin' && target.createdBy !== user.userId) {
    return res.status(403).json({
      message: 'Only the member who created this sitter link, or a household admin, can revoke it',
    });
  }
  target.status = 'revoked';
  recordActivity({
    type: 'sitter_link.revoked',
    householdId: req.params.id,
    actorId: user.userId,
    actorName: db.users.get(user.userId)?.name ?? user.email.split('@')[0],
    payload: {
      linkId: target.id,
      label: target.label,
      startsAt: target.startsAt,
      expiresAt: target.expiresAt,
    },
  });
  res.status(204).end();
});

// --- Kiosk (wall display) links (authed management) ------------------------
// Mirrors handlers/households/kioskLink.ts: issue / get / revoke. Admin-gated
// like sitter links, and Greenhouse-gated (features.kiosk in models/plans.ts).
// The design rule and threat model live in services/kioskService.ts.

/** Non-secret view of a kiosk link (no token). Mirrors kioskService.toSummary. */
function kioskSummary(link: KioskLink) {
  const { token: _token, ...summary } = link;
  void _token;
  return summary;
}

const issueKioskLinkSchemaLocal = z
  .object({
    pollIntervalSeconds: z
      .number()
      .int()
      .min(KIOSK_MIN_POLL_SECONDS)
      .max(KIOSK_MAX_POLL_SECONDS)
      .optional(),
  })
  .nullish();

// POST /households/:id/kiosk-link
app.post(
  '/households/:id/kiosk-link',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  validateBody(issueKioskLinkSchemaLocal),
  (req, res) => {
    const user = (req as any).user;
    if (user.householdId !== req.params.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const h = db.households.get(user.householdId);
    if (!planHasFeature(h?.planId ?? 'seedling', 'kiosk')) {
      return res.status(402).json({
        message:
          'The kiosk display is included with the Greenhouse plan. Upgrade to set up a wall display.',
      });
    }
    // Re-issue revokes the previous token first — that is the household's
    // one-click remedy for a photographed screen, so it has to actually kill
    // the old one.
    for (const link of db.kioskLinks.values()) {
      if (link.householdId === req.params.id && link.status === 'active') link.status = 'revoked';
    }
    const body = (req as any).validatedBody;
    const token = randomBytes(32).toString('hex'); // 256-bit, like the service
    const link: KioskLink = {
      id: uuidv4(),
      token,
      householdId: req.params.id,
      createdBy: user.userId,
      createdAt: new Date().toISOString(),
      status: 'active',
      pollIntervalSeconds: body?.pollIntervalSeconds ?? KIOSK_DEFAULT_POLL_SECONDS,
    };
    db.kioskLinks.set(token, link);

    const baseUrl =
      process.env.FRONTEND_URL ||
      process.env.ALLOWED_ORIGIN ||
      `http://localhost:${process.env.FRONTEND_PORT || 3000}`;

    res.status(201).json({ ...kioskSummary(link), token, url: `${baseUrl}/kiosk/${token}` });
  }
);

// GET /households/:id/kiosk-link
app.get(
  '/households/:id/kiosk-link',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  (req, res) => {
    const user = (req as any).user;
    if (user.householdId !== req.params.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const active = [...db.kioskLinks.values()].find(
      (l) => l.householdId === req.params.id && l.status === 'active'
    );
    res.json({ link: active ? kioskSummary(active) : null });
  }
);

// DELETE /households/:id/kiosk-link
app.delete(
  '/households/:id/kiosk-link',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  (req, res) => {
    const user = (req as any).user;
    if (user.householdId !== req.params.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const active = [...db.kioskLinks.values()].filter(
      (l) => l.householdId === req.params.id && l.status === 'active'
    );
    if (active.length === 0) {
      return res.status(404).json({ message: 'No active kiosk link to revoke' });
    }
    for (const link of active) link.status = 'revoked';
    res.status(204).end();
  }
);

/** Token → link only if active. Long-lived by design: no window check, only
 *  revocation. Mirrors kioskService.getActiveKioskLink. */
function getActiveKioskLink(token: string): KioskLink | null {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const link = db.kioskLinks.get(token);
  if (!link || link.status !== 'active') return null;
  return link;
}

// --- Member → admin upgrade requests -----------------------------------------
// Mirrors handlers/households/upgradeRequests.ts + services/upgradeRequests.ts:
// a MEMBER names a locked feature; every admin is told (the email is printed
// here, like invites) and the ask lands in the activity feed. Once per member
// per feature per 7 days.

// Mirrors upgradeRequestSchema in handlers/households/upgradeRequests.ts.
const upgradeRequestSchema = z.object({ feature: z.enum(UPGRADE_FEATURES) });

// POST /households/:id/upgrade-requests
app.post(
  '/households/:id/upgrade-requests',
  authMiddleware,
  requireHousehold,
  validateBody(upgradeRequestSchema),
  (req, res) => {
    const user = (req as any).user;
    const householdId = String(req.params.id);
    if (user.householdId !== householdId) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (user.householdRole === 'admin') {
      return res.status(409).json({
        message:
          'You are an admin of this household — you can change the plan yourself in Settings → Billing.',
      });
    }
    if (!paymentsAreAvailable()) {
      return res.status(503).json({ message: 'Payments are currently paused.' });
    }
    const feature = (req as any).validatedBody.feature as UpgradeFeature;
    const household = db.households.get(householdId);
    const targetPlanId = resolveTargetPlan(feature, household?.planId ?? 'seedling');
    if (!targetPlanId) {
      return res
        .status(409)
        .json({ message: 'Your household already has this. Reload to see it.' });
    }
    const members = membersOf(householdId);
    const admins = members.filter((m) => m.role === 'admin' && m.userId !== user.userId);
    if (admins.length === 0) {
      return res.status(409).json({ message: 'This household has no admin to ask.' });
    }

    const key = `${householdId}|${feature}|${String(user.userId)}`;
    const now = new Date();
    const previous = db.upgradeRequests.get(key);
    if (previous && now.getTime() - Date.parse(previous.requestedAt) < REQUEST_WINDOW_MS) {
      return res.status(429).json({
        message: 'You already asked for this recently. You can ask again once a week.',
        details: {
          nextAllowedAt: new Date(
            Date.parse(previous.requestedAt) + REQUEST_WINDOW_MS
          ).toISOString(),
        },
      });
    }
    db.upgradeRequests.set(key, { requestedAt: now.toISOString() });

    const memberName =
      members.find((m) => m.userId === user.userId)?.name?.trim() || 'A household member';
    const householdName = household?.name?.trim() || 'your household';
    const appUrl =
      process.env.FRONTEND_URL ||
      process.env.ALLOWED_ORIGIN ||
      `http://localhost:${process.env.FRONTEND_PORT || 3000}`;
    for (const admin of admins) {
      const { subject, text } = composeUpgradeRequestEmail({
        adminName: admin.name,
        memberName,
        householdName,
        feature,
        targetPlanId,
        appUrl,
      });
      console.log('\n========================================');
      console.log('UPGRADE REQUEST EMAIL (dev — nothing sent)');
      console.log(`To: ${admin.email}`);
      console.log(`Subject: ${subject}`);
      console.log(text);
      console.log('========================================\n');
    }

    recordActivity({
      type: 'upgrade.requested',
      householdId,
      actorId: user.userId,
      actorName: memberName,
      payload: { feature, plan: targetPlanId },
    });

    res.status(201).json({
      feature,
      targetPlanId,
      requestedAt: now.toISOString(),
      nextAllowedAt: new Date(now.getTime() + REQUEST_WINDOW_MS).toISOString(),
      admins: admins.map((a) => ({ userId: a.userId, name: a.name })),
      // The dev server prints the email; nothing leaves the building, and the
      // response says so instead of claiming a delivery.
      emailDelivered: false,
      pushDelivered: false,
    });
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

  const existing = dbUser.memberships.find((m) => m.householdId === invite.householdId);
  if (existing) {
    // Mirror production's retry recovery: the membership may have committed
    // immediately before writing the default Cognito claim failed.
    if (!dbUser.householdId) {
      dbUser.householdId = invite.householdId;
      dbUser.householdRole = existing.role;
      return res.json(household);
    }
    return res.status(400).json({ message: 'You are already a member of this household' });
  }

  // Homes gate — the joined household's plan counts, so a Greenhouse home
  // always takes another hand (ADR 0014).
  const refusedHome = homesRefusal(dbUser, invite.householdId);
  if (refusedHome) return res.status(402).json({ message: refusedHome });

  const plan = PLANS[household.planId ?? 'seedling'];
  const existingMembers = membersOf(invite.householdId);
  if (atCap(existingMembers.length, limitOf(plan, 'members'))) {
    return res.status(402).json({
      message: `This household is on the ${plan.name} plan, limited to ${limitOf(plan, 'members')} members.`,
    });
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
    // Clear every live reference to the departed member, matching
    // accountCleanup.anonymizeUserInHousehold in production.
    const household = db.households.get(householdId);
    if (household?.createdBy === userId) household.createdBy = 'deleted-user';
    for (const plant of db.plants.values()) {
      if (plant.householdId === householdId && plant.createdBy === userId) {
        plant.createdBy = 'deleted-user';
      }
    }
    for (const task of db.tasks.values()) {
      if (task.householdId !== householdId) continue;
      if (task.createdBy === userId) task.createdBy = 'deleted-user';
      if (task.assignedTo === userId) {
        task.assignedTo = null;
        task.assignedToName = null;
        task.assignmentSource = null;
      }
    }
    for (const space of db.spaces.values()) {
      if (space.householdId !== householdId) continue;
      if (space.createdBy === userId) space.createdBy = 'deleted-user';
      if (space.defaultCaregiverId === userId) space.defaultCaregiverId = null;
    }
    for (const [key, vacation] of db.vacations.entries()) {
      if (
        vacation.householdId === householdId &&
        (vacation.userId === userId || vacation.coveredBy === userId)
      ) {
        db.vacations.delete(key);
      }
    }
    for (const completion of db.completions.values()) {
      if (completion.householdId === householdId && completion.completedBy === userId) {
        completion.completedBy = 'deleted-user';
        completion.completedByName = 'Former member';
      }
    }
    for (const event of db.activity.values()) {
      if (event.householdId === householdId && event.actorId === userId) {
        event.actorId = 'deleted-user';
        event.actorName = 'Former member';
      }
    }
    for (const photo of db.photos.values()) {
      if (photo.householdId === householdId && photo.uploadedBy === userId) {
        photo.uploadedBy = 'deleted-user';
      }
    }
    for (const link of db.sitterLinks.values()) {
      if (link.householdId === householdId && link.createdBy === userId) {
        link.createdBy = 'deleted-user';
      }
    }
    for (const link of db.kioskLinks.values()) {
      if (link.householdId === householdId && link.createdBy === userId) {
        link.createdBy = 'deleted-user';
      }
    }
    for (const report of db.chatReports.values()) {
      if (report.householdId === householdId && report.userId === userId) {
        report.userId = 'deleted-user';
      }
    }
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

/** Members + not-yet-ended vacation windows: the shared resolver's context. */
function assignmentContextOf(householdId: string) {
  return {
    members: membersOf(householdId).map((m) => ({ userId: m.userId, name: m.name })),
    vacations: [...db.vacations.values()].filter((w) => w.householdId === householdId),
  };
}

function rotationMembersValid(householdId: string, memberIds: string[]): boolean {
  const ids = new Set(membersOf(householdId).map((m) => m.userId));
  return memberIds.every((id) => ids.has(id));
}

/**
 * Mirrors taskService.reassignInheritedOccurrence: a task whose assignment is
 * INHERITED re-inherits from its space when a new occurrence is generated —
 * which is where care rotation actually advances. Explicit assignments and
 * claims are never stomped. Called from every surface that completes a task
 * (app, sitter link, public API), because each one generates an occurrence.
 */
function advanceInheritedAssignment(task: Task): void {
  if (isExplicitAssignment(task)) return;
  const plant = db.plants.get(task.plantId);
  const space = plant?.spaceId ? db.spaces.get(plant.spaceId) : undefined;
  if (!space) return;
  const inherited = resolveInheritedAssignee(
    space,
    assignmentContextOf(task.householdId),
    new Date(task.nextDue)
  );
  task.assignedTo = inherited.userId;
  task.assignedToName = inherited.name;
  task.assignmentSource = inherited.source;
}

/** Mirrors handlers/plants listSpaces: derived rotationTurn on rotating spaces. */
app.get('/spaces', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const ctx = assignmentContextOf(user.householdId);
  res.json(
    [...db.spaces.values()]
      .filter((space) => space.householdId === user.householdId)
      .map((space) => {
        const base = {
          ...space,
          lightLevel: space.lightLevel ?? null,
          petAccess: space.petAccess ?? null,
          defaultCaregiverId: space.defaultCaregiverId ?? null,
          rotation: space.rotation ?? null,
        };
        if (!base.rotation) return base;
        const turn = resolveInheritedAssignee(base, ctx, new Date());
        return { ...base, rotationTurn: { turnUserId: turn.userId, turnName: turn.name } };
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  );
});

app.post(
  '/spaces',
  authMiddleware,
  requireHousehold,
  validateBody(createSpaceSchema),
  (req, res) => {
    const user = (req as any).user;
    const input = (req as any).validatedBody;
    const duplicate = [...db.spaces.values()].some(
      (space) =>
        space.householdId === user.householdId &&
        space.name.toLocaleLowerCase() === input.name.toLocaleLowerCase()
    );
    if (duplicate)
      return res.status(409).json({ message: 'A space with that name already exists' });
    if (
      input.defaultCaregiverId &&
      !db.users
        .get(input.defaultCaregiverId)
        ?.memberships.some((membership) => membership.householdId === user.householdId)
    ) {
      return res
        .status(400)
        .json({ message: 'defaultCaregiverId must be a current household member' });
    }
    if (input.rotation && !rotationMembersValid(user.householdId, input.rotation.memberIds)) {
      return res
        .status(400)
        .json({ message: 'rotation.memberIds must all be current household members' });
    }
    const now = new Date().toISOString();
    const space: PlantSpace = {
      id: uuidv4(),
      householdId: user.householdId,
      name: input.name.trim(),
      environment: input.environment,
      rainExposure:
        input.environment === 'outside' ? (input.rainExposure ?? 'exposed') : 'sheltered',
      lightLevel: input.lightLevel ?? null,
      petAccess: input.petAccess ?? null,
      defaultCaregiverId: input.defaultCaregiverId ?? null,
      rotation: input.rotation ? { ...input.rotation, anchor: input.rotation.anchor ?? now } : null,
      createdAt: now,
      createdBy: user.userId,
      updatedAt: now,
    };
    db.spaces.set(space.id, space);
    res.status(201).json(space);
  }
);

app.put(
  '/spaces/:id',
  authMiddleware,
  requireHousehold,
  validateBody(updateSpaceSchema),
  (req, res) => {
    const user = (req as any).user;
    const space = db.spaces.get(req.params.id);
    if (!space || space.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Space not found' });
    }
    const input = (req as any).validatedBody;
    if (
      input.defaultCaregiverId &&
      !db.users
        .get(input.defaultCaregiverId)
        ?.memberships.some((membership) => membership.householdId === user.householdId)
    ) {
      return res
        .status(400)
        .json({ message: 'defaultCaregiverId must be a current household member' });
    }
    if (input.name !== undefined) {
      const duplicate = [...db.spaces.values()].some(
        (candidate) =>
          candidate.id !== space.id &&
          candidate.householdId === user.householdId &&
          candidate.name.toLocaleLowerCase() === input.name.toLocaleLowerCase()
      );
      if (duplicate) {
        return res.status(409).json({ message: 'A space with that name already exists' });
      }
      space.name = input.name.trim();
    }
    if (input.environment !== undefined) space.environment = input.environment;
    if (input.environment === 'inside') {
      space.rainExposure = 'sheltered';
    } else if (input.rainExposure !== undefined) {
      space.rainExposure = input.rainExposure;
    } else if (input.environment === 'outside') {
      space.rainExposure = 'exposed';
    }
    if (input.lightLevel !== undefined) space.lightLevel = input.lightLevel;
    if (input.petAccess !== undefined) space.petAccess = input.petAccess;
    if (input.defaultCaregiverId !== undefined) {
      space.defaultCaregiverId = input.defaultCaregiverId;
    }
    if (input.rotation !== undefined) {
      if (input.rotation === null) {
        space.rotation = null;
      } else {
        if (!rotationMembersValid(user.householdId, input.rotation.memberIds)) {
          return res
            .status(400)
            .json({ message: 'rotation.memberIds must all be current household members' });
        }
        // Keep the anchor when the cadence is unchanged, mirroring spaceService.
        space.rotation = {
          memberIds: input.rotation.memberIds,
          cadence: input.rotation.cadence,
          anchor:
            input.rotation.anchor ??
            (space.rotation && space.rotation.cadence === input.rotation.cadence
              ? space.rotation.anchor
              : new Date().toISOString()),
        };
      }
    }
    space.updatedAt = new Date().toISOString();
    res.json(space);
  }
);

app.delete('/spaces/:id', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const space = db.spaces.get(req.params.id);
  if (!space || space.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Space not found' });
  }
  if (
    [...db.plants.values()].some(
      (plant) =>
        plant.householdId === user.householdId &&
        (plant.spaceId === space.id ||
          plant.summerSpaceId === space.id ||
          plant.winterSpaceId === space.id)
    )
  ) {
    return res.status(409).json({
      message: 'Remove this space from all current and seasonal plant homes before deleting it',
    });
  }
  db.spaces.delete(space.id);
  res.status(204).send();
});

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
    const {
      name,
      species,
      location,
      spaceId,
      placementNote,
      summerSpaceId,
      winterSpaceId,
      notes,
      careRule,
      tags,
      perenualSpeciesId,
      parentPlantId,
    } = (req as any).validatedBody;

    const h = db.households.get(user.householdId);
    const plan = PLANS[h?.planId ?? 'seedling'];
    const existing = [...db.plants.values()].filter(
      (p) => p.householdId === user.householdId && (p.status ?? 'active') === 'active'
    );
    if (atCap(existing.length, limitOf(plan, 'plants'))) {
      return res.status(402).json({
        message: `Your ${plan.name} plan is limited to ${limitOf(plan, 'plants')} plants. Remove or archive a plant before adding more.`,
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
    if (spaceId) {
      const space = db.spaces.get(spaceId);
      if (!space || space.householdId !== user.householdId) {
        return res.status(400).json({ message: 'Space not found in this household' });
      }
    }
    for (const seasonalSpaceId of [summerSpaceId, winterSpaceId]) {
      if (!seasonalSpaceId) continue;
      const space = db.spaces.get(seasonalSpaceId);
      if (!space || space.householdId !== user.householdId) {
        return res.status(400).json({ message: 'Seasonal home not found in this household' });
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
      spaceId: spaceId ?? null,
      placementNote: placementNote || null,
      summerSpaceId: summerSpaceId ?? null,
      winterSpaceId: winterSpaceId ?? null,
      imageUrl: null,
      notes: notes || null,
      careRule: careRule || null,
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

app.post(
  '/plants/move',
  authMiddleware,
  requireHousehold,
  validateBody(movePlantsSchema),
  (req, res) => {
    const user = (req as any).user;
    const { plantIds, spaceId, placementNote } = (req as any).validatedBody;
    if (spaceId) {
      const space = db.spaces.get(spaceId);
      if (!space || space.householdId !== user.householdId) {
        return res.status(400).json({ message: 'Space not found in this household' });
      }
    }
    const plants = plantIds.map((plantId: string) => db.plants.get(plantId));
    if (
      plants.some((plant: Plant | undefined) => !plant || plant.householdId !== user.householdId)
    ) {
      return res.status(404).json({ message: 'One or more plants were not found' });
    }
    const updatedAt = new Date().toISOString();
    for (const plant of plants as Plant[]) {
      plant.spaceId = spaceId;
      if (placementNote !== undefined) plant.placementNote = placementNote;
      plant.updatedAt = updatedAt;
    }
    res.json(plants);
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
    const planLimitMessage = `Plan limit reached: your ${plan.name} plan is limited to ${limitOf(plan, 'plants')} plants. Remove or archive existing plants before importing more.`;

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
      if (atCap(active.length, limitOf(plan, 'plants'))) {
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
        spaceId: null,
        placementNote: null,
        summerSpaceId: null,
        winterSpaceId: null,
        imageUrl: null,
        notes: input.notes || null,
        careRule: input.careRule || null,
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

  // Keep in step with RECENT_COMPLETIONS_LIMIT in handlers/plants/handler.ts
  // and frontend/src/services/plantService.ts — this is a window, not a total.
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
    if (body.spaceId !== undefined) {
      if (body.spaceId) {
        const space = db.spaces.get(body.spaceId);
        if (!space || space.householdId !== user.householdId) {
          return res.status(400).json({ message: 'Space not found in this household' });
        }
      }
      plant.spaceId = body.spaceId;
    }
    if (body.placementNote !== undefined) plant.placementNote = body.placementNote;
    for (const field of ['summerSpaceId', 'winterSpaceId'] as const) {
      if (body[field] === undefined) continue;
      if (body[field]) {
        const space = db.spaces.get(body[field]);
        if (!space || space.householdId !== user.householdId) {
          return res.status(400).json({ message: 'Seasonal home not found in this household' });
        }
      }
      plant[field] = body[field];
    }
    if (body.notes !== undefined) plant.notes = body.notes;
    // Mirrors plantService.updatePlant: an emptied rule clears to null.
    if (body.careRule !== undefined) plant.careRule = body.careRule || null;
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
      }[body.status];
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

  // A printed plant tag dies with its plant (mirrors the production handler's
  // best-effort revoke, ADR 0016).
  for (const tag of db.plantTags.values()) {
    if (tag.plantId === req.params.id && tag.status === 'active') {
      tag.status = 'revoked';
      tag.revokedAt = new Date().toISOString();
    }
  }

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
const IDENTIFY_ALLOWANCES: Record<string, number> = { seedling: 1, garden: 30, greenhouse: 100 };
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
    // Mirrors the production 402 contract: plan name + upgrade pointer, plus
    // the top-up `details`. The mock sells no packs (checkout is 503 below),
    // so the offer is never available and the balance is a real zero.
    return res.status(402).json({
      message: `Your ${meter.planName} plan is limited to ${meter.allowance} plant identifications per month. Upgrade for a higher monthly allowance.`,
      details: {
        code: 'IDENTIFY_BUDGET_EXHAUSTED',
        topUpAvailable: false,
        credits: (req as any).user.householdId ? { remaining: 0, expiresAt: null } : null,
        topUp: null,
      },
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
    const assessment = {
      demo: true,
      overall: 'monitor' as const,
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
    };
    recordActivity({
      type: 'plant.health_checked',
      householdId: user.householdId,
      actorId: user.userId,
      actorName: db.users.get(user.userId)?.name ?? user.email.split('@')[0],
      payload: {
        plantId: plant.id,
        plantName: plant.name,
        overall: assessment.overall,
        demo: assessment.demo,
      },
    });
    res.json(assessment);
  }
);

// Image upload contract (mirrors handlers/plants/handler.ts):
//   POST /plants/:id/image           — optional { contentType } ∈ jpeg/png/webp
//                                      (default jpeg); key extension matches.
//   PUT  /mock-upload/:token          — local stand-in for the presigned S3 PUT.
//   POST /plants/:id/image/confirm   — imageUrl must match a key we'd mint for
//                                      this plant and the PUT must have landed.
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Mirrors imageUploadRequestSchema in handlers/plants/handler.ts (body is
// optional/nullable for legacy clients that POST with no body).
const imageUploadRequestSchema = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
  })
  .nullable();

const IMAGES_BUCKET = process.env.IMAGES_BUCKET || 'family-greenhouse-images-local';

/**
 * The local server needs a URL the browser can actually display. Serve mock
 * objects directly from the local API origin; the development CSP permits
 * that exact host while the production edge policy remains HTTPS-only.
 */
function imageBaseUrl(): string {
  const base = process.env.ASSETS_BASE_URL?.replace(/\/+$/, '');
  if (base) return base;
  return `http://localhost:${PORT}/mock-images`;
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
    const uploadToken = uuidv4();
    db.mockUploadGrants.set(uploadToken, { key, contentType });
    res.json({
      // The page CSP explicitly permits localhost:4000 for API connections.
      // 127.0.0.1 is a different CSP origin and made the former URL fail
      // before it ever reached Express.
      uploadUrl: `http://localhost:${PORT}/mock-upload/${uploadToken}`,
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
    // Accept the local served form plus whichever URL forms production can
    // mint; all map to the same object key.
    const expectedPrefixes = [
      `${imageBaseUrl()}/${keyPrefix}`,
      `https://${IMAGES_BUCKET}.s3.amazonaws.com/${keyPrefix}`,
    ];
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
    const key = `${keyPrefix}${filename}`;
    const plant = db.plants.get(req.params.id);
    if (!plant || plant.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Plant not found' });
    }
    // Mirror production's HeadObject gate: never attach a URL until the PUT
    // actually landed with non-empty, allowed image bytes.
    const uploaded = db.mockImages.get(key);
    if (!uploaded) {
      return res
        .status(400)
        .json({ message: 'Uploaded image not found; upload it before confirming' });
    }
    if (uploaded.body.length === 0) {
      return res.status(400).json({ message: 'Uploaded image is empty' });
    }
    if (uploaded.body.length > MAX_IMAGE_BYTES) {
      db.mockImages.delete(key);
      return res.status(400).json({ message: 'Image exceeds the 5 MiB limit' });
    }
    if (!(uploaded.contentType in IMAGE_CONTENT_TYPES)) {
      db.mockImages.delete(key);
      return res.status(400).json({ message: 'Uploaded file is not a valid image' });
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
// call and expose ONLY the minimal due-task projection. Current space and
// placement note are shared; private notes, saved climate location, and member
// data are not.

/** Minimal due/overdue tasks for a household. Mirrors taskService.getSitterTasks:
 *  due on or before the link's own `expiresAt` OR overdue (never a fixed
 *  seven days), active plants only, with sitter-safe location. The kiosk
 *  reuses this with a cutoff of its own (now + KIOSK_LOOKAHEAD_DAYS), since a
 *  wall display has no expiry to honour. */
function sitterTasksFor(householdId: string, windowEndsAt: string) {
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoffIso = windowEndsAt > nowIso ? windowEndsAt : nowIso;
  return [...db.tasks.values()]
    .filter((t) => t.householdId === householdId)
    .filter((t) => (db.plants.get(t.plantId)?.status ?? 'active') === 'active')
    .filter((t) => t.nextDue <= cutoffIso)
    .sort((a, b) => new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime())
    .map((t) => {
      const plant = db.plants.get(t.plantId);
      const space = plant?.spaceId ? db.spaces.get(plant.spaceId) : undefined;
      return {
        taskId: t.id,
        plantName: t.plantName,
        taskType: t.customType || t.type,
        dueDate: t.nextDue,
        spaceName: space?.name ?? plant?.location ?? null,
        placementNote: plant?.placementNote ?? null,
        overdue: t.nextDue < nowIso,
      };
    });
}

// GET /sitter/:token
app.get('/sitter/:token', (req, res) => {
  const link = getActiveSitterLink(req.params.token);
  if (!link) {
    return res.status(404).json({ message: 'This sitter link is invalid or has expired.' });
  }
  const plan = PLANS[db.households.get(link.householdId)?.planId ?? 'seedling'] ?? PLANS.seedling;
  res.json({
    label: link.label,
    expiresAt: link.expiresAt,
    tasks: sitterTasksFor(link.householdId, link.expiresAt),
    briefAvailable: sitterBriefIncluded(plan),
  });
});

/** The handoff brief for one household over one link window. Mirrors
 *  services/sitterBrief.buildSitterBrief — plant by plant instead of task by
 *  task, with the household's own care words, the VERIFIED pet-toxicity entry
 *  (never generated, null when the curated table has no match), the latest
 *  photo, and the tasks due inside the window. */
function sitterBriefFor(link: SitterLink) {
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoffIso = link.expiresAt > nowIso ? link.expiresAt : nowIso;

  const plants = [...db.plants.values()].filter(
    (p) => p.householdId === link.householdId && (p.status ?? 'active') === 'active'
  );
  const tasksByPlant = new Map<
    string,
    Array<{ taskId: string; taskType: string; dueDate: string; overdue: boolean }>
  >();
  for (const task of db.tasks.values()) {
    if (task.householdId !== link.householdId || task.nextDue > cutoffIso) continue;
    const list = tasksByPlant.get(task.plantId) ?? [];
    list.push({
      taskId: task.id,
      taskType: task.customType || task.type,
      dueDate: task.nextDue,
      overdue: task.nextDue < nowIso,
    });
    tasksByPlant.set(task.plantId, list);
  }
  for (const list of tasksByPlant.values()) {
    list.sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  }

  const entries = plants.map((plant) => ({
    plantId: plant.id,
    name: plant.name,
    spaceName: plant.spaceId
      ? (db.spaces.get(plant.spaceId)?.name ?? plant.location ?? null)
      : (plant.location ?? null),
    placementNote: plant.placementNote?.trim() || null,
    ...resolveCareNote(plant),
    photoUrl: plant.imageUrl ?? null,
    petSafety: resolvePetSafety(plant),
    tasks: tasksByPlant.get(plant.id) ?? [],
  }));
  entries.sort((a, b) => {
    const aDue = a.tasks[0]?.dueDate;
    const bDue = b.tasks[0]?.dueDate;
    if (aDue && bDue) return aDue < bDue ? -1 : aDue > bDue ? 1 : a.name.localeCompare(b.name);
    if (aDue) return -1;
    if (bDue) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    label: link.label,
    startsAt: link.startsAt,
    expiresAt: link.expiresAt,
    plants: entries,
  };
}

// GET /sitter/:token/brief
app.get('/sitter/:token/brief', (req, res) => {
  const link = getActiveSitterLink(req.params.token);
  if (!link) {
    return res.status(404).json({ message: 'This sitter link is invalid or has expired.' });
  }
  // Paid half of the Away Kit. A plan without it answers the SAME generic 404
  // as a bad token — an anonymous sitter is never told the household's tier.
  const plan = PLANS[db.households.get(link.householdId)?.planId ?? 'seedling'] ?? PLANS.seedling;
  if (!sitterBriefIncluded(plan)) {
    return res.status(404).json({ message: 'This sitter link is invalid or has expired.' });
  }
  res.json(sitterBriefFor(link));
});

const sitterCompleteTaskSchema = z
  .object({ expectedNextDue: z.string().datetime().optional() })
  .nullish();

// POST /sitter/:token/tasks/:taskId/complete
app.post(
  '/sitter/:token/tasks/:taskId/complete',
  validateBody(sitterCompleteTaskSchema),
  (req, res) => {
    const link = getActiveSitterLink(req.params.token);
    if (!link) {
      return res.status(404).json({ message: 'This sitter link is invalid or has expired.' });
    }
    const task = db.tasks.get(req.params.taskId);
    // Cross-household guard: the task must live in the token's household.
    if (!task || task.householdId !== link.householdId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const expectedNextDue = (req as any).validatedBody?.expectedNextDue as string | undefined;
    if (expectedNextDue !== undefined && task.nextDue !== expectedNextDue) {
      return res.json({
        taskId: task.id,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        dueDate: task.nextDue,
        spaceName: null,
        placementNote: null,
        overdue: false,
      });
    }

    const now = new Date();
    const nextDue = new Date(now);
    nextDue.setDate(nextDue.getDate() + task.frequency);
    task.lastCompleted = now.toISOString();
    task.nextDue = nextDue.toISOString();
    advanceInheritedAssignment(task);

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
      spaceName: null,
      placementNote: null,
      overdue: false,
    });
  }
);

// --- Kiosk (wall display) PUBLIC endpoints (no auth) ----------------------
// Mirrors handlers/tasks/kiosk.ts. Same token-in-path credential as the sitter
// routes, but the token is LONG-LIVED and permanently displayed — see the
// threat model at the top of services/kioskService.ts.

/** The kiosk's own lookahead cutoff. A wall display has no `expiresAt` to
 *  honour — it answers "what needs doing today" — so it supplies a rolling
 *  cutoff instead of a link window. Mirrors handlers/tasks/kiosk.ts. */
function kioskWindowEndsAt(now: Date = new Date()): string {
  return new Date(now.getTime() + KIOSK_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// GET /kiosk/:token
app.get('/kiosk/:token', (req, res) => {
  const link = getActiveKioskLink(req.params.token);
  if (!link) {
    return res.status(404).json({ message: 'This kiosk link is invalid or has been turned off.' });
  }
  res.json({
    pollIntervalSeconds: link.pollIntervalSeconds,
    tasks: sitterTasksFor(link.householdId, kioskWindowEndsAt()),
  });
});

const kioskCompleteTaskSchema = z
  .object({ expectedNextDue: z.string().datetime().optional() })
  .nullish();

// POST /kiosk/:token/tasks/:taskId/complete
app.post(
  '/kiosk/:token/tasks/:taskId/complete',
  validateBody(kioskCompleteTaskSchema),
  (req, res) => {
    const link = getActiveKioskLink(req.params.token);
    if (!link) {
      return res
        .status(404)
        .json({ message: 'This kiosk link is invalid or has been turned off.' });
    }
    const task = db.tasks.get(req.params.taskId);
    // Cross-household guard: the task must live in the token's household.
    if (!task || task.householdId !== link.householdId) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const expectedNextDue = (req as any).validatedBody?.expectedNextDue as string | undefined;
    if (expectedNextDue !== undefined && task.nextDue !== expectedNextDue) {
      return res.json({
        taskId: task.id,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        dueDate: task.nextDue,
        spaceName: null,
        placementNote: null,
        overdue: false,
      });
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
      completedBy: `kiosk:${link.id}`,
      completedByName: 'the kiosk display',
      completedAt: now.toISOString(),
      notes: null,
    });
    recordActivity({
      type: 'task.completed',
      householdId: task.householdId,
      actorId: `kiosk:${link.id}`,
      actorName: 'the kiosk display',
      payload: {
        taskId: task.id,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        viaKiosk: true,
      },
    });

    res.json({
      taskId: task.id,
      plantName: task.plantName,
      taskType: task.customType || task.type,
      dueDate: task.nextDue,
      spaceName: null,
      placementNote: null,
      overdue: false,
    });
  }
);

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
  if (atCap(existing.length, limitOf(plan, 'plants'))) {
    return res.status(402).json({
      message: `Your ${plan.name} plan is limited to ${limitOf(plan, 'plants')} plants. Remove or archive a plant before adding more.`,
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
    spaceId: null,
    placementNote: null,
    summerSpaceId: null,
    winterSpaceId: null,
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
  const plant = db.plants.get(input.plantId);
  const space = plant?.spaceId ? db.spaces.get(plant.spaceId) : undefined;
  // Mirrors handlers/tasks inheritedAssignmentForPlant: the shared resolver
  // ranks rotation above the space default, for the occurrence's own due date.
  const inherited = space
    ? resolveInheritedAssignee(space, assignmentContextOf(householdId), new Date(nextDue))
    : { userId: null, name: null, source: null as Task['assignmentSource'] };
  let assignedTo = input.assignedTo ?? inherited.userId ?? null;
  let assignmentSource: Task['assignmentSource'] =
    input.assignedTo === undefined && inherited.userId ? inherited.source : null;
  let assignedToName: string | null = null;
  if (assignedTo) {
    const assignee = db.users.get(assignedTo);
    if (assignee?.memberships.some((membership) => membership.householdId === householdId)) {
      assignedToName = assignee.name;
    } else {
      assignedTo = null;
      assignmentSource = null;
    }
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
    assignedTo,
    assignedToName,
    assignmentSource,
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

// POST /tasks/:id/claim — mirrors taskService.claimTask: space-inherited
// assignments can be taken over, while explicit assignments return 409.
app.post('/tasks/:id/claim', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  const task = db.tasks.get(req.params.id);
  if (!task || task.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Task not found' });
  }
  // Inherited assignments (space default OR rotation turn) can be taken over.
  if (task.assignedTo && task.assignmentSource === null) {
    return res.status(409).json({ message: 'Already claimed' });
  }
  const dbUser = db.users.get(user.userId);
  task.assignedTo = user.userId;
  task.assignedToName = dbUser?.name ?? null;
  task.assignmentSource = null;
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
  task.assignmentSource = null;
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

// POST /tasks/:id/ask — mirrors services/askFamily.askFamilyForHelp: the
// occurrence goes up for grabs through the SAME escalated state auto-handoff
// uses, the ask is recorded on the row, and everyone but the asker, anyone
// away and anyone inside Do-Not-Disturb is notified. Free on every tier.
app.post(
  '/tasks/:id/ask',
  authMiddleware,
  requireHousehold,
  validateBody(askForHelpSchema),
  (req, res) => {
    const user = (req as any).user;
    const body = (req as any).validatedBody as { note?: string; expectedNextDue?: string };
    const task = db.tasks.get(req.params.id);
    if (!task || task.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (body.expectedNextDue && body.expectedNextDue !== task.nextDue) {
      return res
        .status(409)
        .json({ message: 'This task changed while you were asking. Reload and try again.' });
    }
    // Somebody else's explicit claim is theirs to release; inherited
    // assignments stay askable, exactly as they stay claimable.
    if (task.assignedTo && task.assignmentSource === null && task.assignedTo !== user.userId) {
      return res.status(403).json({
        message:
          'This task is assigned to someone else — only they can ask the household to take it.',
      });
    }
    if (task.helpAskedForDue === task.nextDue) {
      return res
        .status(409)
        .json({ message: 'Someone has already asked the household about this one.' });
    }

    const now = new Date();
    const markerKey = `${user.householdId}|${task.id}|${String(user.userId)}`;
    const previous = db.helpAsks.get(markerKey);
    if (previous && now.getTime() - Date.parse(previous.askedAt) < ASK_HELP_WINDOW_MS) {
      return res.status(429).json({
        message: 'You already asked about this task today. You can ask again tomorrow.',
        details: {
          nextAllowedAt: new Date(Date.parse(previous.askedAt) + ASK_HELP_WINDOW_MS).toISOString(),
        },
      });
    }
    db.helpAsks.set(markerKey, { askedAt: now.toISOString() });

    const members = membersOf(user.householdId);
    const askerName =
      members.find((m) => m.userId === user.userId)?.name?.trim() || 'A household member';
    const note = normalizeHelpNote(body.note);
    const vacations = activeVacationMap(user.householdId, now.toISOString());
    const recipients = members.filter(
      (m) =>
        m.userId !== user.userId &&
        !vacations.has(m.userId) &&
        !localInDndWindow(db.notificationPrefs.get(m.userId) ?? defaultPrefs(m.userId), now)
    );
    const skipped = members
      .filter((m) => m.userId !== user.userId && !recipients.some((r) => r.userId === m.userId))
      .map((m) => ({
        userId: m.userId,
        name: m.name,
        reason: vacations.has(m.userId) ? 'away' : 'dnd',
      }));

    task.helpAskedAt = now.toISOString();
    task.helpAskedBy = user.userId;
    task.helpAskedByName = askerName;
    task.helpAskedNote = note;
    task.helpAskedForDue = task.nextDue;
    task.escalatedAt = now.toISOString();
    task.escalatedForDue = task.nextDue;
    task.escalatedFrom = task.assignedTo ?? task.escalatedFrom ?? null;
    task.assignedTo = null;
    task.assignedToName = null;
    task.assignmentSource = null;

    recordActivity({
      type: 'task.help_requested',
      householdId: user.householdId,
      actorId: user.userId,
      actorName: askerName,
      payload: {
        taskId: task.id,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        note,
        notified: recipients.length,
      },
    });

    // The mock never sends: `delivered` counts what actually left the
    // building, and in dev nothing does. Reporting the recipient count here
    // would be exactly the "absence rendered as a value" defect the real
    // service is written to avoid.
    res.json({
      task: { ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName },
      note,
      askedAt: now.toISOString(),
      nextAllowedAt: new Date(now.getTime() + ASK_HELP_WINDOW_MS).toISOString(),
      recipients: recipients.map((r) => ({ userId: r.userId, name: r.name })),
      skipped,
      delivered: 0,
    });
  }
);

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
      task.assignmentSource = null;
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
    const { days, reason, note, expectedNextDue } = (req as any).validatedBody;
    if (expectedNextDue !== undefined && task.nextDue !== expectedNextDue) {
      return res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
    }
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

    const expectedNextDue = (req as any).validatedBody.expectedNextDue as string | undefined;
    if (expectedNextDue !== undefined && task.nextDue !== expectedNextDue) {
      return res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
    }

    // Mirror handlers/tasks detectDoubleCare: on household-toolkit tiers,
    // check this plant's completion log for another member's completion
    // inside the care type's window BEFORE anything is written. A suspected
    // duplicate is a 409 the client confirms past with confirmDuplicate.
    const now = new Date();
    let duplicateOfCompletionId: string | null = null;
    if (householdHasToolkit(user.householdId)) {
      const duplicate = pickRecentDuplicate(
        [...db.completions.values()].filter(
          (c) => c.householdId === task.householdId && c.plantId === task.plantId
        ),
        {
          taskId: task.id,
          taskType: task.customType || task.type,
          actorId: user.userId,
          now,
        }
      );
      if (duplicate) {
        if (!(req as any).validatedBody.confirmDuplicate) {
          return res.status(409).json({
            message: `${duplicate.completedByName} already logged ${duplicate.taskType} for ${task.plantName}. Send confirmDuplicate: true to log it anyway.`,
            details: { code: 'DUPLICATE_CARE', plantName: task.plantName, duplicate },
          });
        }
        duplicateOfCompletionId = duplicate.completionId;
      }
    }

    // Mirror taskService.completeTask: advance the schedule from NOW (the
    // production write is conditioned on the just-read nextDue, which makes
    // a concurrent double-complete a no-op; this single-threaded mock can't
    // race, so the sequential semantics below are identical).
    const nextDue = new Date(now);
    nextDue.setDate(nextDue.getDate() + task.frequency);
    task.lastCompleted = now.toISOString();
    task.nextDue = nextDue.toISOString();
    advanceInheritedAssignment(task);

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
      duplicateOfCompletionId,
    });

    res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
  }
);

// GET /plants/:plantId/schedule-drift — mirrors handlers/tasks getPlantScheduleDrift.
app.get('/plants/:plantId/schedule-drift', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  if (!householdHasToolkit(user.householdId)) {
    return res.json({ available: false, reason: 'not_in_plan', tasks: [] });
  }
  const plant = db.plants.get(req.params.plantId);
  if (!plant || plant.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Plant not found' });
  }
  const tasks = [...db.tasks.values()].filter(
    (t) => t.householdId === user.householdId && t.plantId === plant.id
  );
  const completions = [...db.completions.values()].filter(
    (c) => c.householdId === user.householdId && c.plantId === plant.id
  );
  res.json({
    available: true,
    reason: null,
    tasks: tasks.map((t) =>
      computeScheduleDrift(
        t.id,
        t.frequency,
        completions.filter((c) => c.taskId === t.id)
      )
    ),
  });
});

// POST /tasks/:id/match-schedule — mirrors handlers/tasks matchTaskSchedule.
app.post('/tasks/:id/match-schedule', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  if (!householdHasToolkit(user.householdId)) {
    return res.status(402).json({
      message:
        'Schedule-drift suggestions are part of the Garden household toolkit. Upgrade to match a schedule to reality.',
    });
  }
  const task = db.tasks.get(req.params.id);
  if (!task || task.householdId !== user.householdId) {
    return res.status(404).json({ message: 'Task not found' });
  }
  const reading = computeScheduleDrift(
    task.id,
    task.frequency,
    [...db.completions.values()].filter(
      (c) => c.householdId === user.householdId && c.taskId === task.id
    )
  );
  if (!reading.drift || !reading.drift.exceedsThreshold) {
    return res
      .status(409)
      .json({ message: 'This task’s schedule already matches how often it gets done.' });
  }
  const previousFrequency = task.frequency;
  task.frequency = reading.drift.suggestedFrequency;
  const nextDue = nextDueAfterMatch(task.lastCompleted, task.frequency, new Date());
  if (nextDue) task.nextDue = nextDue;
  recordActivity({
    type: 'task.schedule_matched',
    householdId: user.householdId,
    actorId: user.userId,
    actorName: db.users.get(user.userId)?.name ?? user.email.split('@')[0],
    payload: {
      taskId: task.id,
      plantId: task.plantId,
      plantName: task.plantName,
      taskType: task.customType || task.type,
      previousFrequency,
      newFrequency: task.frequency,
      medianIntervalDays: reading.drift.medianIntervalDays,
      completionsConsidered: reading.completionsConsidered,
    },
  });
  res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
});

app.get('/households/:id/analytics/daily', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  if (user.householdId !== req.params.id) {
    return res.status(403).json({ message: 'Access denied' });
  }
  const daysRaw = req.query.days;
  const requestedDays = Math.max(
    1,
    Math.min(180, typeof daysRaw === 'string' ? parseInt(daysRaw, 10) || 30 : 30)
  );
  // Analytics window — mirrors handlers/households/handler.ts (ADR 0014).
  const plan = PLANS[db.households.get(req.params.id)?.planId ?? 'seedling'];
  const historyLimitDays = limitOf(plan, 'analyticsHistoryDays');
  const days =
    historyLimitDays === null ? requestedDays : Math.min(requestedDays, historyLimitDays);
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
  // Mirror handlers/households confirmedDoubleCareThisMonth: a count on
  // toolkit tiers, an explicit not_in_plan otherwise (never a silent 0).
  const month = now.toISOString().slice(0, 7);
  const doubleCare = householdHasToolkit(req.params.id)
    ? {
        status: 'ok',
        month,
        confirmedDuplicates: [...db.completions.values()].filter(
          (c) =>
            c.householdId === req.params.id &&
            c.completedAt >= `${month}-01T00:00:00.000Z` &&
            typeof c.duplicateOfCompletionId === 'string'
        ).length,
      }
    : { status: 'not_in_plan' };
  res.json({
    days,
    series: [...buckets.entries()].map(([date, count]) => ({ date, count })),
    doubleCare,
    historyLimitDays,
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
  // Analytics window — mirrors handlers/households/handler.ts (ADR 0014):
  // the free tier gets the year intersected with its trailing window.
  const plan = PLANS[db.households.get(req.params.id)?.planId ?? 'seedling'];
  const historyLimitDays = limitOf(plan, 'analyticsHistoryDays');
  const window =
    historyLimitDays === null
      ? { start: `${year}-01-01T00:00:00.000Z`, end: `${year + 1}-01-01T00:00:00.000Z` }
      : analyticsWindow(year, historyLimitDays);
  const { start, end } = window;
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
    historyLimitDays,
    ...(historyLimitDays === null ? {} : { windowStart: start, windowEnd: end }),
    totalCompletions: items.length,
    byMember: [...memberCounts.entries()]
      .map(([userId, v]) => ({ userId, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count),
    byTaskType: [...typeCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    // Complete list, like the real service — the analytics page treats
    // absence as a true zero.
    topPlants: [...plantCounts.entries()]
      .map(([plantId, count]) => ({ plantId, count }))
      .sort((a, b) => b.count - a.count),
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
  // Local dev deliberately has no Perenual key. Mirror production's
  // discriminated response so the real frontend exercises the conservative
  // unavailable state instead of treating an ambiguous null as no result.
  res.set('Cache-Control', 'private, no-store');
  res.json({ status: 'unavailable', reason: 'unconfigured', result: null });
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
  const paymentsAvailable = paymentsAreAvailable();
  // Reuse the production projection so the dev server cannot drift from the
  // real contract or publish prices while the commercial hold is active.
  res.json({
    paymentsAvailable,
    commercialHold: {
      active: COMMERCIAL_HOLD_ACTIVE,
      effectiveDate: COMMERCIAL_HOLD_EFFECTIVE_DATE,
    },
    plans: Object.values(PLANS).map((plan) => planSummary(plan, paymentsAvailable)),
    identifyTopUp: identifyTopUpSummary(paymentsAvailable),
  });
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
  const usage = {
    plantCount,
    maxPlants: limitOf(plan, 'plants'),
    memberCount,
    maxMembers: limitOf(plan, 'members'),
  };
  res.json({
    planId,
    stripeCustomerId: h?.stripeCustomerId,
    stripeSubscriptionId: h?.stripeSubscriptionId,
    status: h?.subscriptionStatus,
    // Local counts are always available, so expose both the legacy numeric
    // shape and the additive nullable-capable shape with identical values.
    usage,
    usageDetail: usage,
    // The mock sells no top-up packs, so the balance is a real zero.
    identifyCredits: { remaining: 0, expiresAt: null },
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
  (_req, res) => {
    // The mock mirrors production's fail-closed commercial status. Tests that
    // need a paid entitlement seed the in-memory fixture directly.
    res.status(503).json({ message: 'Payments are currently paused.' });
  }
);

// Mirrors topUpCheckout in handlers/billing/handler.ts: the mock never has
// a top-up price configured, so it answers the same fail-closed 400.
app.post(
  '/billing/top-up/checkout',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  (_req, res) => {
    res.status(400).json({
      message: 'Identification top-up packs are not available in this environment.',
      details: { code: 'TOP_UP_NOT_CONFIGURED' },
    });
  }
);

app.post('/billing/portal', authMiddleware, requireHousehold, requireAdmin, (_req, res) => {
  res.status(503).json({ message: 'Billing access is currently paused.' });
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
  action: z.literal('message').optional(),
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  // Idempotency key (#3). The mock has no Bedrock/budget so it just accepts it.
  turnId: z.string().uuid().optional(),
});

const chatRequestSchema = z.union([
  z.object({
    action: z.literal('report'),
    conversationId: z.string().uuid(),
    responseText: z.string().trim().min(1).max(8000),
    reason: z.enum(['incorrect', 'unsafe', 'offensive', 'other']),
    details: z.string().trim().max(1000).optional(),
  }),
  sendMessageSchema,
]);

const CHAT_BUDGET = {
  maxInputTokensPerMonth: Number(process.env.CHAT_BUDGET_INPUT_TOKENS || '250000'),
  maxOutputTokensPerMonth: Number(process.env.CHAT_BUDGET_OUTPUT_TOKENS || '50000'),
};

app.post(
  '/chat/messages',
  authMiddleware,
  requireHousehold,
  validateBody(chatRequestSchema),
  (req, res) => {
    const body = (req as any).validatedBody;
    if (body.action === 'report') {
      const user = (req as any).user;
      const reportId = uuidv4();
      db.chatReports.set(reportId, {
        id: reportId,
        userId: user.userId,
        householdId: user.householdId,
        conversationId: body.conversationId,
        responseText: body.responseText,
        reason: body.reason,
        details: body.details || null,
        createdAt: new Date().toISOString(),
      });
      return res.json({ accepted: true, reportId });
    }
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
    // Household emails (services/householdEmails.ts) follow the same rule.
    memberJoined: true,
    taskUpForGrabs: true,
    coverageUpdates: true,
    careCredit: true,
    yearRecap: true,
    // '' is "never chosen" — deliberately distinguishable from 'en'.
    emailLocale: '',
    phoneVerified: false,
    updatedAt: new Date().toISOString(),
  };
}

const TIME_HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

// Mirrors prefsSchema in handlers/notifications/handler.ts.
const prefsSchema = z
  .object({
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
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine((timezone) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: timezone });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown timezone')
      .default('UTC'),
    pestAlerts: z.boolean().default(false),
    weeklyDigest: z.boolean().optional(),
    memberJoined: z.boolean().optional(),
    taskUpForGrabs: z.boolean().optional(),
    coverageUpdates: z.boolean().optional(),
    careCredit: z.boolean().optional(),
    yearRecap: z.boolean().optional(),
    emailLocale: z.enum(['', 'en', 'es']).optional(),
  })
  .refine((prefs) => Boolean(prefs.dndStart) === Boolean(prefs.dndEnd), {
    message: 'Quiet hours require both a start and end time',
    path: ['dndEnd'],
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
  endpoint: z
    .string()
    .url()
    .max(4096)
    .refine(
      isAllowedPushEndpoint,
      'Push endpoint must be issued by a supported browser push service'
    ),
  keys: z.object({
    p256dh: z.string().min(8),
    auth: z.string().min(8),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url().max(4096),
});

// Mirrors registerDeviceSchema / unregisterDeviceSchema (native Capacitor push).
const registerDeviceSchema = z.object({
  platform: z.enum(['ios', 'android']),
  token: z.string().min(16).max(4096),
});

const unregisterDeviceSchema = z.object({
  token: z.string().min(16).max(4096),
});

/**
 * Mirrors `withEmailDeliverability` in handlers/notifications/handler.ts. The
 * mock has no failing store, so the third state (`unknown`) is unreachable
 * here — production reaches it when the suppression row cannot be read.
 */
function withEmailDeliverability<T extends object>(
  preferences: T,
  email: string
): T & { emailStatus: 'ok' | 'undeliverable'; emailSuppressionReason: string | null } {
  const record = db.emailSuppressions.get(email.trim().toLowerCase());
  return {
    ...preferences,
    emailStatus: record ? 'undeliverable' : 'ok',
    emailSuppressionReason: record ? record.reason : null,
  };
}

app.get('/notifications/prefs', authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.json({
    ...withEmailDeliverability(
      db.notificationPrefs.get(user.userId) ?? defaultPrefs(user.userId),
      user.email
    ),
    smsAvailable: true,
  });
});

app.delete('/notifications/email-suppression', authMiddleware, (req, res) => {
  const user = (req as any).user;
  db.emailSuppressions.delete(String(user.email).trim().toLowerCase());
  res.json({
    ...withEmailDeliverability(
      db.notificationPrefs.get(user.userId) ?? defaultPrefs(user.userId),
      user.email
    ),
    smsAvailable: true,
  });
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
    memberJoined: body.memberJoined ?? current.memberJoined,
    taskUpForGrabs: body.taskUpForGrabs ?? current.taskUpForGrabs,
    coverageUpdates: body.coverageUpdates ?? current.coverageUpdates,
    careCredit: body.careCredit ?? current.careCredit,
    yearRecap: body.yearRecap ?? current.yearRecap,
    emailLocale: body.emailLocale ?? current.emailLocale,
    phoneVerified,
    updatedAt: new Date().toISOString(),
  };
  db.notificationPrefs.set(user.userId, updated);
  res.json({ ...withEmailDeliverability(updated, user.email), smsAvailable: true });
});

/**
 * One-click unsubscribe (RFC 8058), mirroring
 * handlers/notifications/handler.ts. Secrets live in memory here instead of
 * `USER#{id}/EMAILCAP`, but the token format and the verification rules are
 * the production ones — `verifyTokenWithSecret` is the same function the
 * Lambda calls, so a dev-minted link behaves exactly like a real one.
 *
 * `GET /notifications/email/dev-token?category=weekly_digest` is DEV ONLY:
 * it mints a link so the flow can be exercised without SES.
 */
/**
 * Per-IP throttle for the unauthenticated unsubscribe routes, mirroring the
 * production limits in handlers/notifications/handler.ts (GET 30/min for link
 * prefetchers, POST 10/min).
 *
 * Production is already protected three ways and this dev mirror is not
 * internet-facing — it refuses to boot when NODE_ENV=production (top of this
 * file). It gets a limiter anyway for two reasons. First, a dev mirror that
 * behaves differently from production is its own class of bug: the point of
 * this file is that what you exercise locally is what ships. Second, CodeQL
 * reads `verifyTokenWithSecret` as an authorization decision on an
 * unauthenticated route and flags the missing throttle
 * (js/missing-rate-limiting) — correctly, on the code as written. Mirroring
 * the real limit is cheaper and more honest than suppressing the alert.
 *
 * `express-rate-limit` rather than a hand-rolled bucket: a hand-rolled one
 * worked but CodeQL only recognises known limiter libraries, so the alert
 * stayed open on code that was actually rate-limited. It is a devDependency
 * alongside `express` itself — `local-server.ts` is the dev server and is not
 * in the Lambda bundle (backend/esbuild.config.js takes only
 * `handlers/**\/handler.ts`), so this adds zero production bytes.
 *
 * The two routes get SEPARATE limiter instances, and therefore separate
 * stores, so a scanning proxy prefetching the GET cannot spend the POST's
 * budget and hand a 429 to the human who then clicks Unsubscribe. Production
 * gets the same separation for free by keying on API Gateway's per-method
 * routeKey.
 */
const unsubscribeFormStore = new MemoryStore();
const unsubscribeSubmitStore = new MemoryStore();

function unsubscribeLimiter(limit: number, store: MemoryStore) {
  return expressRateLimit({
    windowMs: 60_000,
    limit,
    store,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ message: 'Too many requests. Please slow down and try again.' }),
  });
}

const unsubscribeFormRateLimit = unsubscribeLimiter(30, unsubscribeFormStore);
const unsubscribeSubmitRateLimit = unsubscribeLimiter(10, unsubscribeSubmitStore);

/** Mirrors `__resetRateLimitForTests` in middleware/rateLimit.ts so an
 *  integration test can exercise the limiter without leaking buckets into the
 *  next case. */
export function __resetUnsubscribeRateLimitForTests(): void {
  void unsubscribeFormStore.resetAll?.();
  void unsubscribeSubmitStore.resetAll?.();
}

const emailCapabilitySecrets = new Map<string, string>();
function localCapabilitySecret(userId: string): string {
  const existing = emailCapabilitySecrets.get(userId);
  if (existing) return existing;
  const fresh = randomBytes(32).toString('base64url');
  emailCapabilitySecrets.set(userId, fresh);
  return fresh;
}

function localTokenUserId(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  try {
    const userId = Buffer.from(parts[1], 'base64url').toString('utf8');
    return userId || null;
  } catch {
    return null;
  }
}

function unsubscribeLang(req: { query: Record<string, unknown> }): 'en' | 'es' {
  return req.query.lang === 'es' ? 'es' : 'en';
}

type HtmlResponse = {
  status: (code: number) => HtmlResponse;
  type: (kind: string) => HtmlResponse;
  set: (header: string, value: string) => HtmlResponse;
  send: (body: string) => unknown;
};

function sendUnsubscribeHtml(res: HtmlResponse, status: number, body: string): void {
  res.status(status).type('html').set('Cache-Control', 'no-store').send(body);
}

app.get('/notifications/email/dev-token', authMiddleware, (req, res) => {
  const user = (req as any).user;
  const category = isEmailCategory(req.query.category) ? req.query.category : 'weekly_digest';
  const expiresAt = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60;
  const token = signToken(localCapabilitySecret(user.userId), user.userId, category, expiresAt);
  res.json({ token, url: `http://localhost:4000/notifications/email/unsubscribe?t=${token}` });
});

app.get('/notifications/email/unsubscribe', unsubscribeFormRateLimit, (req, res) => {
  const locale = unsubscribeLang(req);
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  const userId = token ? localTokenUserId(token) : null;
  if (!token || !userId) return sendUnsubscribeHtml(res, 400, renderInvalidPage(locale));
  const verified = verifyTokenWithSecret(token, localCapabilitySecret(userId));
  if (verified.status !== 'ok') return sendUnsubscribeHtml(res, 410, renderInvalidPage(locale));
  return sendUnsubscribeHtml(
    res,
    200,
    renderConfirmPage({
      locale,
      actionUrl: `http://localhost:4000/notifications/email/unsubscribe?t=${encodeURIComponent(token)}&lang=${locale}`,
      category: verified.category,
    })
  );
});

app.post('/notifications/email/unsubscribe', unsubscribeSubmitRateLimit, (req, res) => {
  const locale = unsubscribeLang(req);
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  const userId = token ? localTokenUserId(token) : null;
  if (!token || !userId) return sendUnsubscribeHtml(res, 400, renderInvalidPage(locale));
  const verified = verifyTokenWithSecret(token, localCapabilitySecret(userId));
  if (verified.status !== 'ok') return sendUnsubscribeHtml(res, 410, renderInvalidPage(locale));
  const current = db.notificationPrefs.get(verified.userId) ?? defaultPrefs(verified.userId);
  const field =
    verified.category === 'weekly_digest'
      ? 'weeklyDigest'
      : verified.category === 'year_recap'
        ? 'yearRecap'
        : 'pestAlerts';
  db.notificationPrefs.set(verified.userId, {
    ...current,
    [field]: false,
    updatedAt: new Date().toISOString(),
  });
  return sendUnsubscribeHtml(res, 200, renderDonePage(locale, verified.category));
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
    res.json({ ...withEmailDeliverability(updated, user.email), smsAvailable: true });
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
    const remainingSubscriptions = [...db.pushSubscriptions.values()].filter(
      (subscription) => subscription.userId === user.userId
    ).length;
    res.json({ ok: true, remainingSubscriptions });
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

function localReminderDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function localInDndWindow(prefs: NotificationPrefsRecord, now: Date): boolean {
  if (!prefs.dndStart || !prefs.dndEnd || prefs.dndStart === prefs.dndEnd) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: prefs.timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
    const current = hour * 60 + minute;
    const [startHour, startMinute] = prefs.dndStart.split(':').map(Number);
    const [endHour, endMinute] = prefs.dndEnd.split(':').map(Number);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    return start < end ? current >= start && current < end : current >= start || current < end;
  } catch {
    return false;
  }
}

app.post(
  '/notifications/run-reminders',
  authMiddleware,
  requireHousehold,
  requireAdmin,
  (req, res) => {
    const user = (req as any).user;
    const now = new Date();
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const members = [...db.users.values()].filter((member) =>
      member.memberships.some((membership) => membership.householdId === user.householdId)
    );
    const memberIds = new Set(members.map((member) => member.id));
    const vacations = activeVacationMap(user.householdId, nowIso);
    const due = [...db.tasks.values()].filter(
      (task) =>
        task.householdId === user.householdId &&
        isActivePlant(task.plantId) &&
        task.nextDue <= cutoff
    );
    const effectiveAssignee = (task: Task): string | null => {
      if (!task.assignedTo) return null;
      const vacation = vacations.get(task.assignedTo);
      if (vacation && vacation.coveredBy !== task.assignedTo && memberIds.has(vacation.coveredBy)) {
        return vacation.coveredBy;
      }
      return task.assignedTo;
    };
    const deliverable = (userId: string | null) =>
      userId !== null && memberIds.has(userId) && !vacations.has(userId);
    const unassigned = due.filter((task) => !deliverable(effectiveAssignee(task)));
    let simulated = 0;
    const simulatedByChannel = { browser: 0, email: 0, sms: 0 };
    for (const member of members) {
      if (vacations.has(member.id)) continue;
      const mine = due.filter((task) => effectiveAssignee(task) === member.id);
      const tasksForMember = [...mine, ...unassigned];
      if (tasksForMember.length === 0) continue;
      const prefs = db.notificationPrefs.get(member.id) ?? defaultPrefs(member.id);
      const markerBase = `${member.id}|${user.householdId}|${localReminderDate(
        now,
        prefs.timezone || 'UTC'
      )}`;
      // Compatibility with the aggregate local marker shape used before
      // channel-scoped dedupe. A live dev process may retain one across HMR.
      if (db.reminderSent.has(markerBase)) continue;
      const headline = `${tasksForMember.length} task${tasksForMember.length === 1 ? '' : 's'} due`;
      const inDnd = localInDndWindow(prefs, now);
      let memberSimulated = false;
      const hasPushSubscription = [...db.pushSubscriptions.values()].some(
        (subscription) => subscription.userId === member.id
      );
      const browserMarker = `${markerBase}|browser`;
      if (prefs.browser && hasPushSubscription && !db.reminderSent.has(browserMarker)) {
        console.log(`[push dry-run] -> ${member.email}: ${headline}`);
        db.reminderSent.add(browserMarker);
        simulatedByChannel.browser += 1;
        memberSimulated = true;
      }
      const emailMarker = `${markerBase}|email`;
      if (prefs.email && !inDnd && !db.reminderSent.has(emailMarker)) {
        console.log(`[email dry-run] -> ${member.email}: Plant care reminder — ${headline}`);
        db.reminderSent.add(emailMarker);
        simulatedByChannel.email += 1;
        memberSimulated = true;
      }
      const smsMarker = `${markerBase}|sms`;
      if (prefs.sms && prefs.phone && !inDnd && !db.reminderSent.has(smsMarker)) {
        // Mirrors notifier.sendToUser: unverified numbers are skipped, never sent.
        if (prefs.phoneVerified) {
          console.log(`[sms dry-run] -> ${prefs.phone}: ${headline}`);
          db.reminderSent.add(smsMarker);
          simulatedByChannel.sms += 1;
          memberSimulated = true;
        } else {
          console.log(`[sms skipped — unverified phone] -> ${member.email}`);
        }
      }
      if (memberSimulated) simulated += 1;
    }
    // No provider SDK runs in the local server. Keep the production `sent`
    // metric truthful and expose simulated fan-out separately so a green
    // local test is never mistaken for inbox/device receipt.
    res.json({ sent: 0, simulated, simulatedByChannel });
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
      return res.json({ sent: 0, simulated: 0 });
    }
    let simulated = 0;
    for (const member of db.users.values()) {
      if (!member.memberships.some((m) => m.householdId === user.householdId)) continue;
      const prefs = db.notificationPrefs.get(member.id) ?? defaultPrefs(member.id);
      if (!prefs.email || !prefs.weeklyDigest) continue;
      if (localInDndWindow(prefs, new Date(now))) continue;
      console.log(
        `[email dry-run] -> ${member.email}: Weekly digest — ${atRisk
          .map((p) => `${p.plantName} (${p.taskType}, ${p.daysOverdue}d overdue)`)
          .join(', ')}`
      );
      simulated += 1;
    }
    res.json({ sent: 0, simulated });
  }
);

// Mirrors recapHousehold in services/digest.ts, including household-scoped,
// once-per-year recipient markers (in-memory here, TTL'd DDB rows in prod).
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
      return res.json({ sent: 0, simulated: 0, year });
    }
    let simulated = 0;
    for (const member of db.users.values()) {
      if (!member.memberships.some((m) => m.householdId === user.householdId)) continue;
      const prefs = db.notificationPrefs.get(member.id) ?? defaultPrefs(member.id);
      if (!prefs.email) continue;
      if (localInDndWindow(prefs, new Date())) continue;
      const markerKey = `${member.id}|${user.householdId}|${year}`;
      if (db.recapSent.has(markerKey)) continue;
      console.log(
        `[email dry-run] -> ${member.email}: Your ${year} plant care year in review — ${completions.length} tasks completed`
      );
      db.recapSent.add(markerKey);
      simulated += 1;
    }
    res.json({ sent: 0, simulated, year });
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
const apiCompleteTaskSchema = z
  .object({
    notes: z.string().max(500).optional(),
    expectedNextDue: z.string().datetime().optional(),
  })
  .nullish();
const apiSnoozeTaskSchema = z
  .object({
    days: z.number().int().min(1).max(365).optional(),
    expectedNextDue: z.string().datetime().optional(),
  })
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
    const expectedNextDue = (req as any).validatedBody?.expectedNextDue as string | undefined;
    if (expectedNextDue !== undefined && task.nextDue !== expectedNextDue) {
      return res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
    }
    const now = new Date();
    const nextDue = new Date(now);
    nextDue.setDate(nextDue.getDate() + task.frequency);
    task.lastCompleted = now.toISOString();
    task.nextDue = nextDue.toISOString();
    advanceInheritedAssignment(task);

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
    const keyRecord = (req as any).apiKeyRecord as ApiKey | undefined;
    const task = db.tasks.get(req.params.id);
    if (!task || task.householdId !== user.householdId) {
      return res.status(404).json({ message: 'Task not found' });
    }
    const expectedNextDue = (req as any).validatedBody?.expectedNextDue as string | undefined;
    if (expectedNextDue !== undefined && task.nextDue !== expectedNextDue) {
      return res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
    }
    const days = (req as any).validatedBody?.days ?? task.frequency;
    const current = new Date(task.nextDue);
    const baseMs = Number.isNaN(current.getTime())
      ? Date.now()
      : Math.max(Date.now(), current.getTime());
    const next = new Date(baseMs);
    next.setDate(next.getDate() + days);
    task.nextDue = next.toISOString();
    recordActivity({
      type: 'task.snoozed',
      householdId: user.householdId,
      actorId: user.userId,
      actorName: keyRecord?.label ?? 'API',
      payload: {
        taskId: task.id,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType: task.customType || task.type,
        days,
        reason: null,
        note: null,
      },
    });
    res.json({ ...task, plantName: db.plants.get(task.plantId)?.name ?? task.plantName });
  }
);

// ============ AWAY KIT: SITTER PHOTO-BACK + RETURN RECAP ============
// Mirrors handlers/tasks/sitterPhotos.ts and handlers/households/awayRecap.ts.
// The admission policy (sizes, magic bytes, schema, per-token brake) and the
// recap folding are the SAME modules production uses, so the mock can't
// drift on what is refused or what a recap contains; only storage differs
// (the in-memory mock image store instead of S3/DynamoDB).

function awayKitEnabledFor(householdId: string): boolean {
  const h = db.households.get(householdId);
  return planIncludesAwayKit(PLANS[h?.planId ?? 'seedling']);
}

// GET /sitter/:token/photos
app.get('/sitter/:token/photos', (req, res) => {
  const link = getActiveSitterLink(req.params.token);
  if (!link) {
    return res.status(404).json({ message: 'This sitter link is invalid or has expired.' });
  }
  if (!awayKitEnabledFor(link.householdId)) {
    return res.json({
      enabled: false,
      max: SITTER_PHOTO_MAX_PER_LINK,
      used: null,
      remaining: null,
    });
  }
  const used = link.photoCount ?? 0;
  res.json({
    enabled: true,
    max: SITTER_PHOTO_MAX_PER_LINK,
    used,
    remaining: Math.max(0, SITTER_PHOTO_MAX_PER_LINK - used),
  });
});

// POST /sitter/:token/photos
app.post('/sitter/:token/photos', validateBody(sitterPhotoUploadSchema), (req, res) => {
  const link = getActiveSitterLink(req.params.token);
  if (!link) {
    return res.status(404).json({ message: 'This sitter link is invalid or has expired.' });
  }
  if (!takeSitterPhotoToken(link.token)) {
    return res
      .status(429)
      .json({ message: 'Too many photos at once. Please wait a minute and try again.' });
  }
  if (!awayKitEnabledFor(link.householdId)) {
    return res
      .status(402)
      .json({ message: 'Photo-back is not included in this household’s plan.' });
  }
  const body = (req as any).validatedBody;
  const task = db.tasks.get(body.taskId);
  // Cross-household guard: the task must live in the token's household.
  if (!task || task.householdId !== link.householdId) {
    return res.status(404).json({ message: 'Task not found' });
  }
  const plant = db.plants.get(task.plantId);
  if (!plant || plant.householdId !== link.householdId) {
    return res.status(404).json({ message: 'Task not found' });
  }
  const admitted = admitSitterPhoto(body.image);
  if (!admitted.ok) {
    return res.status(admitted.status).json({ message: admitted.message });
  }
  const used = link.photoCount ?? 0;
  if (used >= SITTER_PHOTO_MAX_PER_LINK) {
    return res
      .status(409)
      .json({ message: `This link has reached its ${SITTER_PHOTO_MAX_PER_LINK}-photo limit.` });
  }
  link.photoCount = used + 1;

  const key = `plants/${link.householdId}/${plant.id}/${uuidv4()}.${SITTER_PHOTO_EXTENSIONS[admitted.contentType]}`;
  db.mockImages.set(key, { body: admitted.bytes, contentType: admitted.contentType });
  const imageUrl = `${imageBaseUrl()}/${key}`;
  const now = new Date().toISOString();
  const photoId = uuidv4();
  const caption = body.caption?.trim() ? body.caption.trim() : null;
  // Timeline-only: a sitter never replaces the plant's primary image.
  db.photos.set(photoId, {
    id: photoId,
    plantId: plant.id,
    householdId: link.householdId,
    imageUrl,
    uploadedBy: sitterActorId(link.id),
    uploadedAt: now,
    caption,
    viaSitter: true,
    sitterLinkId: link.id,
  });
  recordActivity({
    type: 'photo.uploaded',
    householdId: link.householdId,
    actorId: sitterActorId(link.id),
    actorName: 'a plant sitter',
    payload: {
      plantId: plant.id,
      photoId,
      plantName: plant.name,
      imageUrl,
      caption,
      viaSitter: true,
      sitterLinkId: link.id,
    },
  });
  // PII-free acknowledgement — the stored URL (household + plant ids in the
  // key path) is deliberately not returned to the sitter.
  res.status(201).json({
    photoId,
    plantName: plant.name,
    caption,
    uploadedAt: now,
    used: used + 1,
    remaining: Math.max(0, SITTER_PHOTO_MAX_PER_LINK - (used + 1)),
  });
});

// GET /households/:id/away-recap
app.get('/households/:id/away-recap', authMiddleware, requireHousehold, (req, res) => {
  const user = (req as any).user;
  if (user.householdId !== req.params.id) {
    return res.status(403).json({ message: 'Access denied' });
  }
  if (!awayKitEnabledFor(req.params.id)) {
    return res
      .status(402)
      .json({ message: 'The Away Kit is included with Garden and Greenhouse.' });
  }
  const rawLinkId = req.query.linkId;
  const linkId =
    typeof rawLinkId === 'string' && rawLinkId.trim().length > 0 ? rawLinkId.trim() : undefined;
  const now = new Date();
  const links = [...db.sitterLinks.values()].filter((l) => l.householdId === req.params.id);
  const link = pickRecapLink(links, linkId, now);
  if (!link) {
    return res
      .status(404)
      .json({ message: linkId ? 'Sitter link not found' : 'No sitter window has ended yet' });
  }
  const { from, to } = recapWindow(link, now);
  const actor = sitterActorId(link.id);
  const inWindow = (at: string) => at >= from && at <= to;
  // Same two row kinds production's activity partition holds: typed events
  // plus completions folded into the envelope (dedupeCompletions handles
  // the pair a sitter completion produces).
  const events = [
    ...[...db.activity.values()].filter(
      (e) => e.householdId === req.params.id && e.actorId === actor && inWindow(e.occurredAt)
    ),
    ...[...db.completions.values()]
      .filter(
        (c) => c.householdId === req.params.id && c.completedBy === actor && inWindow(c.completedAt)
      )
      .map((c) => ({
        id: c.id,
        type: 'task.completed' as const,
        householdId: c.householdId,
        actorId: c.completedBy,
        actorName: c.completedByName,
        occurredAt: c.completedAt,
        payload: {
          plantId: c.plantId,
          taskId: c.taskId,
          taskType: c.taskType,
          notes: c.notes ?? null,
        },
      })),
  ];
  res.json(buildAwayRecap(link, events, false, now));
});

// ============ MOCK IMAGE OBJECT STORE ============

app.put(
  '/mock-upload/:token',
  express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }),
  (req, res) => {
    const grant = db.mockUploadGrants.get(req.params.token);
    if (!grant) {
      return res.status(404).json({ message: 'Upload URL is invalid or expired' });
    }
    const contentType = (req.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!(contentType in IMAGE_CONTENT_TYPES) || contentType !== grant.contentType) {
      return res
        .status(400)
        .json({ message: 'Upload Content-Type does not match the signed request' });
    }
    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ message: 'Upload body must contain image bytes' });
    }
    const body = Buffer.from(req.body);
    db.mockImages.set(grant.key, { body: Buffer.from(body), contentType });
    res.status(200).end();
  }
);

// Regex routing preserves the slash-delimited S3-style key as one capture.
app.get(/^\/mock-images\/(.+)$/, (req, res) => {
  const rawKey: unknown = req.params[0];
  if (typeof rawKey !== 'string') {
    return res.status(400).json({ message: 'Image key must be a string' });
  }
  const key = rawKey;
  const image = db.mockImages.get(key);
  if (!image) return res.status(404).json({ message: 'Image not found' });
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(image.contentType);
  res.send(image.body);
});

// ============ PLANT TAGS (ADR 0016) ============
// Mirrors handlers/plantTags/handler.ts — the routes live in
// local-server-plant-tags.ts and register here in one call.
registerPlantTagRoutes(app, {
  db,
  authMiddleware,
  requireHousehold,
  requireAdmin,
  validateBody,
  recordActivity,
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
  if (err?.type === 'entity.too.large') {
    return res.status(400).json({ message: 'Image exceeds the 5 MiB limit' });
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }
  // Browsers routinely cancel in-flight JSON requests during navigation.
  // raw-body reports that as request.aborted/ECONNABORTED after the socket is
  // already gone; it is neither a server failure nor something we can answer.
  if (err?.type === 'request.aborted' || err?.code === 'ECONNABORTED' || _req.aborted) {
    return;
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
