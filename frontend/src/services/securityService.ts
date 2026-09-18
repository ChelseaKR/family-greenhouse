/**
 * Settings → Security (#671): two-step verification with an authenticator app.
 *
 * Cognito holds the secret and checks every code; these calls only move the
 * person through its enrollment. The secret arrives once, from `startTotpSetup`,
 * lives in the enrollment component's state until the step closes, and is
 * never persisted, logged or sent anywhere else — the QR code is drawn in the
 * browser, not by a QR service.
 *
 * These routes sit under `/auth/`, which the api interceptor deliberately
 * never auto-refreshes (a 401 on the sign-in routes means "wrong password").
 * They are authenticated, though, and a person can sit on the page past the
 * one-hour token lifetime, so each call here refreshes once on a 401 and
 * retries — the same thing the interceptor does for every other route.
 */
import axios from 'axios';
import { api, refreshSession } from './api';
import { useAuthStore } from '@/store/authStore';

export interface MfaStatus {
  totp: { enabled: boolean };
}

function accessTokenHeader(): Record<string, string> {
  const accessToken = useAuthStore.getState().accessToken;
  return accessToken ? { 'X-Cognito-Access-Token': accessToken } : {};
}

async function withTokenRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!axios.isAxiosError(error) || error.response?.status !== 401) throw error;
    try {
      await refreshSession();
    } catch {
      throw error;
    }
    return call();
  }
}

export const securityService = {
  async getMfaStatus(): Promise<MfaStatus> {
    return withTokenRetry(async () => (await api.get<MfaStatus>('/auth/mfa')).data);
  },

  /** Re-authenticates with the password; returns the base32 secret. */
  async startTotpSetup(password: string): Promise<{ secretCode: string }> {
    return withTokenRetry(
      async () =>
        (
          await api.post<{ secretCode: string }>(
            '/auth/mfa/totp/setup',
            { password },
            { headers: accessTokenHeader() }
          )
        ).data
    );
  },

  async verifyTotp(code: string): Promise<MfaStatus> {
    return withTokenRetry(
      async () =>
        (
          await api.post<MfaStatus>(
            '/auth/mfa/totp/verify',
            { code },
            { headers: accessTokenHeader() }
          )
        ).data
    );
  },

  /** Re-authenticates with the password AND a current code. */
  async disableTotp(password: string, code: string): Promise<MfaStatus> {
    return withTokenRetry(
      async () => (await api.post<MfaStatus>('/auth/mfa/totp/disable', { password, code })).data
    );
  },
};

/**
 * The `otpauth://` URI every authenticator app understands (Key Uri Format).
 * Issuer in both the label and the parameter, as Google Authenticator
 * recommends, so apps group the entry under "Family Greenhouse".
 */
export function otpauthUri(secret: string, accountEmail: string): string {
  const issuer = 'Family Greenhouse';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** "ABCDEFGH…" → "ABCD EFGH …" so the manual key is readable and copyable. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, '$1 ');
}
