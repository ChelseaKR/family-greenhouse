import type { ActivityEvent, ActivityType } from '@/services/householdService';

export type ActivityFilter = 'all' | 'tasks' | 'plants' | 'people';

type ActivityCategory = Exclude<ActivityFilter, 'all'>;

// Keep this map explicit instead of relying on discriminator prefixes. The
// import event is intentionally named `plants.imported`, and a prefix check
// silently dropped it from the Plants filter. `Record` also makes a new event
// fail type-checking until its filter category is chosen deliberately.
const ACTIVITY_CATEGORIES: Record<ActivityType, ActivityCategory> = {
  'task.completed': 'tasks',
  'task.snoozed': 'tasks',
  'task.claimed': 'tasks',
  'task.unclaimed': 'tasks',
  'plant.created': 'plants',
  'plants.imported': 'plants',
  'plant.deleted': 'plants',
  'plant.died': 'plants',
  'plant.gave_away': 'plants',
  'plant.archived': 'plants',
  'plant.restored': 'plants',
  'plant.propagated': 'plants',
  'plant.shared_accepted': 'plants',
  'plant.health_checked': 'plants',
  'photo.uploaded': 'plants',
  'member.joined': 'people',
  'member.left': 'people',
  'sitter_link.created': 'people',
  'sitter_link.revoked': 'people',
  'task.schedule_matched': 'tasks',
};

export function filterActivity(events: ActivityEvent[], filter: ActivityFilter): ActivityEvent[] {
  if (filter === 'all') return events;
  return events.filter((event) => ACTIVITY_CATEGORIES[event.type] === filter);
}
