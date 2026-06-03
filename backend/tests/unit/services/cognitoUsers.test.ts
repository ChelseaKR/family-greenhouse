import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn(() => ({})),
  AdminUpdateUserAttributesCommand: vi.fn((input) => ({ input, kind: 'Update' })),
  AdminGetUserCommand: vi.fn((input) => ({ input, kind: 'Get' })),
}));

vi.mock('../../../src/utils/cognito.js', () => ({
  cognito: { send: vi.fn() },
  USER_POOL_ID: 'pool',
  CLIENT_ID: 'client',
}));

describe('cognitoUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('setHouseholdClaims writes both attributes for an admin', async () => {
    const { cognito } = await import('../../../src/utils/cognito.js');
    const { setHouseholdClaims } = await import('../../../src/services/cognitoUsers.js');
    vi.mocked(cognito.send).mockResolvedValueOnce({});
    await setHouseholdClaims('user-1', 'hh-1', 'admin');
    const cmd = vi.mocked(cognito.send).mock.calls[0][0] as unknown as {
      input: { UserAttributes: { Name: string; Value: string }[] };
    };
    expect(cmd.input.UserAttributes).toEqual([
      { Name: 'custom:household_id', Value: 'hh-1' },
      { Name: 'custom:household_role', Value: 'admin' },
    ]);
  });

  it('clearHouseholdClaims wipes both attributes', async () => {
    const { cognito } = await import('../../../src/utils/cognito.js');
    const { clearHouseholdClaims } = await import('../../../src/services/cognitoUsers.js');
    vi.mocked(cognito.send).mockResolvedValueOnce({});
    await clearHouseholdClaims('user-1');
    const cmd = vi.mocked(cognito.send).mock.calls[0][0] as unknown as {
      input: { UserAttributes: { Name: string; Value: string }[] };
    };
    expect(cmd.input.UserAttributes.every((a) => a.Value === '')).toBe(true);
  });

  it('getUserName returns the name attribute when present', async () => {
    const { cognito } = await import('../../../src/utils/cognito.js');
    const { getUserName } = await import('../../../src/services/cognitoUsers.js');
    vi.mocked(cognito.send).mockResolvedValueOnce({
      UserAttributes: [
        { Name: 'email', Value: 'a@b.com' },
        { Name: 'name', Value: 'Alice' },
      ],
    });
    expect(await getUserName('u', 'a@b.com')).toBe('Alice');
  });

  it('getUserName falls back to email-localpart on missing attribute', async () => {
    const { cognito } = await import('../../../src/utils/cognito.js');
    const { getUserName } = await import('../../../src/services/cognitoUsers.js');
    vi.mocked(cognito.send).mockResolvedValueOnce({
      UserAttributes: [{ Name: 'email', Value: 'b@x.com' }],
    });
    expect(await getUserName('u', 'b@x.com')).toBe('b');
  });

  it('getUserName falls back when Cognito throws', async () => {
    const { cognito } = await import('../../../src/utils/cognito.js');
    const { getUserName } = await import('../../../src/services/cognitoUsers.js');
    vi.mocked(cognito.send).mockRejectedValueOnce(new Error('boom'));
    expect(await getUserName('u', 'c@x.com')).toBe('c');
  });
});
