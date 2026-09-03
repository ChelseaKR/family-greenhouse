/**
 * Client for the members-only Away Kit return recap:
 *   GET /households/{id}/away-recap[?linkId=…]
 *
 * Goes through the authed axios client. The three non-200 outcomes the page
 * must render distinctly are surfaced as-is (axios errors with a status):
 * 402 (plan lacks the Away Kit → locked state), 404 (no ended window yet →
 * "nothing to recap yet"), anything else (→ "couldn't load"). None of them
 * is an empty recap.
 */
import { api } from './api';

export interface AwayRecapLink {
  id: string;
  label: string | null;
  startsAt: string;
  expiresAt: string;
  status: 'active' | 'revoked';
  ended: boolean;
}

export interface AwayRecapTask {
  taskId: string;
  plantId: string;
  plantName: string | null;
  taskType: string;
  occurredAt: string;
  actorName: string;
  notes: string | null;
}

export interface AwayRecapPhoto {
  photoId: string;
  plantId: string;
  plantName: string | null;
  imageUrl: string | null;
  caption: string | null;
  occurredAt: string;
}

export interface AwayRecapNote {
  source: 'photo' | 'task';
  plantId: string;
  plantName: string | null;
  text: string;
  occurredAt: string;
}

export interface AwayRecap {
  link: AwayRecapLink;
  window: { from: string; to: string };
  tasksCompleted: AwayRecapTask[];
  photos: AwayRecapPhoto[];
  notes: AwayRecapNote[];
  counts: { tasks: number; photos: number; notes: number };
  /** True when the server's activity scan hit its cap — the lists are a
   *  prefix of what happened, and the page must say so. */
  truncated: boolean;
  generatedAt: string;
}

export const awayRecapService = {
  async getRecap(householdId: string, linkId?: string): Promise<AwayRecap> {
    const response = await api.get<AwayRecap>(`/households/${householdId}/away-recap`, {
      params: linkId ? { linkId } : undefined,
    });
    return response.data;
  },
};
