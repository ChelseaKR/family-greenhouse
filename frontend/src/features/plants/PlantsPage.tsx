import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
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
  AdjustmentsHorizontalIcon,
  EllipsisHorizontalIcon,
  XMarkIcon,
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
import { useIsMobile } from '@/hooks/useMediaQuery';
import { useSpaces } from '@/hooks/useSpaces';
import { hasNativeBarTools, hasNativeFrame } from '@/lib/platform';
import { useAuthStore } from '@/store/authStore';
import { BulkApplyTemplateDialog } from './BulkApplyTemplateDialog';
import { PlantImage } from '@/components/PlantImage';
import { PlantStatusBadge } from './PlantLineageCard';
import { taskService } from '@/services/taskService';
import { householdService } from '@/services/householdService';
import { SpaceBrowseView } from './SpaceBrowseView';
import { SpaceManagerPanel } from './SpaceManagerPanel';
import { MovePlantsDialog } from './MovePlantsDialog';
import { PlantCareList } from './PlantCareList';
import { ToolbarMenu, type MenuGroupModel } from './ToolbarMenu';
import { useNativeBarTools } from './useNativeBarTools';
import { careWho, groupPlantCare, plantCare, type GroupBy } from './plantCare';
import { matchesSpaceFilter, plantLocationLabel, type SpaceFilter } from '@/utils/spaces';

type ViewMode = 'grid' | 'list' | 'spaces';
type WhoFilter = 'all' | 'mine' | 'open';

/** Target of the Manage-spaces button's `aria-controls`. */
const SPACE_MANAGER_PANEL_ID = 'plants-space-manager-panel';

const SECTION_KEYS: Record<string, string> = {
  needs: 'plants.list.sectionNeeds',
  soon: 'plants.list.sectionSoon',
  later: 'plants.list.sectionLater',
  none: 'plants.list.sectionNone',
  all: 'plants.list.sectionAll',
};

export function PlantsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('plants.title'));
  const navigate = useNavigate();
  // Phones get the "Today first" list: the website under 640px, and the iOS
  // app at every width (its native bars replace the page's own header).
  const isMobile = useIsMobile();
  const compact = isMobile || hasNativeFrame();
  const myUserId = useAuthStore((state) => state.user?.id);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [spaceManagerOpen, setSpaceManagerOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [spaceFilter, setSpaceFilter] = useState<SpaceFilter>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('care');
  const [whoFilter, setWhoFilter] = useState<WhoFilter>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
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

  const { spaces, byId: spacesById, unavailable: spacesUnavailable } = useSpaces();
  const showsCare = view === 'active' && (compact || viewMode === 'spaces');
  const {
    data: careTasks,
    isLoading: tasksLoading,
    isError: tasksError,
  } = useQuery({
    queryKey: ['tasks', householdId],
    queryFn: () => taskService.getTasks(),
    enabled: showsCare && Boolean(householdId),
  });
  const shouldLoadSpaceOverview = !compact && viewMode === 'spaces' && view === 'active';
  const { data: overviewHousehold } = useQuery({
    queryKey: ['household', householdId],
    queryFn: () => householdService.getHousehold(householdId!),
    enabled: shouldLoadSpaceOverview && Boolean(householdId),
  });

  const unplacedLabel = spacesUnavailable ? t('spaces.locationUnknown') : t('spaces.unplaced');
  const allTags = useMemo(
    () => [...new Set((plants ?? []).flatMap((p) => p.tags ?? []))].sort(),
    [plants]
  );
  const activeTag = tagFilter && allTags.includes(tagFilter) ? tagFilter : null;

  const filteredPlants = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return plants?.filter((plant) => {
      const matchesQuery =
        plant.name.toLowerCase().includes(q) ||
        plant.species?.toLowerCase().includes(q) ||
        plantLocationLabel(plant, spacesById).toLowerCase().includes(q);
      return (
        matchesQuery &&
        matchesSpaceFilter(plant, spacesById, spaceFilter) &&
        (!compact || !activeTag || (plant.tags ?? []).includes(activeTag))
      );
    });
  }, [plants, searchQuery, spaceFilter, spacesById, compact, activeTag]);

  // Care status is real only once the tasks read has SETTLED with data.
  // While it loads or after it failed, rows carry no status and the list is
  // grouped by name: a plant whose tasks we could not read is never "All good".
  const careKnown = view === 'active' && careTasks !== undefined && !tasksError;
  const careItems = useMemo(() => {
    if (!compact || !filteredPlants) return [];
    const items = plantCare(filteredPlants, careKnown ? careTasks! : []);
    if (!careKnown || whoFilter === 'all') return items;
    return items.filter((item) => {
      if (!item.task) return false;
      const who = careWho(item.task, myUserId).kind;
      return whoFilter === 'mine' ? who === 'you' : who === 'open';
    });
  }, [compact, filteredPlants, careKnown, careTasks, whoFilter, myUserId]);

  const roomKey = (plant: { spaceId?: string | null }) =>
    plant.spaceId && spacesById.has(plant.spaceId) ? plant.spaceId : 'unplaced';
  const sections = useMemo(
    () =>
      groupPlantCare(
        careItems,
        careKnown || groupBy === 'room' ? groupBy : 'name',
        roomKey,
        spaces.map((s) => s.id)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roomKey reads spacesById only
    [careItems, careKnown, groupBy, spaces, spacesById]
  );

  const trimmedQuery = searchQuery.trim();
  const settled = !isLoading && !error && filteredPlants !== undefined;
  const matchCount = compact && settled ? careItems.length : (filteredPlants?.length ?? 0);
  const filtering = spaceFilter !== 'all' || (compact && (whoFilter !== 'all' || !!activeTag));
  const filterSummary = !settled
    ? ''
    : trimmedQuery
      ? t('plants.list.matches', { count: matchCount, query: trimmedQuery })
      : filtering
        ? t('plants.list.inView', { count: matchCount })
        : '';

  // Propagation cue: plants that have cuttings get a 🌱 mark on their card.
  // Derived from the already-fetched list (parentPlantId is on every plant),
  // so it costs no extra request. Note the current view only sees parents
  // whose cuttings are in the SAME view — good enough for a cue.
  const plantsWithCuttings = useMemo(
    () => new Set((plants ?? []).map((p) => p.parentPlantId).filter((id): id is string => !!id)),
    [plants]
  );

  const dialogs = (
    <>
      <BulkApplyTemplateDialog isOpen={bulkOpen} onClose={() => setBulkOpen(false)} />
      <MovePlantsDialog isOpen={moveOpen} onClose={() => setMoveOpen(false)} />
    </>
  );

  const listBody = isLoading ? (
    !compact && viewMode === 'grid' ? (
      <PlantGridSkeleton />
    ) : (
      <ListSkeleton rows={6} />
    )
  ) : error ? (
    <Alert variant="error">{getErrorMessage(error)}</Alert>
  ) : !filteredPlants || filteredPlants.length === 0 || (compact && careItems.length === 0) ? (
    searchQuery || filtering ? (
      <EmptyState
        title={t('plants.list.noneFoundTitle')}
        description={
          searchQuery ? t('plants.list.noneFoundDescription', { query: searchQuery }) : undefined
        }
        action={
          searchQuery ? (
            <Button variant="secondary" onClick={() => setSearchQuery('')}>
              {t('plants.list.clearSearch')}
            </Button>
          ) : undefined
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
        title={t('plants.list.emptyTitle')}
        description={t('plants.list.emptyDescription')}
        action={
          <div className="flex flex-col items-center gap-3">
            <Link to="/plants/new">
              <Button size="lg" leftIcon={<PlusIcon className="h-5 w-5" aria-hidden="true" />}>
                {t('plants.addFirst')}
              </Button>
            </Link>
            {compact && (
              <Link
                to="/plants/import"
                className="inline-flex min-h-touch items-center text-sm font-semibold text-primary-800"
              >
                {t('plants.list.importPlants')}
              </Link>
            )}
          </div>
        }
        hint={t('plants.list.emptyHint')}
      />
    )
  ) : null;

  const emptyHousehold =
    settled && view === 'active' && (plants?.length ?? 0) === 0 && !searchQuery && !filtering;
  const filterGroups: MenuGroupModel[] = [
    {
      title: t('plants.list.groupBy'),
      items: (['care', 'room', 'name'] as const).map((g) => ({
        id: `group:${g}`,
        label: t(
          g === 'care'
            ? 'plants.list.groupCare'
            : g === 'room'
              ? 'plants.list.groupRoom'
              : 'plants.list.groupName'
        ),
        checked: groupBy === g,
      })),
    },
    ...(view === 'active'
      ? [
          {
            title: t('plants.list.show'),
            items: (['all', 'mine', 'open'] as const).map((w) => ({
              id: `who:${w}`,
              label: t(
                w === 'all'
                  ? 'plants.list.everyone'
                  : w === 'mine'
                    ? 'plants.list.mine'
                    : 'tasks.upForGrabs'
              ),
              checked: whoFilter === w,
            })),
          },
        ]
      : []),
    {
      title: t('plants.list.spaces'),
      items: (['all', 'inside', 'outside', 'unplaced'] as const).map((f) => ({
        id: `space:${f}`,
        label: t(`spaces.${f}`),
        checked: spaceFilter === f,
      })),
    },
    ...(allTags.length > 0
      ? [
          {
            title: t('plants.list.tags'),
            items: [
              { id: 'tag:', label: t('plants.list.allTags'), checked: !activeTag },
              ...allTags.map((tag) => ({
                id: `tag:${tag}`,
                label: tag,
                checked: activeTag === tag,
              })),
            ],
          },
        ]
      : []),
  ];
  const moreGroups: MenuGroupModel[] = [
    {
      items: [
        { id: 'act:move', label: t('spaces.bulkMoveAction') },
        { id: 'act:template', label: t('plants.list.applyTemplate') },
        { id: 'act:spaces', label: t('plants.list.manageSpaces') },
      ],
    },
    {
      items: [
        view === 'active'
          ? { id: 'act:past', label: t('plants.list.past') }
          : { id: 'act:active', label: t('plants.list.active') },
        { id: 'act:import', label: t('plants.list.importPlants') },
      ],
    },
  ];
  const onMenu = (id: string) => {
    const [kind, value] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    if (kind === 'group') setGroupBy(value as GroupBy);
    else if (kind === 'who') setWhoFilter(value as WhoFilter);
    else if (kind === 'space') setSpaceFilter(value as SpaceFilter);
    else if (kind === 'tag') setTagFilter(value || null);
    else if (value === 'move') setMoveOpen(true);
    else if (value === 'template') setBulkOpen(true);
    else if (value === 'spaces') setSpaceManagerOpen(true);
    else if (value === 'past' || value === 'active') setView(value);
    else if (value === 'import') navigate('/plants/import');
    // A new filter, grouping or collection reshapes the list: start at its
    // top, where the token that explains it sits, not somewhere mid-list. In
    // the iOS app the bar does this itself (its top at rest is above zero by
    // the bars' height, so a scrollTo(0, 0) here would undo it).
    if (!hasNativeBarTools() && (kind !== 'act' || value === 'past' || value === 'active'))
      window.scrollTo(0, 0);
  };
  // In the iOS app the bar carries the search field and both menus, and the
  // page drops its own row of controls. An app built before the bar could
  // (no `setBarTools`) keeps the web row.
  const nativeBar = compact && hasNativeBarTools();
  useNativeBarTools(
    nativeBar
      ? {
          path: '/plants',
          menus: emptyHousehold
            ? []
            : [
                {
                  id: 'filter',
                  label: t('plants.list.filter'),
                  symbol: 'line.3.horizontal.decrease.circle',
                  groups: filterGroups,
                },
                {
                  id: 'more',
                  label: t('plants.list.more'),
                  symbol: 'ellipsis.circle',
                  groups: moreGroups,
                },
              ],
          search: emptyHousehold
            ? null
            : { placeholder: t('plants.list.searchLabel'), text: searchQuery },
        }
      : null,
    onMenu,
    setSearchQuery
  );

  if (compact) {
    // Nothing to search, filter or bulk-move in an empty household: the only
    // control left is the one that fixes that.
    // One removable token per filter in force, so the list never shrinks
    // without saying why.
    const tokens = [
      view === 'past' && { label: t('plants.list.past'), clear: () => setView('active') },
      view === 'active' &&
        whoFilter !== 'all' && {
          label: t(whoFilter === 'mine' ? 'plants.list.mine' : 'tasks.upForGrabs'),
          clear: () => setWhoFilter('all'),
        },
      spaceFilter !== 'all' && {
        label: t(`spaces.${spaceFilter}`),
        clear: () => setSpaceFilter('all'),
      },
      activeTag && { label: activeTag, clear: () => setTagFilter(null) },
    ].filter((x): x is { label: string; clear: () => void } => Boolean(x));

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 large-text:flex-col large-text:items-start">
          <div className="min-w-0">
            <h1 className="font-serif text-3xl leading-tight text-ink">{t('plants.title')}</h1>
            {settled && (plants?.length ?? 0) > 0 && (
              <p className="text-sm text-gray-600 native-frame:hidden!">
                {t('plants.list.count', { count: plants!.length })}
              </p>
            )}
          </div>
          {/* The iOS app has the "+" in its navigation bar. */}
          <Link to="/plants/new" className="shrink-0 native-frame:hidden!">
            <Button size="sm" leftIcon={<PlusIcon className="h-5 w-5" aria-hidden="true" />}>
              {t('plants.addPlant')}
            </Button>
          </Link>
        </div>
        {dialogs}

        {!emptyHousehold && !nativeBar && (
          <div className="flex items-center gap-2 large-text:flex-wrap">
            <div className="relative min-w-0 flex-1 large-text:basis-full">
              <MagnifyingGlassIcon
                className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500"
                aria-hidden="true"
              />
              <input
                type="search"
                placeholder={t('plants.list.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input rounded-full pl-10"
                aria-label={t('plants.list.searchLabel')}
              />
            </div>
            <ToolbarMenu
              label={t('plants.list.filter')}
              icon={<AdjustmentsHorizontalIcon className="h-5 w-5" aria-hidden="true" />}
              groups={filterGroups}
              onSelect={onMenu}
            />
            <ToolbarMenu
              label={t('plants.list.more')}
              icon={<EllipsisHorizontalIcon className="h-6 w-6" aria-hidden="true" />}
              groups={moreGroups}
              onSelect={onMenu}
            />
          </div>
        )}

        {tokens.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {tokens.map((token) => (
              <button
                key={token.label}
                type="button"
                onClick={token.clear}
                aria-label={t('plants.list.removeFilter', { label: token.label })}
                className="inline-flex min-h-touch items-center gap-1 rounded-full bg-primary-100 px-3 text-sm font-semibold text-primary-800"
              >
                {token.label}
                <XMarkIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        <p aria-live="polite" className="text-sm text-gray-600 empty:hidden">
          {filterSummary}
        </p>

        {spaceManagerOpen && (
          <div id={SPACE_MANAGER_PANEL_ID} className="space-y-2">
            <SpaceManagerPanel />
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => setSpaceManagerOpen(false)}
            >
              {t('common.done')}
            </Button>
          </div>
        )}

        {view === 'active' && settled && tasksError && (
          <Alert variant="error">{t('plants.list.careUnavailable')}</Alert>
        )}
        {view === 'active' && settled && tasksLoading && (
          <p className="text-sm text-gray-600">{t('plants.list.careLoading')}</p>
        )}

        {listBody ?? (
          <PlantCareList
            sections={sections}
            sectionTitle={(id) =>
              SECTION_KEYS[id]
                ? t(SECTION_KEYS[id])
                : id === 'unplaced'
                  ? unplacedLabel
                  : (spacesById.get(id)?.name ?? unplacedLabel)
            }
            roomLabel={(item) =>
              // Grouped by space, the section heading already says where.
              groupBy === 'room' ? '' : plantLocationLabel(item.plant, spacesById, unplacedLabel)
            }
            showCare={careKnown}
            past={view === 'past'}
            myUserId={myUserId}
            withCuttings={plantsWithCuttings}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={t('plants.list.eyebrow')}
        title={t('plants.title')}
        description={t('plants.list.description')}
        action={
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto large-text:grid large-text:w-full large-text:grid-cols-1">
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
              {t('plants.list.applyTemplate')}
            </Button>
            <Link to="/plants/new" className="block">
              <Button
                className="w-full sm:w-auto"
                leftIcon={<PlusIcon className="h-5 w-5" aria-hidden="true" />}
              >
                {t('plants.addPlant')}
              </Button>
            </Link>
          </div>
        }
      />

      {dialogs}

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
        aria-label={t('plants.list.collection')}
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
            {v === 'active' ? t('plants.list.active') : t('plants.list.past')}
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
            placeholder={t('plants.list.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input pl-10"
            aria-label={t('plants.list.searchLabel')}
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
        <div
          className="flex rounded-md shadow-xs"
          role="group"
          aria-label={t('plants.list.viewMode')}
        >
          {(
            [
              ['grid', Squares2X2Icon, t('plants.list.gridView'), 'rounded-l-md'],
              ['list', ListBulletIcon, t('plants.list.listView'), '-ml-px'],
              ['spaces', MapPinIcon, t('spaces.viewLabel'), '-ml-px rounded-r-md'],
            ] as const
          ).map(([mode, Icon, label, shape]) => (
            <button
              key={mode}
              type="button"
              className={clsx(
                'relative inline-flex items-center min-h-touch min-w-touch justify-center px-3 py-2 text-sm font-medium border focus:z-10 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500',
                shape,
                viewMode === mode
                  ? 'bg-primary-50 text-primary-700 border-primary-500'
                  : 'bg-paper text-gray-700 border-primary-200/70 hover:bg-primary-50'
              )}
              onClick={() => setViewMode(mode)}
              aria-pressed={viewMode === mode}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              <span className="sr-only">{label}</span>
            </button>
          ))}
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
      {listBody ??
        (viewMode === 'grid' ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {filteredPlants!.map((plant) => (
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
                    {plantLocationLabel(plant, spacesById, unplacedLabel)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        ) : viewMode === 'spaces' ? (
          <SpaceBrowseView
            plants={filteredPlants!}
            spaces={spaces}
            tasks={careTasks ?? []}
            members={overviewHousehold?.members}
            latitude={overviewHousehold?.location?.lat}
            tasksLoading={tasksLoading}
            tasksError={tasksError}
            showCareOverview={view === 'active'}
            spacesUnavailable={spacesUnavailable}
          />
        ) : (
          <Card variant="paper" padding="none">
            <ul className="divide-y divide-primary-100/60">
              {filteredPlants!.map((plant) => (
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
                        {[plant.species, plantLocationLabel(plant, spacesById, unplacedLabel)]
                          .filter(Boolean)
                          .join(' • ') || t('plants.list.noDetails')}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}
    </div>
  );
}
