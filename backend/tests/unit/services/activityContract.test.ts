import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);

function activityTypes(relativePath: string): string[] {
  const source = readFileSync(new URL(relativePath, repositoryRoot), 'utf8');
  const marker = 'export const ACTIVITY_TYPES = [';
  const start = source.indexOf(marker);
  const end = source.indexOf('] as const', start);

  if (start < 0 || end < 0) {
    throw new Error(`Could not find ACTIVITY_TYPES in ${relativePath}`);
  }

  return [...source.slice(start, end).matchAll(/'([a-z]+(?:[._][a-z]+)+)'/gu)].map(
    ([, type]) => type
  );
}

describe('activity contract parity', () => {
  it('keeps the frontend and backend discriminator vocabularies identical', () => {
    const backendTypes = activityTypes('backend/src/services/activity.ts');
    const frontendTypes = activityTypes('frontend/src/services/householdService.ts');

    expect(backendTypes).not.toHaveLength(0);
    expect(new Set(backendTypes).size).toBe(backendTypes.length);
    expect(new Set(frontendTypes).size).toBe(frontendTypes.length);
    expect(frontendTypes).toEqual(backendTypes);
  });
});
