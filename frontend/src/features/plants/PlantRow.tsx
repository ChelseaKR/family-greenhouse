import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  ArrowUturnLeftIcon,
  CheckIcon,
  ClockIcon,
  EllipsisHorizontalIcon,
} from '@heroicons/react/24/outline';
import type { PlantCare } from './plantCare';

/** What a row can do besides opening the plant (usePlantRowActions). */
export interface RowActions {
  pending: ReadonlySet<string>;
  done: (item: PlantCare) => void;
  undo: (taskId: string) => void;
  snooze: (item: PlantCare, from?: Element | null) => void;
  openMenu: (item: PlantCare, from?: Element | null) => void;
  taskName: (task: NonNullable<PlantCare['task']>) => string;
}

const OPEN = 88; // how far a swipe stays open: one 88pt action
const LONG_PRESS_MS = 500;

/** A water drop for watering; a check for every other kind of task. */
function DoneIcon({ water, className }: { water: boolean; className: string }) {
  return water ? (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2.5c-3.6 4.7-6.5 8.3-6.5 11.9a6.5 6.5 0 0 0 13 0C18.5 10.8 15.6 7.2 12 2.5Z" />
    </svg>
  ) : (
    <CheckIcon className={className} aria-hidden="true" />
  );
}

interface PlantRowProps {
  item: PlantCare;
  label: string;
  children: ReactNode;
  /** Absent: a plain row (past plants, or care status not known). */
  actions?: RowActions;
}

/**
 * One plant row: the link to the plant, and, for work due today or overdue,
 * a round Done button (a drop for watering, like a Reminders checkbox).
 *
 * On a touchscreen the row also swipes, as in Mail: to the right for Done
 * (all the way across does it at once), to the left for Snooze and More.
 * A long press opens the row's menu; so does a right click or the context
 * menu key. Every one of those is also reachable without a gesture: Done is
 * the visible button, and the menu's items live on the plant page too.
 */
export function PlantRow({ item, label, children, actions }: PlantRowProps) {
  const { t } = useTranslation();
  const task = item.task;
  const pending = Boolean(task && actions?.pending.has(task.id));
  const canDo = Boolean(actions && task && item.days !== undefined && item.days <= 0);
  const [offset, setOffsetState] = useState(0);
  // The offset as of the last event, for the release: a fast swipe can end
  // before React re-renders, so the state in this render may be stale.
  const offsetRef = useRef(0);
  const setOffset = (value: number) => {
    offsetRef.current = value;
    setOffsetState(value);
  };
  const [dragging, setDragging] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    start: number;
    horizontal: boolean | null;
    pressTimer: ReturnType<typeof setTimeout> | null;
    pressed: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  const close = () => setOffset(0);
  const clearPress = () => {
    const g = gesture.current;
    if (g?.pressTimer) clearTimeout(g.pressTimer);
    if (g) g.pressTimer = null;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (!actions || event.pointerType !== 'touch') return;
    const g = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      start: offsetRef.current,
      horizontal: null as boolean | null,
      pressTimer: null as ReturnType<typeof setTimeout> | null,
      pressed: false,
    };
    g.pressTimer = setTimeout(() => {
      g.pressed = true;
      suppressClick.current = true;
      actions.openMenu(item, rowRef.current);
    }, LONG_PRESS_MS);
    gesture.current = g;
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId || g.pressed) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearPress();
    if (g.horizontal === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      g.horizontal = Math.abs(dx) > Math.abs(dy);
      if (g.horizontal) {
        try {
          (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
        } catch {
          // No such active pointer (a synthetic event): moves still arrive.
        }
        setDragging(true);
      }
    }
    if (!g.horizontal) return;
    const width = rowRef.current?.offsetWidth ?? 360;
    const next = g.start + dx;
    // Done only exists for work that is due; Snooze and More need a task.
    const max = canDo && !pending ? width * 0.8 : 0;
    const min = task ? -2 * OPEN : 0;
    setOffset(Math.max(min, Math.min(max, next)));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const g = gesture.current;
    clearPress();
    gesture.current = null;
    if (!g || g.id !== event.pointerId) return;
    if (!g.horizontal) return;
    suppressClick.current = true;
    setDragging(false);
    const width = rowRef.current?.offsetWidth ?? 360;
    const offset = offsetRef.current;
    if (offset > width * 0.5 && canDo) {
      close();
      actions?.done(item); // a full swipe across: Done at once (with Undo)
    } else if (offset > OPEN / 2) {
      setOffset(OPEN);
    } else if (offset < -OPEN / 2) {
      setOffset(-2 * OPEN);
    } else {
      close();
    }
  };

  const onClickCapture = (event: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (offset !== 0) {
      // A tap on an open row closes it rather than opening the plant.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const swipeOpen = offset !== 0;
  const taskLabel = task && actions ? actions.taskName(task) : '';
  const isWater = task?.type === 'water';

  return (
    <li className="relative overflow-hidden">
      {actions && task && (
        <>
          {/* Behind the row: Done on the left, Snooze and More on the right.
              Hidden from assistive tech: their gesture-free equivalents are
              the Done button, the row's menu and the plant page. */}
          <div className="absolute inset-y-0 left-0 flex" aria-hidden={offset <= 0}>
            {canDo && !pending && (
              <button
                type="button"
                tabIndex={offset > 0 ? 0 : -1}
                aria-label={taskLabel}
                onClick={() => {
                  close();
                  actions.done(item);
                }}
                className="flex w-[88px] flex-col items-center justify-center gap-1 bg-primary-700 text-xs font-semibold text-white"
                style={{ width: Math.max(OPEN, offset) }}
              >
                <DoneIcon water={isWater} className="h-6 w-6" />
                <span className="large-text:hidden">{taskLabel}</span>
              </button>
            )}
          </div>
          <div className="absolute inset-y-0 right-0 flex" aria-hidden={offset >= 0}>
            <button
              type="button"
              tabIndex={offset < 0 ? 0 : -1}
              aria-label={t('tasks.snooze')}
              onClick={(e) => {
                close();
                actions.snooze(item, e.currentTarget);
              }}
              className="flex w-[88px] flex-col items-center justify-center gap-1 bg-accent-500 text-xs font-semibold text-white"
            >
              <ClockIcon className="h-6 w-6" aria-hidden="true" />
              <span className="large-text:hidden">{t('tasks.snooze')}</span>
            </button>
            <button
              type="button"
              tabIndex={offset < 0 ? 0 : -1}
              aria-label={t('plants.list.swipeMore')}
              onClick={(e) => {
                close();
                actions.openMenu(item, e.currentTarget);
              }}
              className="flex w-[88px] flex-col items-center justify-center gap-1 bg-gray-500 text-xs font-semibold text-white"
            >
              <EllipsisHorizontalIcon className="h-6 w-6" aria-hidden="true" />
              <span className="large-text:hidden">{t('plants.list.swipeMore')}</span>
            </button>
          </div>
        </>
      )}
      {/* The touch gestures (swipe, long press) and the context menu are
          shortcuts layered over the row's own controls, the link and the
          Done button, which stay reachable by keyboard and VoiceOver. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={rowRef}
        className={clsx(
          'relative flex items-center bg-paper select-none [touch-action:pan-y] [-webkit-touch-callout:none]',
          !dragging && 'transition-transform duration-200 motion-reduce:transition-none'
        )}
        style={swipeOpen ? { transform: `translateX(${offset}px)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
        onContextMenu={(event) => {
          if (!actions) return;
          event.preventDefault();
          actions.openMenu(item, event.currentTarget);
        }}
      >
        <Link
          to={`/plants/${item.plant.id}`}
          aria-label={label}
          className="flex min-h-16 min-w-0 flex-1 items-center gap-3 py-2 pl-3 pr-3 hover:bg-parchment/60 focus-visible:bg-parchment large-text:flex-wrap"
        >
          {children}
        </Link>
        {canDo && task && actions && (
          <button
            type="button"
            onClick={() => (pending ? actions.undo(task.id) : actions.done(item))}
            aria-label={
              pending
                ? t('plants.list.undoAria', { task: taskLabel, plant: item.plant.name })
                : t('plants.list.doAria', { task: taskLabel, plant: item.plant.name })
            }
            className={clsx(
              'mr-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 large-text:self-start large-text:mt-3',
              pending
                ? 'border-primary-700 bg-primary-700 text-white'
                : 'border-primary-600 text-primary-700 hover:bg-primary-50'
            )}
          >
            {pending ? (
              <ArrowUturnLeftIcon className="h-5 w-5" aria-hidden="true" />
            ) : (
              <DoneIcon water={isWater} className="h-5 w-5" />
            )}
          </button>
        )}
      </div>
    </li>
  );
}
