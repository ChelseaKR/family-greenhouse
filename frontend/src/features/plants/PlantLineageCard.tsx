import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Card, CardHeader } from '@/components/Card';
import type { PlantLineage, PlantStatus } from '@/services/plantService';

/** Small lifecycle badge, matching the header badges on PlantDetailPage. */
export function PlantStatusBadge({ status }: { status: PlantStatus }) {
  const { t } = useTranslation();
  if (status === 'died') {
    return (
      <span className="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700">
        {t('plants.status.died')}
      </span>
    );
  }
  if (status === 'gave_away') {
    return (
      <span className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-900 ring-1 ring-sky-200/70">
        {t('plants.status.gaveAway')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-800">
      {t('plants.status.active')}
    </span>
  );
}

function formatDate(dateString: string): string {
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

interface PlantLineageCardProps {
  lineage?: PlantLineage;
}

/**
 * Propagation family tree for the plant detail page: a link up to the
 * parent the cutting came from, and the list of cuttings taken from this
 * plant. Died cuttings render muted but are deliberately NOT hidden —
 * propagation history is the point of the feature.
 *
 * Renders nothing for plants with no lineage at all, so the detail page
 * stays uncluttered for the common case.
 */
export function PlantLineageCard({ lineage }: PlantLineageCardProps) {
  const { t } = useTranslation();

  if (!lineage || (!lineage.parent && lineage.children.length === 0)) {
    return null;
  }

  return (
    <Card>
      <CardHeader title={t('plants.lineage.title')} description={t('plants.lineage.description')} />
      <div className="space-y-4">
        {lineage.parent && (
          <div data-testid="lineage-parent">
            <dt className="text-sm font-medium text-gray-500">{t('plants.lineage.parentLabel')}</dt>
            <dd className="mt-1 flex items-center gap-2 text-sm">
              <span aria-hidden="true">🌿</span>
              <Link
                to={`/plants/${lineage.parent.id}`}
                className="font-medium text-primary-700 hover:text-primary-600 hover:underline"
              >
                {lineage.parent.name}
              </Link>
              <PlantStatusBadge status={lineage.parent.status} />
            </dd>
          </div>
        )}

        {lineage.children.length > 0 && (
          <div data-testid="lineage-children">
            <dt className="text-sm font-medium text-gray-500">
              {t('plants.lineage.childrenLabel')} (
              {t('plants.lineage.childrenCount', { count: lineage.children.length })})
            </dt>
            <ul className="mt-1 divide-y divide-gray-100">
              {lineage.children.map((child) => (
                <li
                  key={child.id}
                  className={clsx(
                    'flex items-center justify-between gap-3 py-2 text-sm',
                    // Muted, not hidden: a died cutting is still part of the
                    // propagation story.
                    child.status === 'died' && 'opacity-60'
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden="true">🌱</span>
                    <Link
                      to={`/plants/${child.id}`}
                      className="truncate font-medium text-primary-700 hover:text-primary-600 hover:underline"
                    >
                      {child.name}
                    </Link>
                    <PlantStatusBadge status={child.status} />
                  </span>
                  <span className="flex-shrink-0 text-xs text-gray-600">
                    {formatDate(child.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
