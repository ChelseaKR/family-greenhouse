/**
 * "Ask family to do it" (ADR 0024) — the PURE half. No I/O, no AWS imports,
 * so the mock dev server can share the exact note handling and copy the
 * Lambda uses, and every guardrail is a function a unit test can pin.
 *
 * The feature is the human door onto the state auto-handoff already reaches:
 * a member who cannot do a task asks the household to pick up THIS occurrence,
 * the occurrence goes up for grabs, and everyone who can act on it is told
 * once. Precedence, the once-per-occurrence rule and the recipient guardrails
 * are therefore NOT re-invented here — `escalationRecipients` below is the
 * same function auto-handoff uses (`escalationRule.ts`), re-exported under a
 * neutral name so both doors provably share it rather than drifting apart:
 *
 *   - never the person who asked;
 *   - never anyone inside an active vacation/away window;
 *   - never anyone inside their Do-Not-Disturb window;
 *   - one message per recipient.
 *
 * The I/O half (`askFamily.ts`) does the conditional write, the rate-limit
 * marker and the fan-out.
 */
import type { Task } from '../models/types.js';
import { ASK_HELP_NOTE_MAX_LENGTH } from '../models/schemas.js';
import { escalationRecipients, type NotificationLocale } from './escalationRule.js';

export { ASK_HELP_NOTE_MAX_LENGTH };
export type { NotificationLocale };

/**
 * Who hears about an ask. Deliberately the auto-handoff recipient filter,
 * imported rather than re-implemented: the two doors must exclude the same
 * people or one of them starts waking up someone on holiday.
 */
export { escalationRecipients as askRecipients };

/** One ask per task per member per 24 hours (enforced in DynamoDB). */
export const ASK_HELP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The asker's note, normalised for a channel that may be an SMS segment or a
 * two-line push body: trimmed, internal whitespace collapsed to single
 * spaces, capped, and — importantly — an empty or whitespace-only note is
 * NULL rather than `''`. "No note" is a real state the renderers branch on;
 * an empty string would render as an empty quotation.
 */
export function normalizeHelpNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, ASK_HELP_NOTE_MAX_LENGTH);
}

/** The task fields "is someone still waiting on an answer?" is decided from. */
export type HelpRequestFields = Pick<Task, 'assignedTo' | 'nextDue' | 'helpAskedForDue'>;

/**
 * Whether an ask is still open on this row.
 *
 * Derived, never stored, and pinned to the occurrence exactly as
 * `isEscalatedOccurrence` is. That is what makes a separate "cancel my ask"
 * write unnecessary: claiming the task (`assignedTo` set) or completing it
 * (`nextDue` advances) closes the ask by itself, so the row can never show
 * "Sam asked for help" about work Sam has since taken back or someone has
 * already done.
 */
export function isHelpRequestOpen(task: HelpRequestFields): boolean {
  return task.assignedTo === null && task.helpAskedForDue === task.nextDue;
}

export interface AskNotificationInput {
  askerName: string;
  plantName: string;
  taskType: string;
  note: string | null;
}

/**
 * The one notification template, in both catalog languages — same shape and
 * same reasoning as `composeEscalationNotification`: data plus one function,
 * so the two locales cannot drift and the wording is reviewable in one place.
 * Plain text throughout; the email channel is text-only (`emailNotifier.ts`)
 * and the push/SMS bodies are built from the same pair, so the note is never
 * interpolated into markup.
 */
const TEMPLATES: Record<
  NotificationLocale,
  {
    title: (askerName: string) => string;
    line: (input: AskNotificationInput) => string;
    quote: (input: AskNotificationInput & { note: string }) => string;
    footer: string;
  }
> = {
  en: {
    title: (askerName) => `${askerName} is asking for a hand`,
    line: (input) => `${capitalize(input.taskType)} for ${input.plantName} is up for grabs.`,
    quote: (input) => `${input.askerName} says: “${input.note}”`,
    footer: 'Claim it if you can.',
  },
  es: {
    title: (askerName) => `${askerName} pide ayuda`,
    line: (input) => `${capitalize(input.taskType)} de ${input.plantName} está disponible.`,
    quote: (input) => `${input.askerName} dice: «${input.note}»`,
    footer: 'Reclámala si puedes.',
  },
};

/**
 * Title + body + a one-line `shortBody` for SMS and push, which are truncated
 * to a segment. The short form drops the note rather than the task: a
 * housemate reading one line needs to know WHAT is up for grabs; the reason
 * is context they can open the app for.
 */
export function composeAskNotification(
  locale: NotificationLocale,
  input: AskNotificationInput
): { title: string; body: string; shortBody: string } {
  const template = TEMPLATES[locale] ?? TEMPLATES.en;
  const line = template.line(input);
  const parts = [line];
  if (input.note) parts.push(template.quote({ ...input, note: input.note }));
  parts.push(template.footer);
  return {
    title: template.title(input.askerName),
    body: parts.join('\n\n'),
    shortBody: line,
  };
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
