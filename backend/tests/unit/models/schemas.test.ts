import { describe, it, expect } from 'vitest';
import {
  signupSchema,
  confirmEmailSchema,
  resetPasswordSchema,
  loginSchema,
  createPlantSchema,
  createTaskSchema,
  createHouseholdSchema,
  refreshTokenSchema,
  joinHouseholdSchema,
  taskFiltersSchema,
} from '../../../src/models/schemas';

describe('Validation Schemas', () => {
  describe('signupSchema', () => {
    it('validates correct input', () => {
      const input = {
        email: 'test@example.com',
        password: 'Password1234',
        name: 'Test User',
      };

      const result = signupSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('rejects invalid email', () => {
      const input = {
        email: 'invalid-email',
        password: 'Password1234',
        name: 'Test User',
      };

      const result = signupSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('rejects short password', () => {
      const input = {
        email: 'test@example.com',
        password: 'short',
        name: 'Test User',
      };

      const result = signupSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('rejects an 11-character password below the Cognito minimum', () => {
      const result = signupSchema.safeParse({
        email: 'test@example.com',
        password: 'Password123',
        name: 'Test User',
      });

      expect(result.success).toBe(false);
    });

    it.each([
      ['an uppercase letter', 'password1234'],
      ['a lowercase letter', 'PASSWORD1234'],
      ['a number', 'PasswordOnly'],
    ])('rejects a password without %s', (_requirement, password) => {
      const result = signupSchema.safeParse({
        email: 'test@example.com',
        password,
        name: 'Test User',
      });

      expect(result.success).toBe(false);
    });

    it('rejects short name', () => {
      const input = {
        email: 'test@example.com',
        password: 'Password1234',
        name: 'T',
      };

      const result = signupSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('trims a valid display name', () => {
      const result = signupSchema.parse({
        email: 'test@example.com',
        password: 'Password1234',
        name: '  Test User  ',
      });

      expect(result.name).toBe('Test User');
    });

    it.each(['   ', 'a'.repeat(101)])('rejects an invalid bounded name: %s', (name) => {
      const result = signupSchema.safeParse({
        email: 'test@example.com',
        password: 'Password1234',
        name,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('confirmEmailSchema', () => {
    it('accepts a six-digit confirmation code', () => {
      expect(
        confirmEmailSchema.safeParse({ email: 'test@example.com', code: '123456' }).success
      ).toBe(true);
    });

    it.each(['12345', '1234567', '12ab56'])('rejects a malformed confirmation code: %s', (code) => {
      expect(confirmEmailSchema.safeParse({ email: 'test@example.com', code }).success).toBe(false);
    });
  });

  describe('resetPasswordSchema', () => {
    it('accepts the Cognito password policy and a numeric reset code', () => {
      expect(
        resetPasswordSchema.safeParse({
          email: 'test@example.com',
          code: '123456',
          newPassword: 'Password1234',
        }).success
      ).toBe(true);
    });

    it.each([
      ['an 11-character password', 'Password123', '123456'],
      ['a password without uppercase', 'password1234', '123456'],
      ['a password without lowercase', 'PASSWORD1234', '123456'],
      ['a password without a number', 'PasswordOnly', '123456'],
      ['a nonnumeric reset code', 'Password1234', '12ab56'],
    ])('rejects %s', (_case, newPassword, code) => {
      expect(
        resetPasswordSchema.safeParse({ email: 'test@example.com', code, newPassword }).success
      ).toBe(false);
    });
  });

  describe('loginSchema', () => {
    it('validates correct input', () => {
      const input = {
        email: 'test@example.com',
        password: 'anypassword',
      };

      const result = loginSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('rejects empty password', () => {
      const input = {
        email: 'test@example.com',
        password: '',
      };

      const result = loginSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('createPlantSchema', () => {
    it('validates correct input with all fields', () => {
      const input = {
        name: 'Monstera',
        species: 'Monstera deliciosa',
        location: 'Living Room',
        notes: 'Needs indirect light',
      };

      const result = createPlantSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('validates with only required fields', () => {
      const input = {
        name: 'Monstera',
      };

      const result = createPlantSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('rejects empty name', () => {
      const input = {
        name: '',
      };

      const result = createPlantSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('rejects name that is too long', () => {
      const input = {
        name: 'a'.repeat(101),
      };

      const result = createPlantSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('createTaskSchema', () => {
    it('validates correct input', () => {
      const input = {
        plantId: '550e8400-e29b-41d4-a716-446655440000',
        type: 'water',
        frequency: 7,
      };

      const result = createTaskSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('validates custom task type', () => {
      const input = {
        plantId: '550e8400-e29b-41d4-a716-446655440000',
        type: 'custom',
        customType: 'Rotate',
        frequency: 14,
      };

      const result = createTaskSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('rejects invalid task type', () => {
      const input = {
        plantId: '550e8400-e29b-41d4-a716-446655440000',
        type: 'invalid',
        frequency: 7,
      };

      const result = createTaskSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('rejects frequency out of range', () => {
      const input = {
        plantId: '550e8400-e29b-41d4-a716-446655440000',
        type: 'water',
        frequency: 0,
      };

      const result = createTaskSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('refreshTokenSchema', () => {
    it('accepts a realistic Cognito refresh token length', () => {
      expect(refreshTokenSchema.safeParse({ refreshToken: 'a'.repeat(2000) }).success).toBe(true);
    });

    it('rejects empty and oversized refresh tokens', () => {
      expect(refreshTokenSchema.safeParse({ refreshToken: '' }).success).toBe(false);
      expect(refreshTokenSchema.safeParse({ refreshToken: 'a'.repeat(4097) }).success).toBe(false);
    });
  });

  describe('joinHouseholdSchema', () => {
    it('accepts the current 32-hex invite code shape', () => {
      expect(joinHouseholdSchema.safeParse({ inviteCode: 'f'.repeat(32) }).success).toBe(true);
    });

    it('rejects oversized invite codes', () => {
      expect(joinHouseholdSchema.safeParse({ inviteCode: 'f'.repeat(65) }).success).toBe(false);
    });
  });

  describe('taskFiltersSchema', () => {
    it('maps overdue="false" to boolean false (z.coerce.boolean would yield true)', () => {
      const result = taskFiltersSchema.parse({ overdue: 'false' });
      expect(result.overdue).toBe(false);
    });

    it('maps overdue="true" to boolean true', () => {
      const result = taskFiltersSchema.parse({ overdue: 'true' });
      expect(result.overdue).toBe(true);
    });

    it('rejects other overdue spellings instead of guessing', () => {
      expect(taskFiltersSchema.safeParse({ overdue: '0' }).success).toBe(false);
      expect(taskFiltersSchema.safeParse({ overdue: 'no' }).success).toBe(false);
    });

    it('leaves overdue undefined when absent', () => {
      expect(taskFiltersSchema.parse({}).overdue).toBeUndefined();
    });
  });

  describe('createHouseholdSchema', () => {
    it('validates correct input', () => {
      const input = {
        name: 'Smith Family',
      };

      const result = createHouseholdSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('rejects empty name', () => {
      const input = {
        name: '',
      };

      const result = createHouseholdSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});
