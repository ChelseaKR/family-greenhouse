/**
 * Client for the AUTHED kiosk-link management endpoints
 * (POST/GET/DELETE /households/{id}/kiosk-link).
 *
 * Separate module from `kioskService` on purpose: that one is the public,
 * no-account wall-display client and deliberately avoids the axios auth
 * interceptors. This one is the household admin's side and needs them.
 */
import { api } from './api';

export interface KioskLinkSummary {
  id: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  status: 'active' | 'revoked';
  /** Seconds between the display's refreshes. */
  pollIntervalSeconds: number;
}

/** The issue response — the ONLY time the token and URL are ever returned. */
export interface IssuedKioskLink extends KioskLinkSummary {
  token: string;
  url: string;
}

/**
 * Poll-interval choices offered in settings, with the monthly cost each one
 * implies. The kiosk is the only feature in the product whose cost scales
 * with wall-clock time rather than usage, so the number is shown next to the
 * choice rather than buried — see `backend/src/services/kioskService.ts`.
 */
export const KIOSK_POLL_CHOICES = [60, 300, 900, 3600] as const;
export type KioskPollChoice = (typeof KIOSK_POLL_CHOICES)[number];

export const kioskLinkService = {
  /** Issue or RE-issue the household's kiosk link. Re-issuing revokes the
   *  previous token server-side, in the same call. */
  async issue(householdId: string, pollIntervalSeconds: number): Promise<IssuedKioskLink> {
    const response = await api.post<IssuedKioskLink>(`/households/${householdId}/kiosk-link`, {
      pollIntervalSeconds,
    });
    return response.data;
  },

  /** The household's live kiosk link, or null when it has none. A failed read
   *  REJECTS — the caller must not render "no display is running" on the
   *  strength of an error (ADR 0010). */
  async get(householdId: string): Promise<KioskLinkSummary | null> {
    const response = await api.get<{ link: KioskLinkSummary | null }>(
      `/households/${householdId}/kiosk-link`
    );
    return response.data.link ?? null;
  },

  async revoke(householdId: string): Promise<void> {
    await api.delete(`/households/${householdId}/kiosk-link`);
  },
};
