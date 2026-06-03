import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircleIcon, ExclamationTriangleIcon, XCircleIcon } from '@heroicons/react/24/outline';
import { BrandMark } from '@/components/BrandMark';
import { Footer } from '@/components/Footer';
import { useMetaTags } from '@/hooks/useMetaTags';
import { healthService, type ComponentStatus } from '@/services/healthService';

/**
 * Public status page. Pulls /health every 60s and surfaces component-by-
 * component state plus a recent-incident log. Hand-curated incidents for
 * now (a real status page like Statuspage.io would be overkill until
 * traffic justifies). Adding an incident: append to INCIDENTS below.
 *
 * Design intent: trust signal, not an SLA dashboard. We're transparent
 * about the small number of services we run; we're not making 99.99%
 * uptime promises.
 */

const INCIDENTS: Array<{ date: string; title: string; resolved: boolean; body: string }> = [
  // No incidents yet — leave the array empty rather than fake history.
  // {
  //   date: '2026-04-12',
  //   title: 'Plant photo uploads delayed (resolved)',
  //   resolved: true,
  //   body: 'S3 multipart uploads in us-east-1 saw elevated latency for ~30 min …',
  // },
];

const COMPONENT_LABELS: Record<string, string> = {
  database: 'Database (DynamoDB)',
  auth: 'Authentication (Cognito)',
  mail: 'Email + SMS (SES / SNS)',
};

function StatusPill({ status }: { status: ComponentStatus }) {
  if (status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
        <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
        Operational
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
  useMetaTags({
    title: 'Status — Family Greenhouse',
    description: 'Current operational status of Family Greenhouse and recent incidents.',
  });

  const { data, isLoading, isError } = useQuery({
    queryKey: ['status', 'health'],
    queryFn: healthService.check,
    refetchInterval: 60_000,
    retry: 1,
  });

  const overallStatus: ComponentStatus = isError ? 'down' : (data?.status ?? 'ok');

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-gray-200">
        <nav className="mx-auto max-w-3xl flex items-center justify-between p-6">
          <Link to="/" aria-label="Family Greenhouse home">
            <BrandMark variant="wordmark" size="sm" />
          </Link>
          <Link to="/" className="text-sm font-medium text-primary-700 hover:underline">
            Try the app →
          </Link>
        </nav>
      </header>

      <main className="flex-1 mx-auto max-w-3xl w-full px-6 py-16">
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
          System status
        </h1>
        <p className="mt-3 text-lg text-gray-600">
          Live state of the services that keep Family Greenhouse running.
        </p>

        {/* Overall banner */}
        <div
          className={`mt-8 rounded-lg border p-5 ${
            overallStatus === 'ok'
              ? 'border-green-200 bg-green-50'
              : overallStatus === 'degraded'
                ? 'border-amber-200 bg-amber-50'
                : 'border-red-200 bg-red-50'
          }`}
        >
          <div className="flex items-center gap-3">
            {overallStatus === 'ok' && (
              <CheckCircleIcon className="h-6 w-6 text-green-600" aria-hidden="true" />
            )}
            {overallStatus === 'degraded' && (
              <ExclamationTriangleIcon className="h-6 w-6 text-amber-600" aria-hidden="true" />
            )}
            {overallStatus === 'down' && (
              <XCircleIcon className="h-6 w-6 text-red-600" aria-hidden="true" />
            )}
            <p
              className={`font-display text-xl font-semibold ${
                overallStatus === 'ok'
                  ? 'text-green-900'
                  : overallStatus === 'degraded'
                    ? 'text-amber-900'
                    : 'text-red-900'
              }`}
            >
              {overallStatus === 'ok' && 'All systems operational'}
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

        {/* Component breakdown */}
        <section className="mt-10">
          <h2 className="font-serif text-2xl font-semibold tracking-tight text-gray-900">
            Components
          </h2>
          {isLoading ? (
            <p className="mt-4 text-sm text-gray-500">Checking…</p>
          ) : (
            <ul className="mt-4 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
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
                  <StatusPill status="down" />
                </li>
              )}
            </ul>
          )}
        </section>

        {/* Incidents */}
        <section className="mt-12">
          <h2 className="font-serif text-2xl font-semibold tracking-tight text-gray-900">
            Recent incidents
          </h2>
          {INCIDENTS.length === 0 ? (
            <p className="mt-4 text-sm text-gray-600">No incidents in the last 90 days.</p>
          ) : (
            <ul className="mt-4 space-y-6">
              {INCIDENTS.map((inc, i) => (
                <li
                  key={`${inc.date}-${i}`}
                  className="rounded-lg border border-gray-200 bg-white p-5"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`rounded-full px-2 py-0.5 font-medium ${
                        inc.resolved ? 'bg-green-100 text-green-900' : 'bg-amber-100 text-amber-900'
                      }`}
                    >
                      {inc.resolved ? 'Resolved' : 'Investigating'}
                    </span>
                    <span className="text-gray-500">
                      {new Date(inc.date).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>
                  <h3 className="mt-2 font-display text-lg font-semibold text-gray-900">
                    {inc.title}
                  </h3>
                  <p className="mt-1 text-sm text-gray-700">{inc.body}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-12 text-xs text-gray-500">
          Status is checked live against <code>GET /health</code> every 60 seconds. For real-time
          reach we recommend bookmarking this page.
        </p>
      </main>

      <Footer />
    </div>
  );
}
