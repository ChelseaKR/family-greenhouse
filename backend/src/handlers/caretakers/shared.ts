/**
 * Token-scoped plumbing shared by every caretaker route, whichever Lambda
 * group dispatches it. Lives in its own module so `public.ts` (tasks group)
 * and `photos.ts` (plants group) don't have to import each other.
 */
import { APIGatewayProxyEvent } from 'aws-lambda';
import createHttpError from 'http-errors';
import * as caretakerService from '../../services/caretakerService.js';
import { logger } from '../../utils/logger.js';

/** One generic message for every token failure (missing / not yet open /
 *  expired / revoked / malformed) so the endpoint is not an existence oracle. */
export const INACTIVE_MESSAGE = 'This caretaker link is invalid or has expired.';

/**
 * How far ahead a caretaker sees. Their engagement can run for months, but a
 * task list stretching that far is noise, so we show the shorter of "the rest
 * of the engagement" and 14 days — and never less than one day, so a seat in
 * its final hours still shows today's work.
 */
export function lookaheadDays(expiresAt: string, now: Date): number {
  const remainingMs = Date.parse(expiresAt) - now.getTime();
  if (!Number.isFinite(remainingMs)) return 1;
  const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  return Math.max(1, Math.min(14, remainingDays));
}

/** Resolve the token or throw the single generic 404. */
export async function requireActiveCaretaker(event: APIGatewayProxyEvent) {
  const token = event.pathParameters?.token ?? '';
  const caretaker = await caretakerService.getActiveCaretaker(token);
  if (!caretaker) {
    throw createHttpError(404, INACTIVE_MESSAGE);
  }
  return caretaker;
}

/**
 * Fold an action into the caretaker's visit record.
 *
 * Returns whether the visit line was written. Callers whose primary effect
 * already succeeded (a completed task, an attached photo) report `false` to
 * the client rather than pretending the record is complete — the proof is the
 * product here, so a silent gap would be the same defect class as rendering a
 * failed read as zero.
 */
export async function recordVisitAction(
  caretaker: { id: string; householdId: string; name: string },
  action: caretakerService.CaretakerAction
): Promise<boolean> {
  try {
    await caretakerService.recordCaretakerAction(caretaker, action);
    return true;
  } catch (err) {
    logger.warn(
      {
        err: (err as Error).message,
        householdId: caretaker.householdId,
        caretakerId: caretaker.id,
        kind: action.kind,
      },
      'caretaker.visit_record_failed'
    );
    return false;
  }
}
