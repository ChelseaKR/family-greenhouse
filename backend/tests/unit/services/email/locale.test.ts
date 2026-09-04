import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/services/householdService.js', () => ({
  getHouseholdMembers: vi.fn(),
}));
vi.mock('../../../../src/services/notificationPrefs.js', () => ({
  getPreferences: vi.fn(),
}));

const householdService = await import('../../../../src/services/householdService.js');
const notificationPrefs = await import('../../../../src/services/notificationPrefs.js');
const {
  householdLocaleFrom,
  resolveEmailLocale,
  resolveEmailLocaleForUser,
  resolveHouseholdEmailLocale,
} = await import('../../../../src/services/email/locale.js');

const getMembers = householdService.getHouseholdMembers as unknown as ReturnType<typeof vi.fn>;
const getPrefs = notificationPrefs.getPreferences as unknown as ReturnType<typeof vi.fn>;

const member = (userId: string, joinedAt: string) => ({
  householdId: 'hh',
  userId,
  name: userId,
  email: `${userId}@x.com`,
  role: 'member' as const,
  joinedAt,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveEmailLocale (pure)', () => {
  it('prefers the recipient’s own choice', () => {
    expect(resolveEmailLocale('es', 'en')).toEqual({ locale: 'es', source: 'user' });
  });

  it('falls back to the household when the recipient has not chosen', () => {
    expect(resolveEmailLocale('', 'es')).toEqual({ locale: 'es', source: 'household' });
    expect(resolveEmailLocale(null, 'es')).toEqual({ locale: 'es', source: 'household' });
  });

  it('falls back to English EXPLICITLY, naming the fallback as the source', () => {
    expect(resolveEmailLocale('', null)).toEqual({ locale: 'en', source: 'default' });
  });

  it('ignores a stored locale we do not ship rather than trusting it', () => {
    expect(resolveEmailLocale('fr', null)).toEqual({ locale: 'en', source: 'default' });
  });
});

describe('householdLocaleFrom', () => {
  it('picks the most common member choice', () => {
    expect(householdLocaleFrom(['es', 'es', 'en'])).toBe('es');
  });

  it('breaks a tie on the earliest joiner, so a settled household keeps its language', () => {
    expect(householdLocaleFrom(['es', 'en'])).toBe('es');
    expect(householdLocaleFrom(['en', 'es'])).toBe('en');
  });

  it('returns null — not English — when nobody has chosen', () => {
    expect(householdLocaleFrom(['', null, undefined, 'fr'])).toBeNull();
    expect(householdLocaleFrom([])).toBeNull();
  });
});

describe('resolveHouseholdEmailLocale', () => {
  it('reads members in join order and aggregates their choices', async () => {
    getMembers.mockResolvedValue([member('u2', '2026-02-01'), member('u1', '2026-01-01')]);
    getPrefs.mockImplementation((userId: string) =>
      Promise.resolve({ emailLocale: userId === 'u1' ? 'es' : '' })
    );
    await expect(resolveHouseholdEmailLocale('hh')).resolves.toBe('es');
  });

  it('returns null when the member read fails — never a guessed language', async () => {
    getMembers.mockRejectedValue(new Error('ddb down'));
    await expect(resolveHouseholdEmailLocale('hh')).resolves.toBeNull();
  });

  it('skips a member whose preferences could not be read', async () => {
    getMembers.mockResolvedValue([member('u1', '2026-01-01'), member('u2', '2026-02-01')]);
    getPrefs.mockImplementation((userId: string) =>
      userId === 'u1' ? Promise.reject(new Error('nope')) : Promise.resolve({ emailLocale: 'es' })
    );
    await expect(resolveHouseholdEmailLocale('hh')).resolves.toBe('es');
  });
});

describe('resolveEmailLocaleForUser (the accessor other services call)', () => {
  it('uses the recipient’s stored language without touching the household', async () => {
    getPrefs.mockResolvedValue({ emailLocale: 'es' });
    await expect(resolveEmailLocaleForUser('u1', 'hh')).resolves.toEqual({
      locale: 'es',
      source: 'user',
    });
    expect(getMembers).not.toHaveBeenCalled();
  });

  it('falls back to the household when a householdId is supplied', async () => {
    getPrefs.mockImplementation((userId: string) =>
      Promise.resolve({ emailLocale: userId === 'u1' ? '' : 'es' })
    );
    getMembers.mockResolvedValue([member('u1', '2026-01-01'), member('u2', '2026-02-01')]);
    await expect(resolveEmailLocaleForUser('u1', 'hh')).resolves.toEqual({
      locale: 'es',
      source: 'household',
    });
  });

  it('does not fan out to the household when no householdId is given', async () => {
    getPrefs.mockResolvedValue({ emailLocale: '' });
    await expect(resolveEmailLocaleForUser('u1')).resolves.toEqual({
      locale: 'en',
      source: 'default',
    });
    expect(getMembers).not.toHaveBeenCalled();
  });

  it('marks a failed preference read as unavailable rather than a chosen English', async () => {
    getPrefs.mockRejectedValue(new Error('ddb down'));
    await expect(resolveEmailLocaleForUser('u1', 'hh')).resolves.toEqual({
      locale: 'en',
      source: 'unavailable',
    });
  });
});
