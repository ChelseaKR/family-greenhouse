import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ExclamationTriangleIcon,
  InformationCircleIcon,
  MapPinIcon,
} from '@heroicons/react/24/outline';
import { Card } from '@/components/Card';
import { climateService } from '@/services/climateService';
import { useAuthStore } from '@/store/authStore';
import { EmptyClimate } from '@/components/illustrations/EmptyClimate';

/**
 * Dashboard card surfacing local weather + derived care tips for the active
 * household. Suppresses entirely when:
 *   - no household is active
 *   - the integration is disabled (no OPENWEATHER_API_KEY) AND no location
 *     is saved (no value in nudging)
 *
 * When a location is saved but the integration is disabled, we still show
 * the card with a small "climate insights are off" hint so the user knows
 * their saved city isn't doing anything yet.
 */
export function ClimateCard() {
  const householdId = useAuthStore((s) => s.user?.householdId);

  const { data, isLoading } = useQuery({
    queryKey: ['household', householdId, 'climate'],
    queryFn: () => climateService.getClimate(householdId!),
    enabled: !!householdId,
    staleTime: 30 * 60 * 1000,
  });

  if (!householdId || isLoading) return null;
  if (!data) return null;

  const hasLocation = !!data.location;

  // No location and integration disabled = nothing useful to render.
  if (!hasLocation && !data.configured) return null;

  if (!hasLocation) {
    return (
      <Card>
        <div className="flex items-center gap-4">
          <EmptyClimate className="h-20 w-auto flex-shrink-0" />
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Local climate</h3>
            <p className="mt-1 text-sm text-gray-600">
              Set a household location to get climate-aware care tips — humidity warnings, freeze
              alerts, and skip-watering nudges.
            </p>
            <Link
              to="/household"
              className="mt-2 inline-block text-sm font-medium text-primary-700 hover:underline"
            >
              Add household location →
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1">
            <MapPinIcon className="h-4 w-4 text-gray-500" aria-hidden="true" />
            {data.location?.city}
          </h3>
          {data.weather ? (
            <p className="mt-1 text-sm text-gray-600">
              {Math.round(data.weather.tempC)}°C · {Math.round(data.weather.humidity)}% humidity
              {data.weather.description && ` · ${data.weather.description}`}
            </p>
          ) : (
            <p className="mt-1 text-sm text-gray-500">
              {data.configured
                ? 'Weather data temporarily unavailable.'
                : 'Climate insights are off. Add an OpenWeatherMap key to enable.'}
            </p>
          )}
        </div>
      </div>

      {data.tips.length > 0 && (
        <ul className="mt-4 space-y-2">
          {data.tips.map((tip, i) => (
            <li
              key={i}
              className={
                tip.level === 'warning'
                  ? 'flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900'
                  : 'flex items-start gap-2 rounded-md border border-gray-200 bg-gray-50 p-2 text-sm text-gray-700'
              }
            >
              {tip.level === 'warning' ? (
                <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
              ) : (
                <InformationCircleIcon className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
              )}
              <span>{tip.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
