import type { TFunction } from 'i18next';
import { formatRelativeDay } from '@/i18n/format';
import { taskTypeLabels } from '@/utils/taskTypeConfig';
import { careWho, type PlantCare } from './plantCare';

/** What the care line of a row says, or `null` when we have nothing to say. */
export function careStatusText(item: PlantCare, t: TFunction): string | null {
  const { task, days } = item;
  if (!task || days === undefined) return item.bucket === 'none' ? t('plants.list.noCare') : null;
  const name = task.customType || t(`tasks.types.${task.type}`, taskTypeLabels[task.type] ?? '');
  if (days < 0) return t('plants.list.dueOverdue', { task: name, count: -days });
  if (days === 0) return t('plants.list.dueToday', { task: name });
  return t('plants.list.dueIn', { task: name, when: formatRelativeDay(task.nextDue) });
}

/** The who chip, and what a screen reader hears for it. */
export function careWhoText(
  item: PlantCare,
  myUserId: string | undefined,
  t: TFunction
): { text: string; aria: string; open: boolean } | null {
  // Only work that is due soon says who has it: "Theo" beside a plant due in
  // three weeks is noise, and the plant page always has the full answer.
  if (!item.task || item.days === undefined || item.days > 1) return null;
  const who = careWho(item.task, myUserId);
  if (who.kind === 'open') {
    const text = t('tasks.upForGrabs');
    return { text, aria: text, open: true };
  }
  const name = who.kind === 'you' ? t('plants.list.you') : (who.name ?? t('plants.list.assigned'));
  // The chip shows a first name ("Theo"), as a household says it; a screen
  // reader still hears the full name.
  const short = who.kind === 'member' && who.name ? who.name.split(/\s+/)[0] : name;
  if (!who.coveringFor) return { text: short, aria: name, open: false };
  return {
    text:
      who.kind === 'you'
        ? t('plants.list.youCovering')
        : t('plants.list.covering', { name: short }),
    aria: t('plants.list.coveringAria', { name, away: who.coveringFor }),
    open: false,
  };
}
