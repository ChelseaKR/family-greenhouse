import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Plant, PlantSpace } from '@/services/plantService';
import { Card } from '@/components/Card';
import { PlantImage } from '@/components/PlantImage';

interface SpaceBrowseViewProps {
  plants: Plant[];
  spaces: PlantSpace[];
}

export function SpaceBrowseView({ plants, spaces }: SpaceBrowseViewProps) {
  const { t } = useTranslation();
  const sections = [
    ...spaces.map((space) => ({
      id: space.id,
      title: space.name,
      environment: space.environment,
      plants: plants.filter((plant) => plant.spaceId === space.id),
    })),
    {
      id: 'unplaced',
      title: t('spaces.unplaced'),
      environment: 'unplaced' as const,
      plants: plants.filter(
        (plant) => !plant.spaceId || !spaces.some((s) => s.id === plant.spaceId)
      ),
    },
  ].filter((section) => section.plants.length > 0);

  return (
    <div className="space-y-8">
      {(['inside', 'outside', 'unplaced'] as const).map((environment) => {
        const groups = sections.filter((section) => section.environment === environment);
        if (groups.length === 0) return null;
        return (
          <section key={environment} aria-labelledby={`space-environment-${environment}`}>
            <h2
              id={`space-environment-${environment}`}
              className="mb-3 font-serif text-2xl text-ink"
            >
              {t(`spaces.${environment}`)}
            </h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {groups.map((group) => (
                <Card key={group.id} variant="paper">
                  <div className="mb-4 flex items-baseline justify-between gap-3">
                    <h3 className="font-semibold text-ink">{group.title}</h3>
                    <span className="text-xs text-gray-600">
                      {t('spaces.plantCount', { count: group.plants.length })}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {group.plants.map((plant) => (
                      <Link
                        key={plant.id}
                        to={`/plants/${plant.id}`}
                        className="group rounded-lg border border-primary-100/70 bg-paper p-2 hover:border-primary-400"
                      >
                        <div className="aspect-square overflow-hidden rounded-md bg-parchment">
                          <PlantImage plant={plant} width={160} height={160} />
                        </div>
                        <p className="mt-2 truncate text-sm font-medium text-ink">{plant.name}</p>
                        {plant.placementNote && (
                          <p className="truncate text-xs text-gray-600">{plant.placementNote}</p>
                        )}
                      </Link>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
