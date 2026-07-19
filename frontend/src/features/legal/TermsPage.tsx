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
    <LegalShell title="Terms of Service" effectiveDate="July 19, 2026">
      <p className="lead">
        These terms govern your use of Family Greenhouse. We&rsquo;ve kept them readable. If
        anything is unclear, email{' '}
        <a href="mailto:hello@familygreenhouse.net">hello@familygreenhouse.net</a> and we&rsquo;ll
        explain.
      </p>

      <h2>The agreement</h2>
      <p>
        By creating an account or using the service, you agree to these terms. If you don&rsquo;t
        agree, don&rsquo;t use the service. Material changes will be announced in-app with at least
        14 days&rsquo; notice; continued use after that is acceptance of the new terms.
      </p>

      <h2>Who may use the service</h2>
      <p>
        You must be at least 13 years old to create an account or accept a household invitation. If
        you are under the age of legal majority where you live, use the service only with permission
        from a parent or legal guardian. A parent or guardian who believes a child under 13 created
        an account can email{' '}
        <a href="mailto:support@familygreenhouse.net">support@familygreenhouse.net</a> to have it
        deleted.
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
          <strong>Reasonable notice before changes.</strong> Material features and usage limits are
          stable for at least 14 days from announcement. Bug fixes and improvements ship
          continuously.
        </li>
        <li>
          <strong>Free registration, no payment collection.</strong> Family Greenhouse currently
          accepts free accounts for up to 10 plants. It does not offer paid plans or create new
          Checkout or billing-portal sessions.
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

      <h2>Plan status</h2>
      <p>
        Free account registration is open. Paid-plan offers, purchases, upgrades, and plan changes
        are paused. Historical tier and billing code remains in the project as implementation
        documentation, but it is not a current offer. If you believe an earlier test or billing
        event affected you, email us so it can be investigated and resolved directly.
      </p>

      <h2>Limitations</h2>
      <p>
        The service is provided &ldquo;as is.&rdquo; We aim for high availability but do not promise
        zero downtime, zero data loss, or that every feature will work in every browser at every
        moment. Our liability is limited to the amount you&rsquo;ve paid us in the previous 12
        months; paid activity is paused, so the hosted service currently accepts no payments.
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
