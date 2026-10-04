import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { CheckIcon, HandRaisedIcon } from '@heroicons/react/24/outline';
import type { WhoText } from '@/features/plants/plantCareText';
import type { ChecklistItem } from './checklistModel';

const LONG_PRESS_MS = 500;

interface TaskRowProps {
  item: ChecklistItem;
  /** What the second line says before the room: "Water · 2 days overdue". */
  status: string;
  room: string | null;
  who: WhoText;
  /** Inside its 5-second Undo window. */
  pending: boolean;
  /** Accessible names of the check circle, for Done and for Undo. */
  doneLabel: string;
  undoLabel: string;
  /** Done, or Undo while the task is pending. */
  onCheck: () => void;
  /** The row's actions (Claim, Ask family, Skip, Open plant). */
  onMenu: (from: Element | null) => void;
  menuLabel: string;
  /** Where the check circle is, so focus can be put back on it. */
  registerCheck: (node: HTMLButtonElement | null) => void;
  /** A help request or a climate suggestion: rare, so it keeps its own line. */
  extra?: ReactNode;
}

/**
 * One task on the phone Tasks list, as in Reminders: a check circle on the
 * left (Done, with the shared 5-second Undo), then the plant, what is due,
 * the room, and who has it (You, an initial, or a raised hand when nobody
 * does). Tapping the row opens the plant.
 *
 * The row's other actions open from a long press or a right click, and from
 * the who chip, which is a button, so none of them depends on a gesture.
 */
export function TaskRow({
  item,
  status,
  room,
  who,
  pending,
  doneLabel,
  undoLabel,
  onCheck,
  onMenu,
  menuLabel,
  registerCheck,
  extra,
}: TaskRowProps) {
  const { task, days } = item;
  const rowRef = useRef<HTMLDivElement>(null);
  const press = useRef<{
    id: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const suppressClick = useRef(false);

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  const tone = pending
    ? 'border-primary-700 bg-primary-700 text-white'
    : days < 0
      ? 'border-red-600 text-red-700'
      : days === 0
        ? 'border-accent-600 text-accent-700'
        : 'border-gray-400 text-gray-500';
  const statusTone = pending
    ? 'text-primary-700 font-semibold'
    : days < 0
      ? 'text-red-700 font-semibold'
      : days === 0
        ? 'text-accent-700 font-semibold'
        : 'text-gray-600';
  const label = [item.plantName, status, room, who.aria].filter(Boolean).join(', ');

  return (
    <li className="relative">
      {/* A long press and a right click are shortcuts to the Actions button
          below, which stays reachable by keyboard and VoiceOver. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={rowRef}
        className="flex items-center bg-paper select-none [touch-action:pan-y] [-webkit-touch-callout:none]"
        onPointerDown={(event) => {
          // A new gesture: a click it produces is its own, never one to
          // swallow for an earlier long press.
          suppressClick.current = false;
          if (event.pointerType !== 'touch') return;
          cancelPress();
          const timer = setTimeout(() => {
            press.current = null;
            suppressClick.current = true;
            onMenu(rowRef.current);
          }, LONG_PRESS_MS);
          press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, timer };
        }}
        onPointerMove={(event) => {
          const p = press.current;
          if (!p || p.id !== event.pointerId) return;
          if (Math.abs(event.clientX - p.x) > 8 || Math.abs(event.clientY - p.y) > 8) cancelPress();
        }}
        onPointerUp={() => {
          cancelPress();
          // iOS sends no click after a long press. Forget the swallow once
          // the click that might follow has had its chance, or the next
          // activation (a keyboard Enter, a VoiceOver double-tap, which bring
          // no pointer down) would be eaten.
          if (suppressClick.current)
            setTimeout(() => {
              suppressClick.current = false;
            }, 400);
        }}
        onPointerCancel={cancelPress}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(event.currentTarget);
        }}
      >
        <button
          ref={registerCheck}
          type="button"
          onClick={onCheck}
          aria-label={pending ? undoLabel : doneLabel}
          className="ml-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full large-text:self-start large-text:mt-2"
        >
          <span
            className={clsx(
              'flex h-7 w-7 items-center justify-center rounded-full border-2 transition-colors',
              tone
            )}
            aria-hidden="true"
          >
            {pending && <CheckIcon className="h-4 w-4" />}
          </span>
        </button>
        <Link
          to={`/plants/${task.plantId}`}
          aria-label={label}
          className="flex min-h-16 min-w-0 flex-1 items-center gap-3 py-2 pr-3 pl-1 hover:bg-parchment/60 focus-visible:bg-parchment large-text:flex-wrap"
        >
          <span className="min-w-0 flex-1 large-text:min-w-[calc(100%-1rem)]">
            <span
              className={clsx(
                'block truncate font-semibold large-text:whitespace-normal',
                pending ? 'text-gray-500 line-through' : 'text-ink'
              )}
            >
              {item.plantName}
            </span>
            {/* The status never truncates; the room gives way first. At the
                accessibility sizes both wrap. */}
            <span className="flex min-w-0 items-baseline text-sm large-text:block">
              <span
                className={clsx(
                  statusTone,
                  'shrink-0 whitespace-nowrap large-text:whitespace-normal'
                )}
                data-testid="task-row-status"
              >
                {status}
              </span>
              {room && (
                <span className="min-w-0 truncate text-gray-600 large-text:whitespace-normal">
                  {' · '}
                  {room}
                </span>
              )}
            </span>
          </span>
          {/* At the accessibility sizes the row wraps, and the words of who
              has the task get their own line under the status (the chip
              beside the row stays the actions button). */}
          <span
            aria-hidden="true"
            className={clsx(
              'hidden shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold large-text:inline-flex',
              who.open
                ? 'bg-accent-50 text-accent-800 ring-1 ring-accent-200'
                : 'bg-primary-50 text-primary-800'
            )}
          >
            {who.text}
          </span>
        </Link>
        {/* Who has the task, and the way to the row's actions: You, an
            initial, or a raised hand when nobody has it, as a 44pt button
            (Claim, Ask family, Skip, Open plant). The row's link already
            says who in words for VoiceOver; `title` shows them on hover. */}
        <button
          type="button"
          aria-label={menuLabel}
          title={who.text}
          // Anchored on the row: the sheet points at the task, not the chip.
          onClick={() => onMenu(rowRef.current)}
          className="mr-1.5 flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full large-text:self-start large-text:mt-2"
        >
          <span
            aria-hidden="true"
            data-testid="task-row-who"
            className={clsx(
              'flex h-7 items-center justify-center rounded-full text-xs font-bold',
              who.you && !who.open ? 'px-2' : 'w-7',
              who.open
                ? 'bg-accent-50 text-accent-800 ring-1 ring-accent-200'
                : 'bg-primary-100 text-primary-800'
            )}
          >
            {who.open ? (
              <HandRaisedIcon className="h-4 w-4" />
            ) : who.you ? (
              who.text
            ) : (
              who.text.trim().charAt(0).toUpperCase()
            )}
          </span>
        </button>
      </div>
      {extra && <div className="flex flex-wrap items-center gap-1.5 pb-2 pl-14 pr-3">{extra}</div>}
    </li>
  );
}
