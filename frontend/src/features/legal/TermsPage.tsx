import { LegalShell } from './LegalShell';
import { useMetaTags } from '@/hooks/useMetaTags';

/**
 * Terms of service. Plain-language, beta-honest. App stores require a
 * public terms URL; this is it.
 *
 * NOT legal advice. Replace with counsel-reviewed copy before any
 * material commercial commitments (paid plans at scale, B2B contracts,
 * EU/UK distribution past the GDPR-relevant threshold).
 */
export function TermsPage() {
  useMetaTags({
    title: 'Terms — Family Greenhouse',
    description: 'The terms of using Family Greenhouse. Plain language.',
  });

  return (
    <LegalShell title="Terms of Service" effectiveDate="April 25, 2026">
      <p className="lead">
        These terms govern your use of Family Greenhouse. We&rsquo;ve kept them readable. If
        anything is unclear, email{' '}
        <a href="mailto:hello@family-greenhouse.example">hello@family-greenhouse.example</a> and
        we&rsquo;ll explain.
      </p>

      <h2>The agreement</h2>
      <p>
        By creating an account or using the service, you agree to these terms. If you don&rsquo;t
        agree, don&rsquo;t use the service. Material changes will be announced in-app with at least
        14 days&rsquo; notice; continued use after that is acceptance of the new terms.
      </p>

      <h2>What you can expect from us</h2>
      <ul>
        <li>
          <strong>The service, as described.</strong> We try to keep the app available, accurate,
          and free of basic bugs. We don&rsquo;t promise zero downtime; see <em>Limitations</em>{' '}
          below.
        </li>
        <li>
          <strong>Your data, treated with care.</strong> See our{' '}
          <a href="/legal/privacy">Privacy Policy</a> for the specifics.
        </li>
        <li>
          <strong>Reasonable notice before changes.</strong> Pricing, plan limits, and material
          features are stable for at least 14 days from announcement. Bug fixes and improvements
          ship continuously.
        </li>
        <li>
          <strong>Honest billing.</strong> Paid plans are billed via Stripe. You can cancel any time
          from <em>Settings → Billing</em>; the plan stays active until the end of the current
          period. We don&rsquo;t auto-upgrade you out of free.
        </li>
      </ul>

      <h2>What we expect from you</h2>
      <ul>
        <li>
          <strong>Don&rsquo;t abuse the service.</strong> No spam-running through the API, no
          scraping, no attempts to break authentication or DDoS the service.
        </li>
        <li>
          <strong>Don&rsquo;t upload illegal content.</strong> Plant photos are fine. Anything that
          violates law or third-party rights is not.
        </li>
        <li>
          <strong>Be honest about who you are.</strong> Use a real email. Don&rsquo;t impersonate
          someone else.
        </li>
        <li>
          <strong>Respect your housemates.</strong> When you invite others to a household, they can
          see and edit shared plant data. Don&rsquo;t invite people who shouldn&rsquo;t see it.
        </li>
      </ul>

      <h2>Account termination</h2>
      <p>
        You can delete your account at any time from <em>Settings → Account → Delete my account</em>
        . We can suspend or terminate accounts that violate these terms; we&rsquo;ll try to give you
        a chance to fix the issue first unless the violation is serious (e.g. abuse of other users).
      </p>

      <h2>Pricing &amp; plans</h2>
      <p>
        Current plans: Seedling (free, up to 10 plants), Garden ($4.99/month), Greenhouse
        ($9.99/month). Plan limits and prices may change with 14 days&rsquo; notice. We will not
        retroactively bill or charge you for existing usage above a new free-tier cap; instead,
        you&rsquo;ll be unable to add new plants/members until you upgrade or trim back.
      </p>
      <p>
        Refunds: monthly subscriptions aren&rsquo;t pro-rated on cancel. If you&rsquo;ve been billed
        by mistake or our service was seriously broken for you, email us; we&rsquo;ll make it right.
      </p>

      <h2>Limitations</h2>
      <p>
        The service is provided &ldquo;as is.&rdquo; We aim for high availability but do not promise
        zero downtime, zero data loss, or that every feature will work in every browser at every
        moment. Our liability is limited to the amount you&rsquo;ve paid us in the previous 12
        months — for free-tier users, that&rsquo;s zero.
      </p>
      <p>
        We don&rsquo;t give plant-care advice as a regulated service — the suggestions come from
        public botanical databases plus simple heuristics. If a plant matters to you (heirloom,
        expensive, sentimental), don&rsquo;t rely on our reminders alone.
      </p>

      <h2>Disputes</h2>
      <p>
        If something goes wrong, please email us first. We&rsquo;ll try to resolve it directly.
        Formal disputes are governed by the laws of the State of California, USA, and resolved in
        San Francisco County courts.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        Material changes get 14 days of notice in-app. Minor edits (typos, clarifications,
        additional examples) are made directly and reflected in the effective date at the top.
      </p>

      <p className="text-sm text-gray-500 mt-12">
        We&rsquo;re a small team with no in-house counsel today. These terms are best-effort
        plain-language and may not cover every edge case the way a fully lawyered document would.
        Email us for anything ambiguous.
      </p>
    </LegalShell>
  );
}
