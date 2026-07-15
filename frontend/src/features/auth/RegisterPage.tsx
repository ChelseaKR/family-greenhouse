import { Link } from 'react-router-dom';
import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { AuthShell } from './AuthShell';

/**
 * Stable /register route with no registration form or mutation path.
 * Reactivation intentionally requires restoring a reviewed form in addition
 * to changing the shared status and Cognito policy.
 */
export function RegisterPage() {
  useDocumentTitle('Demo status');

  return (
    <AuthShell
      title="New account registration is paused"
      subtitle={
        PUBLIC_REGISTRATION_AVAILABLE
          ? 'Registration has not been restored after the commercial hold.'
          : 'Family Greenhouse remains available as a technical demonstration.'
      }
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-primary-700 hover:text-primary-600">
            Sign in
          </Link>
        </>
      }
    >
      <CommercialHoldNotice compact />
    </AuthShell>
  );
}
