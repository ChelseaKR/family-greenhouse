/**
 * Plant Tag (ADR 0016) constants shared by the Lambda service, the Lambda
 * handlers, and the dev server.
 *
 * They live in `models/` rather than in `services/plantTagService.ts` because
 * the dev server (`local-server.ts`, via `local-server-plant-tags.ts`) needs
 * them and must NOT import anything that reaches `utils/dynamodb.ts` — that
 * module calls `requireEnv('TABLE_NAME')` at import time and throws, which
 * takes the whole mock server down before it can serve a request (and is
 * gated by tests/integration/local-server-boot.test.ts). Constants belong to
 * the model layer anyway. Same rule, and the same reason, as `models/kiosk.ts`.
 *
 * The design rule and threat model for plant tags live at the top of
 * `services/plantTagService.ts`.
 */

/** Wrong attempts before a tag locks, and for how long. Five tries against a
 *  10,000-value space is 0.05% per lockout window — a photographed label
 *  cannot be brute-forced in any useful time, and a household member who
 *  forgets the PIN waits fifteen minutes or re-issues the tag. */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCKOUT_MS = 15 * 60 * 1000;

/** A PIN is exactly four digits — small enough to write on the fridge,
 *  which is the whole point. */
export const PIN_RE = /^\d{4}$/;

/** Actor id prefix stamped on completions made through a tag, parallel to
 *  the `sitter:` prefix. The display name the scanner typed is the actor
 *  name; this id ties the row back to the specific label. */
export const TAG_ACTOR_PREFIX = 'tag:';
