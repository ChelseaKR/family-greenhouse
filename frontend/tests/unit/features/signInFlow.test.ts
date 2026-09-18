import { describe, expect, it, vi } from 'vitest';
import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import {
  normalizeCode,
  readMfaErrorCode,
  submitCode,
  submitCredentials,
  type SignInApi,
} from '@/features/auth/signInFlow';
import type { AuthResponse, MfaChallenge } from '@/services/authService';

const CREDENTIALS = { email: 'a@example.com', password: 'Password1234' };

const AUTH: AuthResponse = {
  user: { id: 'u1', email: 'a@example.com', name: 'A', householdId: null, householdRole: null },
  idToken: 'id',
  accessToken: 'access',
  refreshToken: 'refresh',
};

const challenge = (n: number): MfaChallenge => ({
  challenge: 'SOFTWARE_TOKEN_MFA',
  session: `session-${n}`,
  username: 'u1',
});

function coded(status: number, code: string): AxiosError {
  const response = {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: { message: code, details: { code } },
  } as AxiosResponse;
  return new AxiosError(code, 'ERR_BAD_REQUEST', undefined, undefined, response);
}

function fakeApi(overrides: Partial<SignInApi> = {}) {
  let n = 0;
  return {
    login: vi.fn(async () => challenge(++n)),
    completeMfaSignIn: vi.fn(async () => AUTH),
    ...overrides,
  } satisfies SignInApi;
}

describe('submitCredentials', () => {
  it('a token response signs in', async () => {
    const api = fakeApi({ login: vi.fn(async () => AUTH) });
    expect(await submitCredentials(api, CREDENTIALS)).toEqual({ kind: 'signedIn', auth: AUTH });
  });

  it('a challenge moves to the code step with an unspent session', async () => {
    const api = fakeApi();
    const outcome = await submitCredentials(api, CREDENTIALS);
    expect(outcome).toEqual({
      kind: 'needsCode',
      state: { step: 'code', challenge: challenge(1), spent: false },
    });
  });
});

describe('submitCode', () => {
  const fresh = { step: 'code' as const, challenge: challenge(1), spent: false };

  it('answers the current challenge with the normalized code', async () => {
    const api = fakeApi();
    const outcome = await submitCode(api, CREDENTIALS, fresh, '123 456');
    expect(outcome).toEqual({ kind: 'signedIn', auth: AUTH });
    expect(api.completeMfaSignIn).toHaveBeenCalledWith({
      username: 'u1',
      session: 'session-1',
      code: '123456',
    });
    expect(api.login).not.toHaveBeenCalled();
  });

  it('a wrong code marks the challenge spent and does not sign in', async () => {
    const api = fakeApi({
      completeMfaSignIn: vi.fn(async () => {
        throw coded(400, 'INVALID_CODE');
      }),
    });
    const outcome = await submitCode(api, CREDENTIALS, fresh, '000000');
    expect(outcome).toEqual({
      kind: 'wrongCode',
      state: { step: 'code', challenge: challenge(1), spent: true },
    });
  });

  it('after a wrong code, the next try starts a fresh challenge first', async () => {
    const api = fakeApi({ login: vi.fn(async () => challenge(2)) });
    const outcome = await submitCode(
      api,
      CREDENTIALS,
      { step: 'code', challenge: challenge(1), spent: true },
      '654321'
    );
    expect(outcome.kind).toBe('signedIn');
    expect(api.login).toHaveBeenCalledWith(CREDENTIALS);
    expect(api.completeMfaSignIn).toHaveBeenCalledWith({
      username: 'u1',
      session: 'session-2',
      code: '654321',
    });
  });

  it('an expired session is re-challenged once, transparently, with the same code', async () => {
    const complete = vi
      .fn<SignInApi['completeMfaSignIn']>()
      .mockRejectedValueOnce(coded(401, 'MFA_SESSION_EXPIRED'))
      .mockResolvedValueOnce(AUTH);
    const api = fakeApi({ login: vi.fn(async () => challenge(7)), completeMfaSignIn: complete });
    const outcome = await submitCode(api, CREDENTIALS, fresh, '111111');
    expect(outcome.kind).toBe('signedIn');
    expect(complete).toHaveBeenLastCalledWith({
      username: 'u1',
      session: 'session-7',
      code: '111111',
    });
    expect(api.login).toHaveBeenCalledTimes(1);
  });

  it('a second expiry in a row is surfaced, not looped', async () => {
    const api = fakeApi({
      completeMfaSignIn: vi.fn(async () => {
        throw coded(401, 'MFA_SESSION_EXPIRED');
      }),
    });
    await expect(submitCode(api, CREDENTIALS, fresh, '111111')).rejects.toBeInstanceOf(AxiosError);
    expect(api.login).toHaveBeenCalledTimes(1);
    expect(api.completeMfaSignIn).toHaveBeenCalledTimes(2);
  });

  it('a re-challenge that returns tokens (factor turned off meanwhile) signs in', async () => {
    const api = fakeApi({ login: vi.fn(async () => AUTH) });
    const outcome = await submitCode(
      api,
      CREDENTIALS,
      { step: 'code', challenge: challenge(1), spent: true },
      '123456'
    );
    expect(outcome).toEqual({ kind: 'signedIn', auth: AUTH });
    expect(api.completeMfaSignIn).not.toHaveBeenCalled();
  });

  it('an uncoded failure (network, 500) propagates unchanged', async () => {
    const boom = new Error('network');
    const api = fakeApi({
      completeMfaSignIn: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(submitCode(api, CREDENTIALS, fresh, '123456')).rejects.toBe(boom);
  });
});

describe('readMfaErrorCode / normalizeCode', () => {
  it('reads a known details.code and ignores everything else', () => {
    expect(readMfaErrorCode(coded(400, 'INVALID_CODE'))).toBe('INVALID_CODE');
    expect(readMfaErrorCode(coded(409, 'LAST_ADMIN'))).toBeNull();
    expect(readMfaErrorCode(new Error('INVALID_CODE'))).toBeNull();
  });

  it('strips the spaces authenticator apps show', () => {
    expect(normalizeCode(' 123 456 ')).toBe('123456');
  });
});
