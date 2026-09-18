import { api } from './api';

/**
 * The household audit log (#675): `GET /households/{id}/audit`, admin-only,
 * newest first, one page at a time. The server decides who everyone is — a
 * current member by display name, anyone who has left as a former member,
 * Stripe as Stripe — and an entry never carries a token, an address or a note,
 * so this client only has to word what it is given.
 */
export type AuditParty =
  { type: 'member'; name: string } | { type: 'former_member' } | { type: 'stripe' };

export interface HouseholdAuditEntry {
  id: string;
  /** Known kinds are worded by the card; a newer one falls back to a generic line. */
  kind: string;
  occurredAt: string;
  actor: AuditParty;
  target: AuditParty | null;
  details: Record<string, string | number | boolean | null>;
  /** An earlier write for this household failed: something may be missing before this. */
  gapBefore: boolean;
}

export interface HouseholdAuditPage {
  retentionDays: number;
  items: HouseholdAuditEntry[];
  /** Null exactly when there is nothing older. */
  nextCursor: string | null;
}

export const householdAuditService = {
  async list(householdId: string, cursor: string | null): Promise<HouseholdAuditPage> {
    const response = await api.get<HouseholdAuditPage>(`/households/${householdId}/audit`, {
      params: cursor ? { cursor } : undefined,
    });
    return response.data;
  },
};
