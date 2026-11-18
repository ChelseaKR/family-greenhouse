import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Combobox, Dialog, Transition } from '@headlessui/react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { MagnifyingGlassIcon, ClipboardDocumentListIcon } from '@heroicons/react/24/outline';
import { plantService, type Plant, type Task } from '@/services/plantService';
import { EmptySearch } from '@/components/illustrations/EmptySearch';
import { taskService } from '@/services/taskService';
import { useAuthStore } from '@/store/authStore';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';

type Result =
  | { kind: 'plant'; id: string; label: string; sub: string | null; href: string }
  | { kind: 'task'; id: string; label: string; sub: string; href: string };

function matches(haystack: string | null | undefined, q: string) {
  return !!haystack && haystack.toLowerCase().includes(q);
}

export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => !!s.user);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Move focus to the search field when the palette opens. Using the Dialog's
  // `initialFocus` (rather than `autoFocus`) keeps focus management explicit
  // and a11y-correct: focus enters the dialog only when it actually opens.
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isCmdK) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const householdId = useActiveHouseholdId();

  const plantsQuery = useQuery({
    queryKey: ['plants', householdId],
    queryFn: () => plantService.getPlants(),
    enabled: isAuthenticated && open,
  });

  const tasksQuery = useQuery({
    queryKey: ['tasks', householdId],
    queryFn: () => taskService.getTasks(),
    enabled: isAuthenticated && open,
  });
  const plants = plantsQuery.data;
  const tasks = tasksQuery.data;
  // "No matches" is a claim about the household's plants and tasks, so it is
  // only made once both lists have actually been read. Typing straight after
  // ⌘K used to say "No matches" for a plant that was there, because the lists
  // were still loading — and a failed read said it for good (ADR 0010).
  const searching = plantsQuery.isLoading || tasksQuery.isLoading;
  const readFailed = plantsQuery.isError || tasksQuery.isError;

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const plantHits: Result[] = (plants ?? [])
      .filter((p: Plant) => matches(p.name, q) || matches(p.species, q) || matches(p.location, q))
      .slice(0, 8)
      .map((p: Plant) => ({
        kind: 'plant',
        id: p.id,
        label: p.name,
        sub: p.species || p.location,
        href: `/plants/${p.id}`,
      }));
    const taskHits: Result[] = (tasks ?? [])
      .filter(
        (t: Task) =>
          matches(t.plantName, q) || matches(t.customType ?? t.type, q) || matches(t.notes, q)
      )
      .slice(0, 8)
      .map((t: Task) => ({
        kind: 'task',
        id: t.id,
        label: `${t.customType ?? t.type} — ${t.plantName}`,
        sub: t.assignedToName ? `Assigned to ${t.assignedToName}` : 'Unassigned',
        href: `/plants/${t.plantId}`,
      }));
    return [...plantHits, ...taskHits];
  }, [query, plants, tasks]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  function onSelect(item: Result | null) {
    if (!item) return;
    navigate(item.href);
    close();
  }

  if (!isAuthenticated) return null;

  return (
    <Transition.Root show={open} as={Fragment} afterLeave={() => setQuery('')}>
      {/* PROPOSED WORDING. The dialog had no accessible name, and the search
          field's only name was its placeholder. Both now carry
          commandPalette.title. */}
      <Dialog
        as="div"
        className="relative z-50"
        onClose={close}
        initialFocus={inputRef}
        aria-label={t('commandPalette.title')}
      >
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-primary-950/70" />
        </Transition.Child>

        <div className="fixed inset-0 z-10 overflow-y-auto p-4 sm:p-6 md:p-20">
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-200"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="ease-in duration-150"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <Dialog.Panel className="mx-auto max-w-xl transform overflow-hidden rounded-xl bg-paper shadow-2xl ring-1 ring-primary-100/80 transition-all">
              <Combobox onChange={onSelect}>
                <div className="relative">
                  <MagnifyingGlassIcon
                    className="pointer-events-none absolute left-4 top-3.5 h-5 w-5 text-gray-400"
                    aria-hidden="true"
                  />
                  <Combobox.Input
                    ref={inputRef}
                    className="h-12 w-full border-0 bg-transparent pl-11 pr-4 text-gray-900 placeholder:text-gray-500 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 text-base sm:text-sm"
                    aria-label={t('commandPalette.title')}
                    placeholder={t('commandPalette.placeholder')}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>

                {results.length > 0 && (
                  <Combobox.Options
                    static
                    className="max-h-80 scroll-py-2 divide-y divide-primary-100/60 overflow-y-auto"
                  >
                    {results.some((r) => r.kind === 'plant') && (
                      <li>
                        <h2 className="bg-parchment/70 px-4 py-2 text-xs font-semibold text-gray-700">
                          Plants
                        </h2>
                        <ul className="text-sm text-gray-700">
                          {results
                            .filter((r) => r.kind === 'plant')
                            .map((r) => (
                              <Combobox.Option
                                key={`p-${r.id}`}
                                value={r}
                                className={({ active }) =>
                                  `flex items-center gap-3 cursor-pointer select-none px-4 py-2 ${
                                    active ? 'bg-primary-700 text-white' : ''
                                  }`
                                }
                              >
                                <PlantBullet />
                                <span className="flex-auto truncate">{r.label}</span>
                                {/* opacity-90, not 75: on the highlighted row
                                    this is white on the brand green, and at
                                    75% it was 4.3:1. */}
                                {r.sub && (
                                  <span className="text-xs italic opacity-90 truncate">
                                    {r.sub}
                                  </span>
                                )}
                              </Combobox.Option>
                            ))}
                        </ul>
                      </li>
                    )}
                    {results.some((r) => r.kind === 'task') && (
                      <li>
                        <h2 className="bg-parchment/70 px-4 py-2 text-xs font-semibold text-gray-700">
                          Tasks
                        </h2>
                        <ul className="text-sm text-gray-700">
                          {results
                            .filter((r) => r.kind === 'task')
                            .map((r) => (
                              <Combobox.Option
                                key={`t-${r.id}`}
                                value={r}
                                className={({ active }) =>
                                  `flex items-center gap-3 cursor-pointer select-none px-4 py-2 ${
                                    active ? 'bg-primary-700 text-white' : ''
                                  }`
                                }
                              >
                                <ClipboardDocumentListIcon
                                  className="h-5 w-5 flex-none"
                                  aria-hidden="true"
                                />
                                <span className="flex-auto truncate">{r.label}</span>
                                <span className="text-xs opacity-90 truncate">{r.sub}</span>
                              </Combobox.Option>
                            ))}
                        </ul>
                      </li>
                    )}
                  </Combobox.Options>
                )}

                {query !== '' && results.length === 0 && searching && (
                  <p className="px-6 py-8 text-center text-sm text-gray-500" role="status">
                    {t('common.loading')}
                  </p>
                )}

                {query !== '' && results.length === 0 && !searching && readFailed && (
                  <p className="px-6 py-8 text-center text-sm text-red-700" role="alert">
                    {t('common.error')}
                  </p>
                )}

                {query !== '' && results.length === 0 && !searching && !readFailed && (
                  <div className="p-6 text-center">
                    <EmptySearch className="mx-auto h-24 w-auto" />
                    {/* role="status", like the loading and error lines beside
                        it: an empty result was the one outcome of typing here
                        that a screen reader never heard (WCAG 4.1.3). */}
                    <p className="mt-2 text-sm text-gray-500" role="status">
                      No matches for &ldquo;{query}&rdquo;.
                    </p>
                  </div>
                )}

                {/* gray-600, not -500, on the hint: its Esc key cap sits on
                    parchment, where gray-500 is 4.2:1. */}
                {query === '' && (
                  <p className="px-6 py-8 text-center text-sm text-gray-600">
                    Type to search plants and tasks. Press{' '}
                    <kbd className="rounded-sm border border-primary-200/70 bg-parchment/70 px-1 font-sans text-xs">
                      Esc
                    </kbd>{' '}
                    to close.
                  </p>
                )}
              </Combobox>
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition.Root>
  );
}

function PlantBullet() {
  return (
    <svg
      className="h-5 w-5 flex-none text-primary-600"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 21c-2-2-5-3-5-8 0-3 2-5 5-5s5 2 5 5c0 5-3 6-5 8z"
      />
    </svg>
  );
}
