import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  PlusIcon,
  MagnifyingGlassIcon,
  Squares2X2Icon,
  ListBulletIcon,
  ClipboardDocumentListIcon,
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
import { BulkApplyTemplateDialog } from './BulkApplyTemplateDialog';
import { PlantImage } from '@/components/PlantImage';

type ViewMode = 'grid' | 'list';

export function PlantsPage() {
  useDocumentTitle('Plants');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);

  const {
    data: plants,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['plants'],
    queryFn: plantService.getPlants,
  });

  const filteredPlants = plants?.filter(
    (plant) =>
      plant.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      plant.species?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      plant.location?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Greenhouse"
        title="Plants"
        description="Manage your household plants."
        action={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setBulkOpen(true)}
              leftIcon={<ClipboardDocumentListIcon className="h-5 w-5" aria-hidden="true" />}
            >
              Apply template
            </Button>
            <Link to="/plants/new">
              <Button leftIcon={<PlusIcon className="h-5 w-5" aria-hidden="true" />}>
                Add plant
              </Button>
            </Link>
          </div>
        }
      />

      <BulkApplyTemplateDialog isOpen={bulkOpen} onClose={() => setBulkOpen(false)} />

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
        <div className="flex rounded-md shadow-sm" role="group" aria-label="View mode">
          <button
            type="button"
            className={clsx(
              'relative inline-flex items-center rounded-l-md min-h-touch min-w-touch justify-center px-3 py-2 text-sm font-medium border focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
              viewMode === 'grid'
                ? 'bg-primary-50 text-primary-700 border-primary-500'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
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
              'relative -ml-px inline-flex items-center rounded-r-md min-h-touch min-w-touch justify-center px-3 py-2 text-sm font-medium border focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
              viewMode === 'list'
                ? 'bg-primary-50 text-primary-700 border-primary-500'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            )}
            onClick={() => setViewMode('list')}
            aria-pressed={viewMode === 'list'}
          >
            <ListBulletIcon className="h-5 w-5" aria-hidden="true" />
            <span className="sr-only">List view</span>
          </button>
        </div>
      </div>

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
        ) : (
          <EmptyState
            icon={<EmptyPlants className="mx-auto h-40 w-auto" />}
            title="No plants yet"
            description="Add your first plant to get started tracking care."
            action={
              <Link to="/plants/new">
                <Button>Add your first plant</Button>
              </Link>
            }
          />
        )
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filteredPlants.map((plant) => (
            <Link
              key={plant.id}
              to={`/plants/${plant.id}`}
              className="group block rounded-xl border border-primary-100/70 bg-paper overflow-hidden shadow-journal hover:border-primary-400 hover:shadow-journal-hover transition-all motion-safe:animate-fade-in"
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
                <p className="text-sm font-medium text-ink truncate">{plant.name}</p>
                {plant.species && (
                  <p className="text-xs text-gray-500 truncate italic">{plant.species}</p>
                )}
                {plant.location && (
                  <p className="text-xs text-gray-500 truncate mt-1">{plant.location}</p>
                )}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Card variant="paper" padding="none">
          <ul className="divide-y divide-primary-100/60">
            {filteredPlants.map((plant) => (
              <li key={plant.id}>
                <Link
                  to={`/plants/${plant.id}`}
                  className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-parchment/60"
                >
                  <div className="h-12 w-12 rounded-lg bg-parchment overflow-hidden flex-shrink-0 ring-1 ring-primary-100/60">
                    <PlantImage plant={plant} width={48} height={48} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink">{plant.name}</p>
                    <p className="text-sm text-gray-600">
                      {[plant.species, plant.location].filter(Boolean).join(' • ') || 'No details'}
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
