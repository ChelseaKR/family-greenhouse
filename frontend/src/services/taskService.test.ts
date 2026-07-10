import { describe, expect, it } from 'vitest';
import { suggestTaskTemplate, TaskTemplate } from './taskService';

const templates: TaskTemplate[] = [
  {
    id: 'tropical',
    name: 'Tropical',
    description: '',
    suitsKeywords: ['monstera', 'philodendron', 'aroid'],
    tasks: [{ type: 'water', frequencyDays: 7 }],
  },
  {
    id: 'succulent',
    name: 'Succulent',
    description: '',
    suitsKeywords: ['succulent', 'aloe'],
    tasks: [{ type: 'water', frequencyDays: 21 }],
  },
];

describe('suggestTaskTemplate', () => {
  it('matches species names case-insensitively', () => {
    expect(suggestTaskTemplate(templates, 'Monstera deliciosa')?.id).toBe('tropical');
    expect(suggestTaskTemplate(templates, 'ALOE VERA')?.id).toBe('succulent');
  });

  it('uses the template with the most matching keywords', () => {
    expect(suggestTaskTemplate(templates, 'monstera aroid')?.id).toBe('tropical');
  });

  it('does not guess for unknown or empty species', () => {
    expect(suggestTaskTemplate(templates, 'Quercus robur')).toBeUndefined();
    expect(suggestTaskTemplate(templates, ' ')).toBeUndefined();
    expect(suggestTaskTemplate(templates, null)).toBeUndefined();
  });
});
