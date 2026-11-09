import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useTranslation } from 'react-i18next';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  QuestionMarkCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { useMetaTags } from '@/hooks/useMetaTags';
import { IncidentLog, type Incident } from './IncidentLog';
import { healthService, type ComponentStatus, type OverallStatus } from '@/services/healthService';

/**
 * Public status page. Pulls /health every 60s and surfaces component-by-
 * component state plus a recent-incident log. Hand-curated incidents for
 * now (a real status page like Statuspage.io would be overkill until
 * traffic justifies). Adding an incident: add it to INCIDENTS below, newest
 * first, with its copy in the en and es catalogs under statusPage.incidents.
 *
 * Design intent: trust signal, not an SLA dashboard. We're transparent
 * about the small number of services we run; we're not making 99.99%
 * uptime promises.
 */

const INCIDENTS: Incident[] = [
  {
    date: '2026-09-04',
    resolved: true,
    titleKey: 'statusPage.incidents.plantTags2026.title',
    bodyKey: 'statusPage.incidents.plantTags2026.body',
  },
];

const COMPONENT_LABELS: Record<string, string> = {
  database: 'Database (DynamoDB)',
  auth: 'Authentication (Cognito)',
  mail: 'Email + SMS (SES / SNS)',
};

function StatusPill({ status }: { status: ComponentStatus }) {
  const { t } = useTranslation();

  if (status === 'ok') {
    // Healthy state renders in the brand green, not stock Tailwind green —
    // "operational" is the page's default mood and should look like us.
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-100 px-2.5 py-0.5 text-xs font-medium text-primary-800">
        <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
        Operational
      </span>
    );
  }
  if (status === 'unknown') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-parchment px-2.5 py-0.5 text-xs font-medium text-gray-700">
        <QuestionMarkCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {t('statusPage.notActivelyChecked')}
      </span>
    );
  }
  if (status === 'degraded') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
        <ExclamationTriangleIcon className="h-3.5 w-3.5" aria-hidden="true" />
        Degraded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">
      <XCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
      Down
    </span>
  );
}

export function StatusPage() {
  const { t } = useTranslation();

  useMetaTags({
    title: 'Status — Family Greenhouse',
    description:
      "Live status for Family Greenhouse's database, sign-in, and email/SMS delivery, checked every 60 seconds, plus a log of past incidents.",
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['status', 'health'],
    queryFn: healthService.check,
    refetchInterval: 60_000,
    retry: 1,
  });

  // Two very different failures share `isError`. If /health answered with an
  // HTTP error, the API is genuinely unhealthy — show red. If the request
  // never got a response (offline, VPN, ad blocker, DNS), that says nothing
  // about the API, only that this browser couldn't reach it — so don't claim
  // an outage we have no evidence for.
  const serverErrored = isError && isAxiosError(error) && error.response != null;
  const unreachable = isError && !serverErrored;
  const checking = isLoading && !data;
  // The healthy state requires a successful response. Never paint the page
  // green during the initial request just because no error has arrived yet.
  const overallStatus: OverallStatus = serverErrored ? 'down' : (data?.status ?? 'down');

  return (
    <PublicShell>
      <PageIntro
        eyebrow="Health check"
        title="System status"
        lede="Live state of the services that keep Family Greenhouse running."
      />

      {/* Overall banner */}
      {checking ? (
        <div className="mt-8 rounded-lg border border-primary-100 bg-white p-5" role="status">
          <div className="flex items-center gap-3">
            <QuestionMarkCircleIcon className="h-6 w-6 text-gray-500" aria-hidden="true" />
            <p className="font-serif text-xl text-ink">{t('statusPage.checkingTitle')}</p>
          </div>
          <p className="mt-2 text-sm text-gray-600">{t('statusPage.checkingBody')}</p>
        </div>
      ) : unreachable ? (
        <div className="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-5">
          <div className="flex items-center gap-3">
            <QuestionMarkCircleIcon className="h-6 w-6 text-amber-600" aria-hidden="true" />
            <p className="font-serif text-xl text-amber-900">
              Can&rsquo;t reach the status API from your network
            </p>
          </div>
          <p className="mt-2 text-sm text-amber-900">
            This page checks <code>GET /health</code> from your browser, and that request got no
            response. That can mean our API is down, but it can also be your connection, a VPN, or
            an ad blocker. Try reloading, or check from another network.
          </p>
          {data?.checkedAt && (
            <p className="mt-2 text-xs text-gray-600">
              Last successful check {new Date(data.checkedAt).toLocaleString()}.
            </p>
          )}
        </div>
      ) : (
        <div
          className={`mt-8 rounded-lg border p-5 ${
            overallStatus === 'ok'
              ? 'border-primary-200 bg-primary-50'
              : overallStatus === 'degraded'
                ? 'border-amber-200 bg-amber-50'
                : 'border-red-200 bg-red-50'
          }`}
        >
          <div className="flex items-center gap-3">
            {overallStatus === 'ok' && (
              <CheckCircleIcon className="h-6 w-6 text-primary-700" aria-hidden="true" />
            )}
            {overallStatus === 'degraded' && (
              <ExclamationTriangleIcon className="h-6 w-6 text-amber-600" aria-hidden="true" />
            )}
            {overallStatus === 'down' && (
              <XCircleIcon className="h-6 w-6 text-red-600" aria-hidden="true" />
            )}
            <p
              className={`font-serif text-xl ${
                overallStatus === 'ok'
                  ? 'text-primary-900'
                  : overallStatus === 'degraded'
                    ? 'text-amber-900'
                    : 'text-red-900'
              }`}
            >
              {overallStatus === 'ok' && t('statusPage.coreApiOperational')}
              {overallStatus === 'degraded' && 'Some systems degraded'}
              {overallStatus === 'down' && 'We are investigating an issue'}
            </p>
          </div>
          {data?.checkedAt && (
            <p className="mt-2 text-xs text-gray-600">
              Last checked {new Date(data.checkedAt).toLocaleString()}.
            </p>
          )}
        </div>
      )}

      {/* Component breakdown */}
      <section className="mt-10">
        <h2 className="font-serif text-2xl tracking-tight text-ink">Components</h2>
        {isLoading ? (
          <p className="mt-4 text-sm text-gray-600">Checking…</p>
        ) : (
          <ul className="mt-4 divide-y divide-primary-100/60 rounded-xl border border-primary-100/80 bg-white shadow-journal">
            {data &&
              Object.entries(data.components).map(([key, info]) => (
                <li key={key} className="flex items-center justify-between gap-4 px-5 py-4">
                  <span className="text-sm font-medium text-gray-900">
                    {COMPONENT_LABELS[key] ?? key}
                  </span>
                  <StatusPill status={info.status} />
                </li>
              ))}
            {!data && (
              <li className="flex items-center justify-between gap-4 px-5 py-4">
                <span className="text-sm font-medium text-gray-900">API</span>
                {unreachable ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-parchment px-2.5 py-0.5 text-xs font-medium text-gray-700">
                    <QuestionMarkCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    No response
                  </span>
                ) : (
                  <StatusPill status="down" />
                )}
              </li>
            )}
          </ul>
        )}
      </section>

      {/* Incidents */}
      <IncidentLog incidents={INCIDENTS} unreachable={unreachable} serverErrored={serverErrored} />

      <p className="mt-12 text-xs text-gray-600">
        Status is checked live against <code>GET /health</code> every 60 seconds. For real-time
        reach we recommend bookmarking this page.
      </p>
    </PublicShell>
  );
}
