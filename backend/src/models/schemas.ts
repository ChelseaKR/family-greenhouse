import { z } from 'zod';

// Auth schemas
export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2).max(100),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const confirmEmailSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resendCodeSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  newPassword: z.string().min(8),
});

export const refreshTokenSchema = z.object({
  // Cognito refresh tokens are ~1–2 KB; 4096 caps abuse payloads without
  // ever rejecting a legitimate token.
  refreshToken: z.string().min(1).max(4096),
});

// Household schemas
export const createHouseholdSchema = z.object({
  name: z.string().min(1).max(100),
});

export const joinHouseholdSchema = z.object({
  // Invite codes are 32 hex chars today (see householdService.createInvite);
  // 64 leaves headroom while bounding hostile input.
  inviteCode: z.string().min(1).max(64),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(['admin', 'member']),
});

// Household plant-space schemas
export const spaceEnvironmentEnum = z.enum(['inside', 'outside']);

export const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  environment: spaceEnvironmentEnum,
});

export const updateSpaceSchema = createSpaceSchema
  .partial()
  .refine((input) => input.name !== undefined || input.environment !== undefined, {
    message: 'At least one space field is required',
  });

// Plant schemas
const tagsSchema = z.array(z.string().min(1).max(40)).max(10).optional();

export const createPlantSchema = z.object({
  name: z.string().min(1).max(100),
  species: z.string().max(100).optional(),
  tags: tagsSchema,
  location: z.string().max(100).optional(),
  spaceId: z.string().uuid().optional(),
  placementNote: z.string().max(120).optional(),
  notes: z.string().max(1000).optional(),
  perenualSpeciesId: z.number().int().positive().optional(),
  // Propagation: the same-household plant this cutting was taken from.
  // Existence (same household, not self) is validated in the handler.
  parentPlantId: z.string().uuid().optional(),
});

export const plantStatusEnum = z.enum(['active', 'died', 'gave_away', 'archived']);

export const updatePlantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  species: z.string().max(100).optional().nullable(),
  location: z.string().max(100).optional().nullable(),
  spaceId: z.string().uuid().optional().nullable(),
  placementNote: z.string().max(120).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  tags: tagsSchema,
  perenualSpeciesId: z.number().int().positive().nullable().optional(),
  // Lifecycle transition. Setting 'died'/'gave_away' records an outcome;
  // 'archived' neutrally removes a plant from active care without data loss
  // (drops the plant out of active views/cap/reminders, keeps history);
  // 'active' restores it.
  status: plantStatusEnum.optional(),
  // Propagation lineage: set/replace the parent link, or null to detach.
  // Same handler validation as create (same household, not self).
  parentPlantId: z.string().uuid().nullable().optional(),
});

// Task schemas
export const taskTypeEnum = z.enum(['water', 'fertilize', 'prune', 'repot', 'custom']);

export const createTaskSchema = z.object({
  plantId: z.string().uuid(),
  type: taskTypeEnum,
  customType: z.string().max(50).optional(),
  frequency: z.number().int().min(1).max(365),
  assignedTo: z.string().uuid().optional(),
  notes: z.string().max(500).optional(),
  nextDue: z.string().datetime().optional(),
});

export const updateTaskSchema = z.object({
  type: taskTypeEnum.optional(),
  customType: z.string().max(50).optional().nullable(),
  frequency: z.number().int().min(1).max(365).optional(),
  assignedTo: z.string().uuid().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  nextDue: z.string().datetime().optional(),
});

// Bulk import (POST /plants/import). Composed from the single-create shapes
// so the import contract can never drift from createPlant/createTask.
// `plantId` is omitted from the task shape — the server assigns it after the
// plant row is created. `acquiredAt` is accepted for round-trip compatibility
// with exports (CSV `createdAt` column / JSON export) but is not persisted —
// createdAt is always the import time.
export const importTaskSchema = createTaskSchema.omit({ plantId: true });

export const importPlantSchema = createPlantSchema.extend({
  acquiredAt: z.string().max(40).optional(),
  tasks: z.array(importTaskSchema).max(10).optional(),
});

export const importPlantsSchema = z.object({
  plants: z.array(importPlantSchema).min(1).max(100),
});

export const completeTaskSchema = z.object({
  notes: z.string().max(500).optional(),
});

// Why the task was snoozed — feeds the activity feed ("snoozed (rain
// expected)") and lets climate-aware skip suggestions tag their snoozes.
export const snoozeReasonEnum = z.enum(['rain', 'frost', 'heat', 'other']);

export const snoozeTaskSchema = z.object({
  days: z.number().int().min(1).max(365),
  reason: snoozeReasonEnum.optional(),
  note: z.string().max(200).optional(),
});

// Vacation window (care handoff). userId defaults to the caller; setting it
// for someone else requires the admin role (enforced in the handler, which
// knows the caller). coveredBy membership + coveredBy !== userId are also
// handler checks because userId may be defaulted. Date sanity lives here.
const MAX_VACATION_DAYS = 90;
export const setVacationSchema = z
  .object({
    userId: z.string().uuid().optional(),
    coveredBy: z.string().uuid(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
  })
  .superRefine((val, ctx) => {
    const start = Date.parse(val.startDate);
    const end = Date.parse(val.endDate);
    if (end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'endDate must be after startDate',
      });
    } else if (end - start > MAX_VACATION_DAYS * 24 * 60 * 60 * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: `Vacation window cannot exceed ${MAX_VACATION_DAYS} days`,
      });
    }
  });

// Sitter link (no-account, time-boxed plant-sitting access). The creator sets
// an explicit [startsAt, expiresAt] coverage window; the link is rejected
// outside it on every public call. Window is capped so a stray click can't
// mint a year-long public link. `label` is an optional, non-PII friendly name
// shown to the sitter (e.g. "The Smiths' plants") — never a member name/email.
const MAX_SITTER_DAYS = 60;
export const createSitterLinkSchema = z
  .object({
    startsAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    label: z.string().trim().max(60).optional(),
  })
  .superRefine((val, ctx) => {
    const start = val.startsAt ? Date.parse(val.startsAt) : Date.now();
    const end = Date.parse(val.expiresAt);
    if (end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'expiresAt must be in the future (after startsAt)',
      });
    } else if (end - start > MAX_SITTER_DAYS * 24 * 60 * 60 * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: `Sitter link cannot last longer than ${MAX_SITTER_DAYS} days`,
      });
    }
  });

export const applyTemplateSchema = z.object({
  templateId: z.string().min(1).max(80),
});

export const applyTemplateBulkSchema = z.object({
  plantIds: z.array(z.string().uuid()).min(1).max(50),
  templateId: z.string().min(1).max(80),
});

export const confirmImageUploadSchema = z.object({
  imageUrl: z.string().url().max(2000),
});

// Path parameter schemas
export const idParamSchema = z.object({
  id: z.string().uuid(),
});

export const plantIdParamSchema = z.object({
  plantId: z.string().uuid(),
});

export const householdIdParamSchema = z.object({
  householdId: z.string().uuid(),
});

export const userIdParamSchema = z.object({
  userId: z.string().uuid(),
});

export const inviteCodeParamSchema = z.object({
  inviteCode: z.string(),
});

// Query parameter schemas
export const taskFiltersSchema = z.object({
  plantId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().optional(),
  dueWithin: z.coerce.number().int().min(1).optional(),
  // NOT z.coerce.boolean(): that coerces any non-empty string ("false",
  // "0", "no") to true. Query params arrive as strings, so accept only the
  // two literal spellings and map them explicitly.
  overdue: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

// Type exports
export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ConfirmEmailInput = z.infer<typeof confirmEmailSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResendCodeInput = z.infer<typeof resendCodeSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

export type CreateHouseholdInput = z.infer<typeof createHouseholdSchema>;
export type JoinHouseholdInput = z.infer<typeof joinHouseholdSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export type CreatePlantInput = z.infer<typeof createPlantSchema>;
export type UpdatePlantInput = z.infer<typeof updatePlantSchema>;
export type CreateSpaceInput = z.infer<typeof createSpaceSchema>;
export type UpdateSpaceInput = z.infer<typeof updateSpaceSchema>;

export type TaskType = z.infer<typeof taskTypeEnum>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type ImportTaskInput = z.infer<typeof importTaskSchema>;
export type ImportPlantItem = z.infer<typeof importPlantSchema>;
export type ImportPlantsInput = z.infer<typeof importPlantsSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ApplyTemplateInput = z.infer<typeof applyTemplateSchema>;
export type ApplyTemplateBulkInput = z.infer<typeof applyTemplateBulkSchema>;
export type ConfirmImageUploadInput = z.infer<typeof confirmImageUploadSchema>;
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;
export type SnoozeTaskInput = z.infer<typeof snoozeTaskSchema>;
export type SnoozeReason = z.infer<typeof snoozeReasonEnum>;
export type SetVacationInput = z.infer<typeof setVacationSchema>;
export type CreateSitterLinkInput = z.infer<typeof createSitterLinkSchema>;
export type TaskFilters = z.infer<typeof taskFiltersSchema>;
