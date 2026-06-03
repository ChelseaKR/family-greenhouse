/**
 * Tiny inline icons that pair with the task-type chip across the app.
 * Each icon is a single SVG path drawn at a 24-viewBox so it scales
 * cleanly down to 12px (chip-sized) without losing legibility.
 *
 * Each glyph is intentionally simple — these are recognized at-a-glance,
 * not detailed illustrations. The chip color (assigned by the caller)
 * carries most of the categorical signal; the icon adds a second
 * recognition channel for accessibility (color-blind users) and polish.
 */
import clsx from 'clsx';

type TaskType = 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';

interface TaskTypeIconProps {
  type: TaskType;
  className?: string;
}

export function TaskTypeIcon({ type, className }: TaskTypeIconProps) {
  const cls = clsx('h-3.5 w-3.5 flex-shrink-0', className);
  switch (type) {
    case 'water':
      // Water droplet
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden="true">
          <path d="M12 3 C 9 8, 5 12, 5 16 a 7 7 0 0 0 14 0 c 0 -4 -4 -8 -7 -13 z" />
        </svg>
      );
    case 'fertilize':
      // Three small circles — fertilizer pellets
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden="true">
          <circle cx="7" cy="9" r="2.5" />
          <circle cx="14" cy="6" r="2.5" />
          <circle cx="11" cy="15" r="2.5" />
          <circle cx="17" cy="14" r="2" />
        </svg>
      );
    case 'prune':
      // Open scissors
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cls}
          aria-hidden="true"
        >
          <circle cx="6" cy="7" r="3" />
          <circle cx="6" cy="17" r="3" />
          <line x1="8.5" y1="8.5" x2="20" y2="20" />
          <line x1="8.5" y1="15.5" x2="20" y2="4" />
        </svg>
      );
    case 'repot':
      // Plant in a pot
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden="true">
          <path d="M12 4 c -2 2 -3 5 0 8 c 3 -3 2 -6 0 -8 z" />
          <path d="M5 13 h 14 l -2 7 H 7 z" />
        </svg>
      );
    case 'custom':
    default:
      // Sparkle — generic "task"
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden="true">
          <path d="M12 3 L 13.5 9 L 20 10 L 13.5 11 L 12 17 L 10.5 11 L 4 10 L 10.5 9 z" />
        </svg>
      );
  }
}
