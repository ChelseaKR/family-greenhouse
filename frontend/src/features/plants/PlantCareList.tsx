import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { HandRaisedIcon } from '@heroicons/react/24/outline';
import { useAuthStore } from '@/store/authStore';
import { PlantImage } from '@/components/PlantImage';
import { PlantStatusBadge } from './PlantLineageCard';
import type { CareSection, PlantCare } from './plantCare';
import { careStatusText, careWhoText } from './plantCareText';
import { PlantRow, type RowActions } from './PlantRow';

const TONE: Record<string, string> = {
  overdue: 'text-red-700 font-semibold',
  today: 'text-accent-700 font-semibold',
  later: 'text-gray-600',
};

interface PlantCareListProps {
  sections: CareSection[];
  /** Section heading for an id (a care bucket, a space, or `all`). */
  sectionTitle: (id: string) => string;
  roomLabel: (item: PlantCare) => string;
  /** False while the tasks read is loading or failed: rows then say nothing
   *  about care, rather than anything that could pass for a status. */
  showCare: boolean;
  /** The past-plants collection shows each plant's outcome instead. */
  past: boolean;
  myUserId: string | undefined;
  withCuttings: ReadonlySet<string>;
  /** Done, Undo, Snooze and the row menu; absent while care is not known. */
  actions?: RowActions;
}

/**
 * The phone layout of the Plants list (the website under 640px and the iOS
 * app): inset-grouped sections of one-line rows, each saying what the plant
 * needs next, how late it is, and who has it.
 */
export function PlantCareList({
  sections,
  sectionTitle,
  roomLabel,
  showCare,
  past,
  myUserId,
  withCuttings,
  actions,
}: PlantCareListProps) {
  const { t } = useTranslation();
  const myName = useAuthStore((s) => s.user?.name);
  return (
    <div className="space-y-5">
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={`plant-section-${section.id}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-1 pb-1.5">
            <h2 id={`plant-section-${section.id}`} className="text-lg font-semibold text-ink">
              {sectionTitle(section.id)}
            </h2>
            <span className="text-sm text-gray-600">
              {t('plants.list.count', { count: section.items.length })}
            </span>
          </div>
          <ul className="overflow-hidden rounded-2xl border border-primary-100/70 bg-paper divide-y divide-primary-100/60">
            {section.items.map((item) => {
              const marked = Boolean(item.task && actions?.pending.has(item.task.id));
              const status =
                showCare && !past
                  ? marked
                    ? t('plants.list.marked', { task: actions!.taskName(item.task!) })
                    : careStatusText(item, t)
                  : null;
              const who = showCare && !past ? careWhoText(item, myUserId, t) : null;
              const room = roomLabel(item);
              // The Done button shows on due work (PlantRow): the chip shrinks.
              const compact = Boolean(
                actions &&
                showCare &&
                !past &&
                item.task &&
                item.days !== undefined &&
                item.days <= 0
              );
              const tone = marked
                ? 'text-primary-700 font-semibold'
                : item.days === undefined
                  ? TONE.later
                  : item.days < 0
                    ? TONE.overdue
                    : item.days === 0
                      ? TONE.today
                      : TONE.later;
              const aria = [item.plant.name, status, room, who?.aria].filter(Boolean).join(', ');
              return (
                <PlantRow
                  key={item.plant.id}
                  item={item}
                  label={aria}
                  actions={showCare && !past ? actions : undefined}
                >
                  <span className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-parchment ring-1 ring-primary-100/60">
                    <PlantImage plant={item.plant} width={44} height={44} />
                  </span>
                  <span className="min-w-0 flex-1 large-text:min-w-[calc(100%-3.5rem)]">
                    <span className="block truncate font-semibold text-ink large-text:whitespace-normal">
                      {item.plant.name}
                      {withCuttings.has(item.plant.id) && (
                        <span className="ml-1" aria-hidden="true">
                          🌱
                        </span>
                      )}
                    </span>
                    {/* The status is the row's most important words: it never
                        truncates. The space name gives way first (truncated,
                        then gone); at the accessibility sizes both wrap. */}
                    <span
                      className="flex min-w-0 items-baseline text-sm large-text:block"
                      data-testid="row-status-line"
                    >
                      {status && (
                        <span
                          className={clsx(
                            tone,
                            'shrink-0 whitespace-nowrap large-text:whitespace-normal'
                          )}
                          data-testid="row-status"
                        >
                          {status}
                        </span>
                      )}
                      {room && (
                        <span className="min-w-0 truncate text-gray-600 large-text:whitespace-normal">
                          {status && '\u00a0· '}
                          {room}
                        </span>
                      )}
                    </span>
                  </span>
                  {past && <PlantStatusBadge status={item.plant.status ?? 'active'} />}
                  {who && compact && (
                    // Beside the Done button there is room for the status or
                    // the words, not both: an initial (or a raised hand for
                    // "up for grabs"). The row's label carries the words for
                    // VoiceOver; `title` shows them on hover. At the
                    // accessibility sizes the row wraps, so the words return.
                    <span
                      aria-hidden="true"
                      title={who.text}
                      className={clsx(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold large-text:hidden',
                        who.open
                          ? 'bg-accent-50 text-accent-800 ring-1 ring-accent-200'
                          : 'bg-primary-100 text-primary-800'
                      )}
                    >
                      {who.open ? (
                        <HandRaisedIcon className="h-4 w-4" />
                      ) : (
                        initialOf(who.you ? (myName ?? who.text) : who.text)
                      )}
                    </span>
                  )}
                  {who && (
                    <span
                      className={clsx(
                        'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold large-text:ml-14',
                        compact && 'hidden large-text:inline-flex',
                        who.open
                          ? 'bg-accent-50 text-accent-800 ring-1 ring-accent-200'
                          : 'bg-primary-50 text-primary-800'
                      )}
                    >
                      {who.text}
                    </span>
                  )}
                </PlantRow>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The first letter of a name, for the compact who chip. */
function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}
