import { LegalShell } from './LegalShell';
import { useMetaTags } from '@/hooks/useMetaTags';

/**
 * Privacy policy. Honest, plain-language version — not the
 * boilerplate-from-a-template variety. Tracks our actual data practices:
 * what we collect, why, who we share with, and the user's rights. Updates
 * here should bump the effective date and surface a banner on first
 * login (TODO: not built yet).
 *
 * App-store reviewers (Apple/Google) expect a public privacy URL; this
 * is it. Keep the language readable enough that a non-lawyer can
 * understand what they're agreeing to.
 */
export function PrivacyPage() {
  useMetaTags({
    title: 'Privacy — Family Greenhouse',
    description: 'How Family Greenhouse handles your data. Plain language.',
  });

  return (
    <LegalShell title="Privacy" effectiveDate="April 25, 2026">
      <p className="lead">
        This page explains what data Family Greenhouse collects, why, and what you can do about it.
        We&rsquo;ve deliberately written it as plain text rather than a template — if anything is
        unclear, email{' '}
        <a href="mailto:hello@family-greenhouse.example">hello@family-greenhouse.example</a> and
        we&rsquo;ll fix the wording.
      </p>

      <h2>What we collect</h2>
      <p>To run the app, we collect:</p>
      <ul>
        <li>
          <strong>Account info</strong> — email, password (hashed), and display name. Stored in AWS
          Cognito.
        </li>
        <li>
          <strong>Plant + task data</strong> — every plant, task, and completion you record, along
          with photos you upload. Stored in AWS DynamoDB and S3 in a US region (us-east-1).
        </li>
        <li>
          <strong>Optional household location</strong> — only if you set one. Used to fetch local
          weather for climate-aware care tips. We store the city name and the geocoded coordinates
          we got back from the geocoder; we do not request precise device geolocation.
        </li>
        <li>
          <strong>Optional phone number</strong> — only if you opt in to SMS reminders.
        </li>
      </ul>

      <p>If you opt in to product analytics, we also collect:</p>
      <ul>
        <li>
          A pseudonymous &ldquo;distinct id&rdquo; (your Cognito user id, a UUID — not your email or
          name) plus a small set of typed lifecycle events: signup, household created, plant added,
          task completed, etc. We do not capture page views, autocapture clicks, or session
          recordings. The full event list is in our repo at <code>docs/analytics.md</code>.
        </li>
      </ul>
      <p>
        Browsers that send <code>DNT: 1</code> have analytics suppressed automatically.
      </p>

      <h2>Who else sees your data</h2>
      <p>The third parties involved in running the service:</p>
      <ul>
        <li>
          <strong>AWS</strong> — hosts our database, file storage, authentication, email, SMS, and
          serverless functions. Bound by their{' '}
          <a href="https://aws.amazon.com/compliance/data-privacy/">Data Privacy</a> commitments.
        </li>
        <li>
          <strong>Stripe</strong> — handles paid subscriptions. We never see your card number;
          Stripe gives us back a customer id we store for billing flows.
        </li>
        <li>
          <strong>Plant.id</strong> (optional, only if you use plant identification) — receives the
          plant photo you upload for identification.
        </li>
        <li>
          <strong>Perenual</strong> (optional, only when species enrichment is enabled) — receives
          only species names (a public botanical fact, not your data).
        </li>
        <li>
          <strong>OpenWeatherMap</strong> (optional, only when you set a household location) —
          receives your saved city name and the coordinates we got back from geocoding.
        </li>
        <li>
          <strong>PostHog</strong> (optional, when analytics is enabled) — receives the events
          listed above with your pseudonymous distinct id.
        </li>
      </ul>
      <p>
        We do not sell your data. We do not run ad networks. We do not share your plant care data
        with anyone outside the household members you&rsquo;ve invited.
      </p>

      <h2>Household sharing</h2>
      <p>
        When you join a household (yours or someone else&rsquo;s), the other members can see the
        plants, tasks, completions, and activity in that household. They can see your display name
        and which tasks you&rsquo;ve completed. They cannot see your email, phone number, or
        notification preferences.
      </p>

      <h2>Your rights</h2>
      <ul>
        <li>
          <strong>Export.</strong> Download all your plants and tasks as CSV from{' '}
          <em>Settings → Account → Download my data</em>.
        </li>
        <li>
          <strong>Delete.</strong> The <em>Delete account</em> button in Settings wipes your login
          and removes you from every household you&rsquo;re a member of. Past activity events keep
          your display name as a historical artifact (so &ldquo;Sarah watered the monstera&rdquo;
          doesn&rsquo;t become &ldquo;[deleted user] watered the monstera&rdquo; in your
          housemate&rsquo;s feed) — this is documented in <code>docs/profile.md</code>.
        </li>
        <li>
          <strong>Access / correction.</strong> Email{' '}
          <a href="mailto:privacy@family-greenhouse.example">privacy@family-greenhouse.example</a>{' '}
          and we&rsquo;ll respond within 30 days. We&rsquo;re a small team; this is the same person
          you&rsquo;d talk to about any other support issue.
        </li>
      </ul>

      <h2>Children</h2>
      <p>
        The service is not intended for users under 13. We don&rsquo;t knowingly collect data from
        anyone in that age range. If you&rsquo;re a parent and you think your child created an
        account, email{' '}
        <a href="mailto:privacy@family-greenhouse.example">privacy@family-greenhouse.example</a> and
        we&rsquo;ll delete the account.
      </p>

      <h2>Changes</h2>
      <p>
        When we update this policy, we&rsquo;ll bump the effective date at the top and (for material
        changes) show a one-time banner in the app. The full revision history lives in our repo.
      </p>
    </LegalShell>
  );
}
