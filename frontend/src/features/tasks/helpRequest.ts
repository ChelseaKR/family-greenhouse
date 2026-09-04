import type { TaskWithCoverage } from '@/services/taskService';

/**
 * Is a housemate's "Ask family to do it" still open on this row? (ADR 0024)
 *
 * Derived, exactly like the escalation badge's `escalatedForDue === nextDue`
 * test, and mirroring the backend's `askFamilyRule.isHelpRequestOpen`: the ask
 * is pinned to ONE occurrence, so claiming the task (an assignee appears) or
 * completing it (`nextDue` advances) closes the ask by itself. That is why
 * there is no "cancel my ask" — taking the task back IS the cancel, and a
 * stale note can never resurface on a later occurrence.
 */
export function isHelpRequestOpen(task: TaskWithCoverage): boolean {
  return !task.assignedTo && !!task.helpAskedForDue && task.helpAskedForDue === task.nextDue;
}
