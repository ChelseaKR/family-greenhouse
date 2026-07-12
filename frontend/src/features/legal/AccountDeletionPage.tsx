import { Link } from 'react-router-dom';
import { LegalShell } from './LegalShell';
import { useMetaTags } from '@/hooks/useMetaTags';
import { useAuthStore } from '@/store/authStore';

/** Public, stable URL for Google Play's account-deletion web-link field. */
export function AccountDeletionPage() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  useMetaTags({
    title: 'Delete your account — Family Greenhouse',
    description: 'How to permanently delete a Family Greenhouse account and associated data.',
  });

  return (
    <LegalShell title="Delete your account" effectiveDate="July 12, 2026">
      <p className="lead">
        You can permanently delete your Family Greenhouse account in the app, even if you have not
        created or joined a household.
      </p>
      <h2>Delete it yourself</h2>
      <ol>
        <li>{isAuthenticated ? 'Open Account & data.' : 'Sign in to your account.'}</li>
        <li>
          Select <strong>Delete my account</strong>.
        </li>
        <li>Confirm the permanent deletion.</li>
      </ol>
      <p>
        <Link to={isAuthenticated ? '/account' : '/login'}>
          {isAuthenticated ? 'Open Account & data' : 'Sign in to delete your account'}
        </Link>
      </p>
      <h2>Ask us to delete it</h2>
      <p>
        If you cannot sign in, email{' '}
        <a href="mailto:support@familygreenhouse.net?subject=Account%20deletion%20request">
          support@familygreenhouse.net
        </a>{' '}
        from the address on your account. We may ask you to verify ownership before deleting it and
        will respond within 30 days.
      </p>
      <h2>What deletion does</h2>
      <p>
        We remove your login, household memberships, notification preferences, browser push
        subscriptions, and native-device notification tokens. Plants from a household where you were
        the only member are deleted. Shared care history that other members rely on may remain, but
        your name and account id are replaced with &ldquo;Former member.&rdquo; Care-assistant
        conversations expire automatically after 30 days; submitted safety reports expire after 90
        days.
      </p>
    </LegalShell>
  );
}
