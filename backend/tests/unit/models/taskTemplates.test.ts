import { describe, it, expect } from 'vitest';
import { TEMPLATES, suggestTemplate } from '../../../src/models/taskTemplates.js';
import { taskTypeEnum } from '../../../src/models/schemas.js';

describe('task template catalog', () => {
  it('every template has a stable, unique, url-safe id', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('every template has a name, description, and at least one task', () => {
    for (const tpl of TEMPLATES) {
      expect(tpl.name.length).toBeGreaterThan(0);
      expect(tpl.description.length).toBeGreaterThan(0);
      expect(tpl.tasks.length).toBeGreaterThan(0);
    }
  });

  it("every task type is a valid member of the schema's taskTypeEnum", () => {
    for (const tpl of TEMPLATES) {
      for (const task of tpl.tasks) {
        const parsed = taskTypeEnum.safeParse(task.type);
        expect(parsed.success, `${tpl.id}: invalid task type "${task.type}"`).toBe(true);
      }
    }
  });

  it('custom tasks always carry a customType within the schema length cap', () => {
    for (const tpl of TEMPLATES) {
      for (const task of tpl.tasks) {
        if (task.type === 'custom') {
          expect(task.customType, `${tpl.id}: custom task missing customType`).toBeTruthy();
          expect(task.customType!.length).toBeLessThanOrEqual(50);
        } else {
          expect(task.customType).toBeUndefined();
        }
      }
    }
  });

  it('every task frequency is a positive integer number of days', () => {
    // NOTE: createTaskSchema caps user-supplied `frequency` at 365, but the
    // template-apply path bypasses that schema and the orchid template
    // intentionally ships repot @ 730 days. We assert a sane positive-int
    // bound here; the 365-cap inconsistency is tracked separately.
    for (const tpl of TEMPLATES) {
      for (const task of tpl.tasks) {
        expect(Number.isInteger(task.frequencyDays), `${tpl.id}: non-integer frequency`).toBe(true);
        expect(task.frequencyDays).toBeGreaterThanOrEqual(1);
        expect(task.frequencyDays).toBeLessThanOrEqual(730);
      }
    }
  });

  it('notes stay within the 500-char schema cap', () => {
    for (const tpl of TEMPLATES) {
      for (const task of tpl.tasks) {
        if (task.notes !== undefined) {
          expect(task.notes.length).toBeLessThanOrEqual(500);
        }
      }
    }
  });

  it('suitsKeywords are non-empty and lowercase (matching is done on lowercased species)', () => {
    for (const tpl of TEMPLATES) {
      expect(tpl.suitsKeywords.length).toBeGreaterThan(0);
      for (const kw of tpl.suitsKeywords) {
        expect(kw).toBe(kw.toLowerCase());
        expect(kw.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe('suggestTemplate', () => {
  it('matches common species to the expected template (case-insensitive substring)', () => {
    expect(suggestTemplate('Monstera deliciosa')?.id).toBe('tropical-houseplant');
    expect(suggestTemplate('Boston Fern')?.id).toBe('fern');
    expect(suggestTemplate('Phalaenopsis Orchid')?.id).toBe('orchid');
    expect(suggestTemplate('SNAKE PLANT')?.id).toBe('succulent-or-cactus');
    expect(suggestTemplate('sweet basil')?.id).toBe('herb');
    expect(suggestTemplate('African violet')?.id).toBe('flowering-houseplant');
  });

  it('prefers the template with the most keyword hits', () => {
    // "tropical" + "aroid" + "philodendron" → 3 hits on tropical-houseplant;
    // no other template scores higher.
    expect(suggestTemplate('tropical aroid philodendron')?.id).toBe('tropical-houseplant');
  });

  it('returns undefined for unknown species (caller offers a manual pick)', () => {
    expect(suggestTemplate('Quercus robur')).toBeUndefined();
  });

  it('returns undefined for null/undefined/empty species', () => {
    expect(suggestTemplate(null)).toBeUndefined();
    expect(suggestTemplate(undefined)).toBeUndefined();
    expect(suggestTemplate('')).toBeUndefined();
  });
});
