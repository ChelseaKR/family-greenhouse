import { describe, expect, it } from 'vitest';
import {
  CARE_RULE_MAX_LENGTH,
  createPlantSchema,
  updatePlantSchema,
} from '../../../src/models/schemas';

/**
 * House rule (`careRule`) validation limits. The rule is one short line
 * shown at completion time, so the cap is deliberately far below `notes`
 * (1000) and the value is trimmed BEFORE the cap is measured — padding must
 * neither slip past the limit nor be stored.
 */
describe('careRule (house rule) validation', () => {
  it('caps at 140 characters', () => {
    expect(CARE_RULE_MAX_LENGTH).toBe(140);
  });

  it('accepts a rule exactly at the cap on create and update', () => {
    const rule = 'x'.repeat(CARE_RULE_MAX_LENGTH);
    expect(createPlantSchema.safeParse({ name: 'Fern', careRule: rule }).success).toBe(true);
    expect(updatePlantSchema.safeParse({ careRule: rule }).success).toBe(true);
  });

  it('rejects a rule one character over the cap on create and update', () => {
    const rule = 'x'.repeat(CARE_RULE_MAX_LENGTH + 1);
    const created = createPlantSchema.safeParse({ name: 'Fern', careRule: rule });
    expect(created.success).toBe(false);
    if (!created.success) expect(created.error.issues[0].path).toEqual(['careRule']);
    expect(updatePlantSchema.safeParse({ careRule: rule }).success).toBe(false);
  });

  it('trims surrounding whitespace before measuring the cap', () => {
    const padded = `   ${'x'.repeat(CARE_RULE_MAX_LENGTH)}   `;
    const parsed = createPlantSchema.safeParse({ name: 'Fern', careRule: padded });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.careRule).toBe('x'.repeat(CARE_RULE_MAX_LENGTH));
  });

  it('stores the trimmed value ("  bottom-water only  " → "bottom-water only")', () => {
    const parsed = updatePlantSchema.safeParse({ careRule: '  bottom-water only  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.careRule).toBe('bottom-water only');
  });

  it('is optional on create and nullable on update (null clears the rule)', () => {
    const created = createPlantSchema.safeParse({ name: 'Fern' });
    expect(created.success).toBe(true);
    if (created.success) expect(created.data.careRule).toBeUndefined();

    const cleared = updatePlantSchema.safeParse({ careRule: null });
    expect(cleared.success).toBe(true);
    if (cleared.success) expect(cleared.data.careRule).toBeNull();

    // There is nothing to clear on create, so null is not a create value.
    expect(createPlantSchema.safeParse({ name: 'Fern', careRule: null }).success).toBe(false);
  });

  it('rejects non-string rules', () => {
    expect(updatePlantSchema.safeParse({ careRule: 42 }).success).toBe(false);
    expect(updatePlantSchema.safeParse({ careRule: ['bottom-water'] }).success).toBe(false);
    expect(updatePlantSchema.safeParse({ careRule: { text: 'x' } }).success).toBe(false);
  });
});
