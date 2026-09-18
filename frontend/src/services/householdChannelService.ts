/**
 * Client for the household chat-channel routes (#674):
 * GET/PUT/DELETE /households/{id}/channel and POST …/channel/test.
 *
 * The webhook address travels one way — out, on PUT — and nothing here ever
 * receives it back. `maskedUrl` (host + last four characters) is all a
 * settings page can show.
 */
import axios from 'axios';
import { api } from './api';

export type ChannelPlatform = 'discord' | 'slack' | 'matrix';
export const CHANNEL_PLATFORMS: readonly ChannelPlatform[] = ['discord', 'slack', 'matrix'];

export type ChannelLocale = 'en' | 'es';

export type ChannelDisabledReason =
  'repeated_client_errors' | 'redirect' | 'blocked_address' | 'repeated_failures';

export type DeliveryFailureKind =
  'client' | 'redirect' | 'rate_limited' | 'server' | 'network' | 'blocked' | 'unsealable';

export interface HouseholdChannelSummary {
  platform: ChannelPlatform;
  maskedUrl: string;
  events: { dailyDue: boolean; upForGrabs: boolean };
  quietStart: string;
  quietEnd: string;
  timezone: string;
  locale: ChannelLocale;
  status: 'active' | 'disabled';
  disabledReason: ChannelDisabledReason | null;
  lastFailure: { at: string; kind: DeliveryFailureKind; httpStatus: number | null } | null;
  lastDeliveredAt: string | null;
  nextAttemptAt: string | null;
  connectedAt: string;
}

export interface HouseholdChannelState {
  /** False when this environment cannot store a webhook at all. */
  available: boolean;
  channel: HouseholdChannelSummary | null;
}

export interface SaveHouseholdChannelInput {
  platform: ChannelPlatform;
  /** Omit to keep the stored address. */
  url?: string;
  events: { dailyDue: boolean; upForGrabs: boolean };
  quietStart: string;
  quietEnd: string;
  timezone: string;
  locale: ChannelLocale;
}

export type TestPostResult =
  | { outcome: 'delivered'; channel: HouseholdChannelSummary }
  | {
      outcome: 'failed';
      failure: { kind: DeliveryFailureKind; httpStatus: number | null };
      channel: HouseholdChannelSummary;
    };

/** The server's `details.code` on a refused address, when there is one. */
export function channelErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const data: unknown = error.response?.data;
  if (!data || typeof data !== 'object') return null;
  const details = (data as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export const householdChannelService = {
  /** A failed read REJECTS — the card must not say "not connected" on the
   *  strength of an error (ADR 0010). */
  async get(householdId: string): Promise<HouseholdChannelState> {
    const response = await api.get<HouseholdChannelState>(`/households/${householdId}/channel`);
    return response.data;
  },

  async save(
    householdId: string,
    input: SaveHouseholdChannelInput
  ): Promise<HouseholdChannelState> {
    const response = await api.put<HouseholdChannelState>(
      `/households/${householdId}/channel`,
      input
    );
    return response.data;
  },

  async test(householdId: string): Promise<TestPostResult> {
    const response = await api.post<TestPostResult>(`/households/${householdId}/channel/test`);
    return response.data;
  },

  async remove(householdId: string): Promise<void> {
    await api.delete(`/households/${householdId}/channel`);
  },
};
