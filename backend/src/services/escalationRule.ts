/**
 * Auto-handoff ("escalation") — the PURE half. No I/O, no AWS imports, so
 * `householdService` can normalise the stored rule on read without an import
 * cycle, and every guardrail the brief names (§4.4 "honest risk") is a
 * function a unit test can pin:
 *
 *   - default OFF, and a stored value below the floor reads as OFF;
 *   - the floor is 5 days overdue (`MIN_ESCALATE_AFTER_DAYS`);
 *   - a lapse is escalated at most once (`escalationCandidates` excludes a
 *     task whose `escalatedForDue` already equals its `nextDue`);
 *   - the original assignee is never nagged, and nobody away or inside DND is
 *     told (`escalationRecipients`).
 *
 * The I/O half (`escalation.ts`) reads the rule, performs the conditional
 * write and sends; the assignment precedence it relies on lives in
 * `assignmentResolver.ts` (ADR 0018).
 */
import type { Task } from '../models/types.js';
import { MAX_ESCALATE_AFTER_DAYS, MIN_ESCALATE_AFTER_DAYS } from '../models/schemas.js';

export { MAX_ESCALATE_AFTER_DAYS, MIN_ESCALATE_AFTER_DAYS };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read-side normalisation of the stored rule. Anything that is not an integer
 * inside [floor, ceiling] reads as OFF (null): a legacy/corrupt/too-low value
 * must never surface as an enabled rule, because "enabled" here means "send
 * a new class of email to the whole household".
 */
export function normalizeEscalateAfterDays(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < MIN_ESCALATE_AFTER_DAYS || raw > MAX_ESCALATE_AFTER_DAYS) return null;
  return raw;
}

/** Whole days a task has been overdue at `now` (0 when not overdue). */
export function daysOverdue(task: Pick<Task, 'nextDue'>, now: Date): number {
  const due = Date.parse(task.nextDue);
  if (Number.isNaN(due)) return 0;
  return Math.max(0, Math.floor((now.getTime() - due) / DAY_MS));
}

/**
 * The tasks the scan should escalate this run. Pure so the once-only rule is
 * testable without DynamoDB: a task whose `escalatedForDue` already pins the
 * current `nextDue` has had its one escalation for this occurrence. (The
 * conditional write in `escalation.ts` re-checks the same predicate so two
 * overlapping hourly runs cannot both fire.)
 */
export function escalationCandidates(
  tasks: readonly Task[],
  escalateAfterDays: number | null,
  now: Date
): Task[] {
  const threshold = normalizeEscalateAfterDays(escalateAfterDays);
  if (threshold === null) return [];
  return tasks.filter(
    (task) => daysOverdue(task, now) >= threshold && task.escalatedForDue !== task.nextDue
  );
}

export interface EscalationRecipientInput {
  userId: string;
}

/**
 * Who gets told. Everyone in the household EXCEPT:
 *   - the member the task was taken from (an escalation is not a nag);
 *   - anyone currently away (their reminders are already rerouted);
 *   - anyone inside their DND window right now (we do not queue: the daily
 *     reminder roll-up carries the now-unassigned task tomorrow anyway).
 */
export function escalationRecipients<M extends EscalationRecipientInput>(
  members: readonly M[],
  escalatedFrom: string | null,
  isAway: (userId: string) => boolean,
  isInDnd: (userId: string) => boolean
): M[] {
  return members.filter(
    (member) => member.userId !== escalatedFrom && !isAway(member.userId) && !isInDnd(member.userId)
  );
}

export type NotificationLocale = 'en' | 'es';

export interface EscalatedTaskSummary {
  plantName: string;
  taskType: string;
  daysOverdue: number;
}

/**
 * The one notification template, in both catalog languages. Kept as data +
 * one function so the wording is reviewable in a single place and the two
 * locales cannot drift in shape. Plain text: the email channel is text-only
 * (`emailNotifier.ts`) and the push/SMS bodies are built from the same pair.
 */
const TEMPLATES: Record<
  NotificationLocale,
  {
    title: (count: number) => string;
    line: (item: EscalatedTaskSummary) => string;
    footer: string;
  }
> = {
  en: {
    title: (count) =>
      count === 1 ? 'A plant task is up for grabs' : `${count} plant tasks are up for grabs`,
    line: (item) =>
      `${capitalize(item.taskType)} for ${item.plantName} has been waiting ${item.daysOverdue} day${
        item.daysOverdue === 1 ? '' : 's'
      }.`,
    footer: 'Nobody has to ask — claim it if you can.',
  },
  es: {
    title: (count) =>
      count === 1
        ? 'Una tarea de plantas está disponible'
        : `${count} tareas de plantas están disponibles`,
    line: (item) =>
      `${capitalize(item.taskType)} de ${item.plantName} lleva ${item.daysOverdue} día${
        item.daysOverdue === 1 ? '' : 's'
      } esperando.`,
    footer: 'Nadie tiene que pedirlo: reclámala si puedes.',
  },
};

export function composeEscalationNotification(
  locale: NotificationLocale,
  items: readonly EscalatedTaskSummary[]
): { title: string; body: string } {
  const template = TEMPLATES[locale] ?? TEMPLATES.en;
  const lines = items.map((item) => template.line(item));
  return {
    title: template.title(items.length),
    body: `${lines.join('\n')}\n\n${template.footer}`,
  };
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
