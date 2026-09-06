/**
 * Authenticated client for caretaker seats: the household's side of the
 * feature (mint / list / revoke a seat, and pull the proof-of-visit report).
 *
 * The public, token-scoped side a caretaker actually uses lives in
 * `caretakerVisitService.ts` and deliberately talks to the API with a bare
 * fetch, because a caretaker has no session to attach.
 */
import { api } from './api';

/** A caretaker seat as the household sees it — never the token. */
export interface CaretakerSummary {
  id: string;
  householdId: string;
  createdBy: string;
  createdAt: string;
  /** The name every action this seat takes is attributed to. */
  name: string;
  startsAt: string;
  expiresAt: string;
  status: 'active' | 'revoked';
}

/** The create response — the ONLY time the token + URL are exposed. */
export interface CreatedCaretaker extends CaretakerSummary {
  token: string;
  url: string;
  /** The seat's complete permission surface, straight from the server. */
  permissions: string[];
}

export interface CreateCaretakerData {
  name: string;
  expiresAt: string;
  startsAt?: string;
}

export interface CaretakerVisitTaskEntry {
  taskId: string;
  plantId: string;
  plantName: string;
  taskType: string;
  at: string;
}

export interface CaretakerVisitPhotoEntry {
  photoId: string;
  plantId: string;
  plantName: string;
  imageUrl: string;
  at: string;
}

export interface CaretakerVisitNoteEntry {
  text: string;
  at: string;
}

export interface CaretakerReportVisit {
  id: string;
  caretakerId: string;
  caretakerName: string;
  /** The visit's FIRST action — the arrival time, observed not claimed. */
  startedAt: string;
  lastActionAt: string;
  tasksCompleted: CaretakerVisitTaskEntry[];
  photos: CaretakerVisitPhotoEntry[];
  notes: CaretakerVisitNoteEntry[];
  taskCount: number;
  photoCount: number;
  noteCount: number;
  /** Lines the record could not store. The report shows these, rather than
   *  quietly presenting the shorter list as the whole truth. */
  omitted: { tasks: number; photos: number; notes: number };
  detailTruncated: boolean;
}

export interface CaretakerReport {
  householdId: string;
  from: string;
  to: string;
  generatedAt: string;
  visits: CaretakerReportVisit[];
  totals: {
    visits: number;
    tasksCompleted: number;
    photos: number;
    notes: number;
    caretakers: number;
  };
  byCaretaker: Array<{
    caretakerId: string;
    caretakerName: string;
    visits: number;
    tasksCompleted: number;
    photos: number;
    notes: number;
    firstVisitAt: string;
    lastVisitAt: string;
  }>;
}

export const caretakerSeatsService = {
  async create(householdId: string, data: CreateCaretakerData): Promise<CreatedCaretaker> {
    const response = await api.post<CreatedCaretaker>(
      `/households/${householdId}/caretakers`,
      data
    );
    return response.data;
  },

  async list(householdId: string): Promise<CaretakerSummary[]> {
    const response = await api.get<CaretakerSummary[]>(`/households/${householdId}/caretakers`);
    return response.data;
  },

  async revoke(householdId: string, caretakerId: string): Promise<void> {
    await api.delete(`/households/${householdId}/caretakers/${caretakerId}`);
  },

  /** `from`/`to` are calendar dates (YYYY-MM-DD) or ISO instants. Omitting
   *  both asks the server for its default window (the last 30 days). */
  async getReport(householdId: string, from?: string, to?: string): Promise<CaretakerReport> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    const response = await api.get<CaretakerReport>(
      `/households/${householdId}/caretaker-report${query ? `?${query}` : ''}`
    );
    return response.data;
  },
};
