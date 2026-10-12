import { useEffect, useRef, type ReactNode } from 'react';
import { CheckIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';

/** One choice in a toolbar menu. `checked` marks the current option of a
 *  pick-one group; leave it undefined for a plain action. */
export interface MenuItemModel {
  id: string;
  label: string;
  checked?: boolean;
}

export interface MenuGroupModel {
  title?: string;
  items: MenuItemModel[];
}

interface ToolbarMenuProps {
  /** Accessible name of the button that opens the menu. */
  label: string;
  icon: ReactNode;
  groups: MenuGroupModel[];
  onSelect: (id: string) => void;
}

/**
 * A small pop-down menu on `<details>`/`<summary>` (the same primitive as the
 * plant page's snooze menu), so it costs no popover library: the summary is a
 * button with its expanded state, and Escape or a tap outside closes it.
 *
 * The groups are plain data. The same model is what the iOS app's native bar
 * menus are built from, so the web menu and the native one cannot drift.
 */
export function ToolbarMenu({ label, icon, groups, onSelect }: ToolbarMenuProps) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (event: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        el.open = false;
        el.querySelector('summary')?.focus();
      } else if (!el.contains(event.target as Node)) {
        el.open = false;
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  return (
    <details ref={ref} className="relative shrink-0">
      <summary
        aria-label={label}
        title={label}
        className="flex min-h-touch min-w-touch cursor-pointer list-none items-center justify-center rounded-full border border-primary-200/70 bg-paper text-primary-800 [&::-webkit-details-marker]:hidden"
      >
        {icon}
      </summary>
      <div className="absolute right-0 z-30 mt-2 max-h-[70vh] w-64 overflow-y-auto rounded-2xl border border-primary-100 bg-paper py-1 shadow-journal-hover large-text:w-[min(22rem,90vw)]">
        {groups.map((group, gi) => (
          <div
            key={group.title ?? gi}
            role="group"
            aria-label={group.title}
            className={clsx(gi > 0 && 'border-t border-primary-100')}
          >
            {group.title && (
              <p className="px-4 pb-1 pt-2 text-xs font-semibold text-gray-600">{group.title}</p>
            )}
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.checked}
                onClick={() => {
                  if (ref.current) ref.current.open = false;
                  onSelect(item.id);
                }}
                className="flex min-h-touch w-full items-center gap-2 px-4 py-2 text-left text-sm text-ink hover:bg-parchment focus-visible:bg-parchment focus-visible:outline-hidden"
              >
                <span className="w-4 shrink-0" aria-hidden="true">
                  {item.checked && <CheckIcon className="h-4 w-4" />}
                </span>
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}
