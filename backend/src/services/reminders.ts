/**
 * Reminder fan-out. Two entrypoints share one per-household routine:
 *   - `remindHousehold` — used by the admin "send reminders now" HTTP route
 *     (`handlers/notifications/handler.ts`).
 *   - `remindAllHouseholds` — used by the hourly EventBridge scan
 *     (`handlers/reminders/handler.ts`).
 *
 * For each member we roll their due/overdue tasks into a single notification so
 * a busy household doesn't get one ping per plant. Delivery goes through
 * `notifier.sendToUser`, which respects per-user channel prefs + the DND window
 * and degrades to a structured log line when a channel isn't configured.
 */
import * as householdService from './householdService.js';
import * as taskService from './taskService.js';
import * as notifier from './notifier.js';

const DUE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Notify each member of one household about tasks assigned to them that are
 * due within the next 24h (or already overdue). Returns how many members were
 * sent a reminder.
 */
export async function remindHousehold(
  householdId: string,
  now: Date = new Date()
): Promise<number> {
  const members = await householdService.getHouseholdMembers(householdId);
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() + DUE_WINDOW_MS).toISOString();

  let sent = 0;
  for (const member of members) {
    const tasks = await taskService.getTasks(householdId, { assignedTo: member.userId });
    const due = tasks.filter((t) => t.nextDue <= cutoff);
    if (due.length === 0) continue;

    const overdue = due.filter((t) => t.nextDue < nowIso).length;
    const body = overdue
      ? `${overdue} overdue, ${due.length - overdue} due soon`
      : `${due.length} task${due.length === 1 ? '' : 's'} due in the next 24h`;

    await notifier.sendToUser(
      { userId: member.userId, email: member.email },
      { title: 'Plant care reminder', body, tag: 'reminder' }
    );
    sent += 1;
  }
  return sent;
}

/**
 * Hourly scan across every household. Best-effort per household — one
 * household's failure must not abort the rest of the run.
 */
export async function remindAllHouseholds(
  now: Date = new Date()
): Promise<{ households: number; sent: number }> {
  const ids = await householdService.listAllHouseholdIds();
  let sent = 0;
  for (const id of ids) {
    try {
      sent += await remindHousehold(id, now);
    } catch {
      // Swallow — a single household's failure shouldn't stop the scan.
      // notifier/service internals already log the underlying error.
    }
  }
  return { households: ids.length, sent };
}
