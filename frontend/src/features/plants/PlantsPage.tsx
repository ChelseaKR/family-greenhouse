import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  PlusIcon,
  MagnifyingGlassIcon,
  Squares2X2Icon,
  ListBulletIcon,
  ClipboardDocumentListIcon,
  MapPinIcon,
  Cog6ToothIcon,
  ArrowsRightLeftIcon,
} from '@heroicons/react/24/outline';
import { plantService } from '@/services/plantService';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { PlantGridSkeleton, ListSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { EmptyPlants } from '@/components/illustrations/EmptyPlants';
import { Alert } from '@/components/Alert';
import { getErrorMessage } from '@/services/api';
import clsx from 'clsx';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { BulkApplyTemplateDialog } from './BulkApplyTemplateDialog';
import { PlantImage } from '@/components/PlantImage';
import { PlantStatusBadge } from './PlantLineageCard';
import { spaceService } from '@/services/spaceService';
import { taskService } from '@/services/taskService';
import { householdService } from '@/services/householdService';
import { SpaceBrowseView } from './SpaceBrowseView';
import { SpaceManagerPanel } from './SpaceManagerPanel';
import { MovePlantsDialog } from './MovePlantsDialog';
import { matchesSpaceFilter, plantLocationLabel, spaceMap, type SpaceFilter } from '@/utils/spaces';

type ViewMode = 'grid' | 'list' | 'spaces';

/** Target of the Manage-spaces button's `aria-controls`. */
const SPACE_MANAGER_PANEL_ID = 'plants-space-manager-panel';

export function PlantsPage() {
  useDocumentTitle('Plants');
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [spaceManagerOpen, setSpaceManagerOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [spaceFilter, setSpaceFilter] = useState<SpaceFilter>('all');
  // 'active' is the default living collection; 'past' shows died/gave-away
  // plants whose history we keep. Active stays under the ['plants', hh] key
  // so existing invalidations + the add-flow's cache read keep working.
  const [view, setView] = useState<'active' | 'past'>('active');
  const householdId = useActiveHouseholdId();

  const {
    data: plants,
    isLoading,
    error,
  } = useQuery({
    queryKey: view === 'active' ? ['plants', householdId] : ['plants', householdId, 'past'],
    queryFn: () => plantService.getPlants(view),
    enabled: Boolean(householdId),
  });

  const { data: spaces = [] } = useQuery({
    queryKey: ['spaces', householdId],
    queryFn: spaceService.getSpaces,
    enabled: Boolean(householdId),
  });
  const shouldLoadSpaceOverview = viewMode === 'spaces' && view === 'active';
  const {
    data: spaceTasks = [],
    isLoading: spaceTasksLoading,
    isError: spaceTasksError,
  } = useQuery({
    queryKey: ['tasks', householdId],
    queryFn: () => taskService.getTasks(),
    enabled: shouldLoadSpaceOverview && Boolean(householdId),
  });
  const { data: overviewHousehold } = useQuery({
    queryKey: ['household', householdId],
    queryFn: () => householdService.getHousehold(householdId!),
    enabled: shouldLoadSpaceOverview && Boolean(householdId),
  });
  const spacesById = useMemo(() => spaceMap(spaces), [spaces]);

  const filteredPlants = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return plants?.filter((plant) => {
      const matchesQuery =
        plant.name.toLowerCase().includes(q) ||
        plant.species?.toLowerCase().includes(q) ||
        plantLocationLabel(plant, spacesById).toLowerCase().includes(q);
      return matchesQuery && matchesSpaceFilter(plant, spacesById, spaceFilter);
    });
  }, [plants, searchQuery, spaceFilter, spacesById]);

  const trimmedQuery = searchQuery.trim();
  const settled = !isLoading && !error && filteredPlants !== undefined;
  const matchCount = filteredPlants?.length ?? 0;
  const plantNoun = matchCount === 1 ? 'plant' : 'plants';
  const filterSummary = !settled
    ? ''
    : trimmedQuery
      ? `${matchCount} ${plantNoun} ${matchCount === 1 ? 'matches' : 'match'} \u201C${trimmedQuery}\u201D.`
      : spaceFilter !== 'all'
        ? `${matchCount} ${plantNoun} in this view.`
        : '';

  // Propagation cue: plants that have cuttings get a 🌱 mark on their card.
  // Derived from the already-fetched list (parentPlantId is on every plant),
  // so it costs no extra request. Note the current view only sees parents
  // whose cuttings are in the SAME view — good enough for a cue.
  const plantsWithCuttings = useMemo(
    () => new Set((plants ?? []).map((p) => p.parentPlantId).filter((id): id is string => !!id)),
    [plants]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Greenhouse"
        title="Plants"
        description="Manage your household plants."
        action={
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            <Button
              variant="secondary"
              onClick={() => setMoveOpen(true)}
              leftIcon={<ArrowsRightLeftIcon className="h-5 w-5" aria-hidden="true" />}
            >
              {t('spaces.bulkMoveAction')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setBulkOpen(true)}
              leftIcon={<ClipboardDocumentListIcon className="h-5 w-5" aria-hidden="true" />}
            >
              Apply template
            </Button>
            <Link to="/plants/new" className="block">
              <Button
                className="w-full sm:w-auto"
                leftIcon={<PlusIcon className="h-5 w-5" aria-hidden="true" />}
              >
                Add plant
              </Button>
            </Link>
          </div>
        }
      />

      <BulkApplyTemplateDialog isOpen={bulkOpen} onClose={() => setBulkOpen(false)} />
      <MovePlantsDialog isOpen={moveOpen} onClose={() => setMoveOpen(false)} />

      {/* Active vs past (archived / died / gave away) collection.
          Toggle buttons, NOT a tablist: there is no tab panel here — the same
          grid below re-queries — and nothing implements roving tabIndex or
          arrow-key movement. `role="tab"` made NVDA/JAWS announce "1 of 2" and
          switch into tab-interaction mode, after which the arrow keys it had
          just promised did nothing. `aria-pressed` describes what these
          actually are, and matches the View-mode group 30 lines below.
          SettingsPage is the one surface here that warrants the full pattern
          and it implements all of it. */}
      <div
        className="flex gap-1 border-b border-primary-100/70"
        role="group"
        aria-label="Plant collection"
      >
        {(['active', 'past'] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium min-h-touch',
              view === v
                ? 'border-primary-600 text-primary-800'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            {v === 'active' ? 'Active' : 'Past plants'}
          </button>
        ))}
      </div>

      {/* Search and filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500"
            aria-hidden="true"
          />
          <input
            type="search"
            placeholder="Search plants..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input pl-10"
            aria-label="Search plants"
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setSpaceManagerOpen((open) => !open)}
          aria-expanded={spaceManagerOpen}
          // Only while the panel exists: an `aria-controls` pointing at an id
          // that is not in the document is a dangling reference.
          aria-controls={spaceManagerOpen ? SPACE_MANAGER_PANEL_ID : undefined}
          leftIcon={<Cog6ToothIcon className="h-5 w-5" aria-hidden="true" />}
        >
          {t('spaces.manageAction')}
        </Button>
        <div className="flex rounded-md shadow-xs" role="group" aria-label="View mode">
          <button
            type="button"
            className={clsx(
              'relative inline-flex items-center rounded-l-md min-h-touch min-w-touch justify-center px-3 py-2 text-sm font-medium border focus:z-10 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500',
              viewMode === 'grid'
                ? 'bg-primary-50 text-primary-700 border-primary-500'
                : 'bg-paper text-gray-700 border-primary-200/70 hover:bg-primary-50'
            )}
            onClick={() => setViewMode('grid')}
            aria-pressed={viewMode === 'grid'}
          >
            <Squares2X2Icon className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">Grid view</span>
          </button>
          <button
            type="button"
            className={clsx(
              'relative -ml-px inline-flex items-center min-h-touch min-w-touch justify-center px-3 py-2 text-sm font-medium border focus:z-10 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500',
              viewMode === 'list'
                ? 'bg-primary-50 text-primary-700 border-primary-500'
                : 'bg-paper text-gray-700 border-primary-200/70 hover:bg-primary-50'
            )}
            onClick={() => setViewMode('list')}
            aria-pressed={viewMode === 'list'}
          >
            <ListBulletIcon className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">List view</span>
          </button>
          <button
            type="button"
            className={clsx(
              'relative -ml-px inline-flex items-center rounded-r-md min-h-touch min-w-touch justify-center px-3 py-2 text-sm font-medium border focus:z-10 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500',
              viewMode === 'spaces'
                ? 'bg-primary-50 text-primary-700 border-primary-500'
                : 'bg-paper text-gray-700 border-primary-200/70 hover:bg-primary-50'
            )}
            onClick={() => setViewMode('spaces')}
            aria-pressed={viewMode === 'spaces'}
          >
            <MapPinIcon className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">{t('spaces.viewLabel')}</span>
          </button>
        </div>
      </div>

      {/* Mounted immediately after the row that holds its toggle, so the panel
          a user just revealed is reachable by continuing to Tab. It used to
          render ~40 lines earlier in the JSX — above the toggle, the search box
          and the collection switch — so pressing the button inserted content
          behind the caret and forward Tab walked straight past it into the
          grid, reachable only by Shift+Tab back through everything. */}
      {spaceManagerOpen && (
        <div id={SPACE_MANAGER_PANEL_ID}>
          <SpaceManagerPanel />
        </div>
      )}

      <div className="flex flex-wrap gap-2" role="group" aria-label={t('spaces.filterAria')}>
        {(['all', 'inside', 'outside', 'unplaced'] as const).map((filter) => (
          <button
            key={filter}
            type="button"
            onClick={() => setSpaceFilter(filter)}
            aria-pressed={spaceFilter === filter}
            className={clsx(
              'min-h-touch rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
              spaceFilter === filter
                ? 'border-primary-400 bg-primary-100 text-primary-800'
                : 'border-primary-200/70 bg-paper text-gray-700 hover:bg-primary-50'
            )}
          >
            {t(`spaces.${filter}`)}
          </button>
        ))}
      </div>

      {/* Announce the filtered count, not just the visual change: this list
          re-filters on every keystroke and on every space chip, and a
          keyboard/screen-reader user otherwise gets no feedback that the page
          under them has shrunk — or emptied. Same pattern (and the same
          reasoning) as HelpPage's search summary.

          Empty while the read is unsettled: "0 plants match" from a failed or
          in-flight load is a number we do not have, and publishing it would be
          exactly the settled-read defect the overdue chip on /tasks was fixed
          for. */}
      <p aria-live="polite" className="text-sm text-gray-600">
        {filterSummary}
      </p>

      {/* Plant list */}
      {isLoading ? (
        viewMode === 'grid' ? (
          <PlantGridSkeleton />
        ) : (
          <ListSkeleton rows={6} />
        )
      ) : error ? (
        <Alert variant="error">{getErrorMessage(error)}</Alert>
      ) : !filteredPlants || filteredPlants.length === 0 ? (
        searchQuery ? (
          <EmptyState
            title="No plants found"
            description={`No plants match "${searchQuery}"`}
            action={
              <Button variant="secondary" onClick={() => setSearchQuery('')}>
                Clear search
              </Button>
            }
          />
        ) : view === 'past' ? (
          <EmptyState
            icon={
              <span className="text-5xl" aria-hidden="true">
                📚
              </span>
            }
            title={t('plants.archive.emptyTitle')}
            description={t('plants.archive.emptyDescription')}
          />
        ) : (
          <EmptyState
            icon={<EmptyPlants className="mx-auto h-40 w-auto" />}
            title="Let's add your first plant"
            description="Name it, or start typing a species and we'll fill in the care details for you. Once it's in, we'll track watering and the rest for you."
            action={
              <Link to="/plants/new">
                <Button size="lg" leftIcon={<PlusIcon className="h-5 w-5" aria-hidden="true" />}>
                  Add your first plant
                </Button>
              </Link>
            }
            hint="Takes less than a minute."
          />
        )
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filteredPlants.map((plant) => (
            <Link
              key={plant.id}
              to={`/plants/${plant.id}`}
              className="group block rounded-xl border border-primary-100/70 bg-paper overflow-hidden shadow-journal hover:border-primary-400 hover:shadow-journal-hover transition-all"
            >
              <div className="aspect-square bg-parchment overflow-hidden">
                <PlantImage
                  plant={plant}
                  width={300}
                  height={300}
                  className="group-hover:scale-105 transition-transform"
                />
              </div>
              <div className="p-4">
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-ink">
                    {plant.name}
                    {plantsWithCuttings.has(plant.id) && (
                      <span
                        className="ml-1"
                        role="img"
                        aria-label={t('plants.lineage.hasCuttings')}
                        title={t('plants.lineage.hasCuttings')}
                      >
                        🌱
                      </span>
                    )}
                  </p>
                  {view === 'past' && <PlantStatusBadge status={plant.status ?? 'active'} />}
                </div>
                {plant.species && (
                  <p className="text-xs text-gray-600 truncate italic">{plant.species}</p>
                )}
                <p className="text-xs text-gray-600 truncate mt-1">
                  {plantLocationLabel(plant, spacesById)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      ) : viewMode === 'spaces' ? (
        <SpaceBrowseView
          plants={filteredPlants}
          spaces={spaces}
          tasks={spaceTasks}
          members={overviewHousehold?.members}
          latitude={overviewHousehold?.location?.lat}
          tasksLoading={spaceTasksLoading}
          tasksError={spaceTasksError}
          showCareOverview={view === 'active'}
        />
      ) : (
        <Card variant="paper" padding="none">
          <ul className="divide-y divide-primary-100/60">
            {filteredPlants.map((plant) => (
              <li key={plant.id}>
                <Link
                  to={`/plants/${plant.id}`}
                  className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-parchment/60"
                >
                  <div className="h-12 w-12 rounded-lg bg-parchment overflow-hidden shrink-0 ring-1 ring-primary-100/60">
                    <PlantImage plant={plant} width={48} height={48} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-medium text-ink">
                        {plant.name}
                        {plantsWithCuttings.has(plant.id) && (
                          <span
                            className="ml-1"
                            role="img"
                            aria-label={t('plants.lineage.hasCuttings')}
                            title={t('plants.lineage.hasCuttings')}
                          >
                            🌱
                          </span>
                        )}
                      </p>
                      {view === 'past' && <PlantStatusBadge status={plant.status ?? 'active'} />}
                    </div>
                    <p className="text-sm text-gray-600">
                      {[plant.species, plantLocationLabel(plant, spacesById)]
                        .filter(Boolean)
                        .join(' • ') || 'No details'}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
