import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  QuestionMarkCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { PublicShell, PageIntro } from '@/components/PublicShell';
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
    // Healthy state renders in the brand green, not stock Tailwind green —
    // "operational" is the page's default mood and should look like us.
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-100 px-2.5 py-0.5 text-xs font-medium text-primary-800">
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
  const overallStatus: ComponentStatus = serverErrored ? 'down' : (data?.status ?? 'ok');

  return (
    <PublicShell>
      <PageIntro
        eyebrow="Health check"
        title="System status"
        lede="Live state of the services that keep Family Greenhouse running."
      />

      {/* Overall banner */}
      {unreachable ? (
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
      <section className="mt-12">
        <h2 className="font-serif text-2xl tracking-tight text-ink">Recent incidents</h2>
        {INCIDENTS.length === 0 ? (
          <p className="mt-4 text-sm text-gray-600">
            {/* During a live outage, "No incidents in the last 90 days"
                  would sit under a red banner and read as a contradiction —
                  the hand-curated list just hasn't caught up yet. */}
            {unreachable
              ? 'Incident history unavailable right now.'
              : serverErrored
                ? 'Details for the current issue will be posted here as we learn more.'
                : 'No incidents in the last 90 days.'}
          </p>
        ) : (
          <ul className="mt-4 space-y-6">
            {INCIDENTS.map((inc, i) => (
              <li
                key={`${inc.date}-${i}`}
                className="rounded-xl border border-primary-100/80 bg-white p-5 shadow-journal"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ${
                      inc.resolved ? 'bg-green-100 text-green-900' : 'bg-amber-100 text-amber-900'
                    }`}
                  >
                    {inc.resolved ? 'Resolved' : 'Investigating'}
                  </span>
                  <span className="text-gray-600">
                    {new Date(inc.date).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>
                <h3 className="mt-2 font-serif text-lg text-ink">{inc.title}</h3>
                <p className="mt-1 text-sm text-gray-700">{inc.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-12 text-xs text-gray-600">
        Status is checked live against <code>GET /health</code> every 60 seconds. For real-time
        reach we recommend bookmarking this page.
      </p>
    </PublicShell>
  );
}
