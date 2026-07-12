import { Link } from 'react-router-dom';
import { LegalShell } from './LegalShell';
import { useMetaTags } from '@/hooks/useMetaTags';

/** Public support URL used by both store listings and app review. */
export function SupportPage() {
  useMetaTags({
    title: 'Support — Family Greenhouse',
    description: 'Get help with your Family Greenhouse account and plant-care workspace.',
  });

  return (
    <LegalShell title="Support" effectiveDate="July 12, 2026">
      <p className="lead">
        Need help with Family Greenhouse? Email{' '}
        <a href="mailto:support@familygreenhouse.net">support@familygreenhouse.net</a>. Include the
        device type and a short description of what happened, but never send a password or sign-in
        code.
      </p>
      <h2>Account and privacy</h2>
      <p>
        You can change your password, export your data, or delete your account from Account &amp;
        data. If you cannot sign in, see the public{' '}
        <Link to="/account-deletion">deletion guide</Link>.
      </p>
      <h2>Plant-care help</h2>
      <p>
        Signed-in users can open Help inside the app for guidance on plants, tasks, reminders,
        households, and troubleshooting.
      </p>
      <h2>Service status</h2>
      <p>
        Check the <Link to="/status">service status page</Link> if login, syncing, or uploads appear
        unavailable.
      </p>
    </LegalShell>
  );
}
