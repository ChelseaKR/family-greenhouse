/**
 * Kiosk (wall display) constants shared by the Lambda service, the Lambda
 * handlers, and the dev server.
 *
 * They live in `models/` rather than in `services/kioskService.ts` because the
 * dev server (`local-server.ts`) needs them and must NOT import anything that
 * reaches `utils/dynamodb.ts` — that module calls `requireEnv('TABLE_NAME')`
 * at import time and throws, which takes the whole mock server down before it
 * can serve a request. Constants belong to the model layer anyway.
 *
 * The design rule and threat model for kiosk links live at the top of
 * `services/kioskService.ts`.
 */

/**
 * How often the wall display re-reads the task list, in seconds.
 *
 * COST SCALING — read this before changing the default.
 *
 * Every other paid feature in the ideation brief costs money in proportion to
 * USAGE: a household that never opens the app never spends anything. The
 * kiosk is the one exception. A wall display polls whether or not anybody is
 * in the room, so its cost scales with WALL-CLOCK TIME — a screen left on in
 * an empty kitchen costs exactly as much as one somebody is using.
 *
 * The arithmetic, per household per month, at API Gateway's $1.00 per million
 * requests plus the DynamoDB eventually-consistent reads behind each poll:
 *
 *   every 300s (default) → 30d × 86400 / 300 ≈   8,640 requests → ~$0.01/mo
 *   every  60s (minimum) → 30d × 86400 /  60 ≈  43,200 requests → ~$0.05/mo
 *   every 3600s (max)    → 30d × 86400 / 3600 ≈    720 requests → ~$0.001/mo
 *
 * Five minutes is the default because plant care is not a real-time activity:
 * the worst case is that someone in another room completes a task and the
 * wall screen keeps showing it for up to five more minutes. A 60-second poll
 * multiplies the bill by five to remove four minutes of staleness from a
 * watering schedule measured in days. Faster is offered, but it is opt-in and
 * the settings card states the cost so the choice is made with the number in
 * view.
 */
export const KIOSK_DEFAULT_POLL_SECONDS = 300;

/** Floor on the configurable poll interval (see the cost note above: 60s is
 *  ~5× the default's monthly request cost). */
export const KIOSK_MIN_POLL_SECONDS = 60;

/** Ceiling on the configurable poll interval — one hour. Past this the
 *  display is stale enough to be misleading rather than merely lagging. */
export const KIOSK_MAX_POLL_SECONDS = 3600;

/**
 * How far ahead the kiosk looks, in days. The wall display answers "what
 * needs doing today", so it shows overdue work plus the next 24 hours —
 * not the sitter view's 7-day trip horizon. Named rather than inlined
 * because the sitter/kiosk difference is a product decision, not a constant.
 */
export const KIOSK_LOOKAHEAD_DAYS = 1;

/** Clamp a requested poll interval into the supported band. */
export function clampPollInterval(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return KIOSK_DEFAULT_POLL_SECONDS;
  return Math.min(KIOSK_MAX_POLL_SECONDS, Math.max(KIOSK_MIN_POLL_SECONDS, Math.round(seconds)));
}
