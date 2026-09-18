/**
 * Leave-household client helpers (#686). Pure, unit-tested. The server decides
 * whether a leave is allowed; the client only recognises its coded refusals
 * and words them in the user's language.
 */
import axios from 'axios';
import type { HouseholdMember } from '@/services/householdService';

export type LeaveRefusalCode = 'LAST_MEMBER' | 'LAST_ADMIN' | 'BILLING_ACK_REQUIRED';

const CODES: ReadonlySet<string> = new Set(['LAST_MEMBER', 'LAST_ADMIN', 'BILLING_ACK_REQUIRED']);

/** The `details.code` of a coded 409 from `POST /households/{id}/leave`, or
 *  null for any other error (which stays an ordinary error message). */
export function readLeaveRefusal(error: unknown): LeaveRefusalCode | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const details = (error.response.data as { details?: unknown } | undefined)?.details;
  if (!details || typeof details !== 'object') return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === 'string' && CODES.has(code) ? (code as LeaveRefusalCode) : null;
}

/**
 * The refusal the roster already predicts, so the card can say so up front
 * instead of offering a button the server will refuse. Mirrors the server's
 * `rosterRefusal` (backend/src/services/leaveHouseholdRules.ts); the server
 * still decides, and its 409 is handled either way.
 */
export function predictedRosterRefusal(
  userId: string | null | undefined,
  members: readonly Pick<HouseholdMember, 'userId' | 'role'>[]
): Exclude<LeaveRefusalCode, 'BILLING_ACK_REQUIRED'> | null {
  if (!userId) return null;
  if (members.length <= 1) return 'LAST_MEMBER';
  const me = members.find((m) => m.userId === userId);
  const otherAdmins = members.filter((m) => m.role === 'admin' && m.userId !== userId);
  if (me?.role === 'admin' && otherAdmins.length === 0) return 'LAST_ADMIN';
  return null;
}
