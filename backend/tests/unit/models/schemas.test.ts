import { describe, it, expect } from 'vitest';
import {
  signupSchema,
  loginSchema,
  createPlantSchema,
  createTaskSchema,
  createHouseholdSchema,
} from '../../../src/models/schemas';

describe('Validation Schemas', () => {
  describe('signupSchema', () => {
    it('validates correct input', () => {
      const input = {
        email: 'test@example.com',
        password: 'Password123',
        name: 'Test User',
      };

      const result = signupSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('rejects invalid email', () => {
      const input = {
        email: 'invalid-email',
        password: 'Password123',
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

    it('rejects short name', () => {
      const input = {
        email: 'test@example.com',
        password: 'Password123',
        name: 'T',
      };

      const result = signupSchema.safeParse(input);
      expect(result.success).toBe(false);
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
