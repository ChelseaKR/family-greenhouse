/**
 * Auto-handoff ("the app nags, so nobody has to") — the I/O half.
 *
 * Brief §4.4: a task nobody has done by N days overdue quietly goes up for
 * grabs and the rest of the household is pinged, so the person who always
 * notices never has to be the one who asks. Gated to plans with the household
 * toolkit (`models/plans.ts`); rotation, by contrast, is free (ADR 0018).
 *
 * Cost model, stated for the PR: the scan piggybacks on the hourly reminder
 * fan-out's existing due-window query. When no task is ≥5 days overdue (the
 * common hour) this module performs ZERO reads. When one is, it costs one
 * GetItem for the rule + plan, one conditional UpdateItem per escalated task,
 * one activity PutItem, and one SES send (~$0.0001) per recipient.
 *
 * Volume guardrails (the brief's "honest risk"), each enforced here or in the
 * pure companion `escalationRule.ts`:
 *   - OFF by default; floor of 5 days enforced on write AND read;
 *   - at most once per occurrence — a conditional write on `escalatedForDue`
 *     so overlapping runs cannot both fire, and we notify only AFTER the
 *     write succeeds (at-most-once, never at-least-once);
 *   - one roll-up per recipient per run, not one email per task;
 *   - never the previous holder, never anyone away, never anyone inside DND.
 */
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import type { Task } from '../models/types.js';
import { getPlan, hasHouseholdToolkit, type PlanId } from '../models/plans.js';
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import * as notificationPrefs from './notificationPrefs.js';
import * as notifier from './notifier.js';
import { recordActivity } from './activity.js';
import { isAwayAt } from './assignmentResolver.js';
import {
  MAX_ESCALATE_AFTER_DAYS,
  MIN_ESCALATE_AFTER_DAYS,
  composeEscalationNotification,
  daysOverdue,
  escalationCandidates,
  escalationRecipients,
  normalizeEscalateAfterDays,
  type EscalatedTaskSummary,
  type NotificationLocale,
} from './escalationRule.js';

/**
 * Raised when a write would set the rule below the floor / above the ceiling.
 * Handlers map it to 400. Call sites check `err.name` (not instanceof) so
 * test automocks stay compatible — the repo's PlanLimitError convention.
 */
export class EscalationRuleRangeError extends Error {
  constructor() {
    super(
      `escalateAfterDays must be null (off) or an integer between ${MIN_ESCALATE_AFTER_DAYS} and ${MAX_ESCALATE_AFTER_DAYS}`
    );
    this.name = 'EscalationRuleRangeError';
  }
}

export interface EscalationRule {
  escalateAfterDays: number | null;
  planId: PlanId;
}

/** One GetItem returns both the rule and the plan that gates it. */
export async function getEscalationRule(householdId: string): Promise<EscalationRule> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
      ProjectionExpression: 'escalateAfterDays, planId',
    })
  );
  const item = result.Item ?? {};
  return {
    escalateAfterDays: normalizeEscalateAfterDays(item.escalateAfterDays),
    planId: getPlan(item.planId as string | undefined).id,
  };
}

/**
 * Set (or clear with null) the household's rule. The floor is re-checked
 * here so that no handler — present or future — can persist a value the
 * scan would then act on hourly. Returns null when the household row does
 * not exist.
 */
export async function setEscalationRule(
  householdId: string,
  escalateAfterDays: number | null
): Promise<number | null> {
  if (escalateAfterDays !== null && normalizeEscalateAfterDays(escalateAfterDays) === null) {
    throw new EscalationRuleRangeError();
  }
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
        UpdateExpression:
          escalateAfterDays === null ? 'REMOVE escalateAfterDays' : 'SET escalateAfterDays = :days',
        ExpressionAttributeValues:
          escalateAfterDays === null ? undefined : { ':days': escalateAfterDays },
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw Object.assign(new Error('Household not found'), { name: 'HouseholdNotFoundError' });
    }
    throw err;
  }
  return escalateAfterDays;
}

/**
 * Atomically put ONE occurrence up for grabs. The condition pins both the
 * occurrence (`nextDue` unchanged since we read it — a completion in the
 * meantime means there is nothing to escalate) and once-only (`escalatedForDue`
 * not already this occurrence). Returns false when the condition failed,
 * i.e. another run or a completion got there first.
 */
async function markEscalated(task: Task, now: Date): Promise<boolean> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${task.householdId}`, SK: `TASK#${task.id}` },
        UpdateExpression:
          'SET #escalatedAt = :now, #escalatedForDue = :due, #escalatedFrom = :from, ' +
          '#assignedTo = :null, #assignedToName = :null, #assignmentSource = :null ' +
          'REMOVE GSI2PK, GSI2SK',
        ConditionExpression:
          'attribute_exists(PK) AND #nextDue = :due AND ' +
          '(attribute_not_exists(#escalatedForDue) OR #escalatedForDue <> :due)',
        ExpressionAttributeNames: {
          '#escalatedAt': 'escalatedAt',
          '#escalatedForDue': 'escalatedForDue',
          '#escalatedFrom': 'escalatedFrom',
          '#assignedTo': 'assignedTo',
          '#assignedToName': 'assignedToName',
          '#assignmentSource': 'assignmentSource',
          '#nextDue': 'nextDue',
        },
        ExpressionAttributeValues: {
          ':now': now.toISOString(),
          ':due': task.nextDue,
          ':from': task.assignedTo ?? null,
          ':null': null,
        },
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Per-recipient language for the one template. The backend holds no per-user
 * locale today (every outbound mail in the repo is English, and non-English
 * UI locales are still feature-flagged in `frontend/src/i18n`), so this
 * resolves to English until a preference is threaded through notification
 * prefs. The Spanish template exists and is tested so that step is a one-line
 * change here, not a copywriting task.
 */
function recipientLocale(_prefs: notificationPrefs.NotificationPreferences): NotificationLocale {
  return 'en';
}

function frontendUrl(path: string): string {
  const base = process.env.FRONTEND_URL?.trim() || 'http://localhost:3000';
  return new URL(path, base).toString();
}

export interface EscalationRunSummary {
  /** Occurrences actually flipped to up-for-grabs this run. */
  escalated: number;
  /** Recipients that received at least one delivered channel. */
  notified: number;
}

/**
 * Escalate whatever qualifies among `dueTasks` (the reminder scan's already-
 * fetched due-window rows, filtered to active plants). Best-effort per
 * household: the caller wraps this so a failure never blocks reminders.
 */
export async function runEscalations(
  householdId: string,
  dueTasks: readonly Task[],
  now: Date = new Date()
): Promise<EscalationRunSummary> {
  const summary: EscalationRunSummary = { escalated: 0, notified: 0 };

  // Zero-read fast path: nothing is even at the floor, so the rule cannot
  // matter. This is the common hour for every household.
  if (escalationCandidates(dueTasks, MIN_ESCALATE_AFTER_DAYS, now).length === 0) return summary;

  const rule = await getEscalationRule(householdId);
  if (rule.escalateAfterDays === null) return summary;
  if (!hasHouseholdToolkit(getPlan(rule.planId))) {
    // A downgraded household keeps its stored rule but the scan stops acting
    // on it — no data cleanup required to honour the gate.
    logger.info({ householdId, planId: rule.planId }, 'escalation.skipped_plan_gate');
    return summary;
  }

  const candidates = escalationCandidates(dueTasks, rule.escalateAfterDays, now);
  if (candidates.length === 0) return summary;

  const [members, vacations] = await Promise.all([
    householdService.getHouseholdMembers(householdId),
    taskService.listVacationWindows(householdId, now),
  ]);

  // Per-recipient roll-up: one notification per member per run.
  const perRecipient = new Map<string, EscalatedTaskSummary[]>();
  const prefsByUser = new Map<string, notificationPrefs.NotificationPreferences>();
  for (const member of members) {
    prefsByUser.set(member.userId, await notificationPrefs.getPreferences(member.userId));
  }
  const isAway = (userId: string) => isAwayAt(vacations, userId, now);
  const isInDnd = (userId: string) => {
    const prefs = prefsByUser.get(userId);
    return prefs ? notificationPrefs.isInDndWindow(prefs, now) : false;
  };

  for (const task of candidates) {
    const escalatedFrom = task.assignedTo;
    if (!(await markEscalated(task, now))) continue; // once-only, decided by DynamoDB
    summary.escalated += 1;

    const recipients = escalationRecipients(members, escalatedFrom, isAway, isInDnd);
    const days = daysOverdue(task, now);
    const item: EscalatedTaskSummary = {
      plantName: task.plantName,
      taskType: task.customType || task.type,
      daysOverdue: days,
    };
    for (const recipient of recipients) {
      const list = perRecipient.get(recipient.userId) ?? [];
      list.push(item);
      perRecipient.set(recipient.userId, list);
    }

    await recordActivity({
      type: 'task.escalated',
      householdId,
      actorId: 'system',
      actorName: '',
      payload: {
        taskId: task.id,
        plantId: task.plantId,
        plantName: task.plantName,
        taskType: item.taskType,
        previousAssigneeId: escalatedFrom,
        previousAssigneeName: task.assignedToName ?? null,
        daysOverdue: days,
        notified: recipients.length,
      },
    });
  }

  for (const member of members) {
    const items = perRecipient.get(member.userId);
    if (!items || items.length === 0) continue;
    const prefs = prefsByUser.get(member.userId);
    const message = composeEscalationNotification(prefs ? recipientLocale(prefs) : 'en', items);
    try {
      const result = await notifier.sendToUser(
        { userId: member.userId, email: member.email },
        {
          title: message.title,
          body: message.body,
          tag: `escalation-${householdId}-${now.toISOString()}`,
          url: frontendUrl('/tasks?filter=due'),
        },
        { now, preferences: prefs }
      );
      if (result.delivered) summary.notified += 1;
    } catch (err) {
      // At-most-once by design: the occurrence is already marked, so a failed
      // send is logged, not retried into a second nag next hour.
      logger.warn(
        { err: (err as Error).message, householdId, userId: member.userId },
        'escalation.send_failed'
      );
    }
  }

  if (summary.escalated > 0) {
    logger.info({ householdId, ...summary }, 'escalation.run');
  }
  return summary;
}
