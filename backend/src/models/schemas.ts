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
  refreshToken: z.string(),
});

// Household schemas
export const createHouseholdSchema = z.object({
  name: z.string().min(1).max(100),
});

export const joinHouseholdSchema = z.object({
  inviteCode: z.string(),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(['admin', 'member']),
});

// Plant schemas
const tagsSchema = z.array(z.string().min(1).max(40)).max(10).optional();

export const createPlantSchema = z.object({
  name: z.string().min(1).max(100),
  species: z.string().max(100).optional(),
  tags: tagsSchema,
  location: z.string().max(100).optional(),
  notes: z.string().max(1000).optional(),
  perenualSpeciesId: z.number().int().positive().optional(),
});

export const updatePlantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  species: z.string().max(100).optional().nullable(),
  location: z.string().max(100).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  tags: tagsSchema,
  perenualSpeciesId: z.number().int().positive().nullable().optional(),
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

export const completeTaskSchema = z.object({
  notes: z.string().max(500).optional(),
});

export const snoozeTaskSchema = z.object({
  days: z.number().int().min(1).max(365),
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
  overdue: z.coerce.boolean().optional(),
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

export type TaskType = z.infer<typeof taskTypeEnum>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ApplyTemplateInput = z.infer<typeof applyTemplateSchema>;
export type ApplyTemplateBulkInput = z.infer<typeof applyTemplateBulkSchema>;
export type ConfirmImageUploadInput = z.infer<typeof confirmImageUploadSchema>;
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;
export type SnoozeTaskInput = z.infer<typeof snoozeTaskSchema>;
export type TaskFilters = z.infer<typeof taskFiltersSchema>;
