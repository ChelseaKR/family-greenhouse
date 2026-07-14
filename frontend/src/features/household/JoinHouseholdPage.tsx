import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import { householdService, listMyHouseholds } from '@/services/householdService';
import { authService } from '@/services/authService';
import { getErrorMessage } from '@/services/api';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Alert } from '@/components/Alert';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { track } from '@/services/analytics';
import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';

export function JoinHouseholdPage() {
  useDocumentTitle('Join household');
  const { inviteCode } = useParams<{ inviteCode: string }>();
  const navigate = useNavigate();
  const { isAuthenticated, setHousehold } = useAuthStore();
  const [error, setError] = useState<string | null>(null);

  const {
    data: inviteData,
    isLoading,
    error: validateError,
  } = useQuery({
    queryKey: ['invite', inviteCode],
    queryFn: () => householdService.validateInvite(inviteCode!),
    enabled: !!inviteCode,
  });

  // Belonging to SOME household (the common case — a Cognito claim every
  // onboarded user has) used to redirect away from this page unconditionally,
  // which made it impossible for anyone but a brand-new user to ever accept a
  // second household's invite. Only the household THIS invite targets matters.
  const { data: memberships, isLoading: membershipsLoading } = useQuery({
    queryKey: ['me', 'households'],
    queryFn: listMyHouseholds,
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
  const isAlreadyMember =
    isAuthenticated &&
    !!inviteData?.household &&
    (memberships?.some((m) => m.householdId === inviteData.household.id) ?? false);

  const joinMutation = useMutation({
    mutationFn: () => householdService.joinWithInvite(inviteCode!),
    onSuccess: async (household) => {
      track('household_joined');
      track('invite_accepted');
      setHousehold(household.id, 'member');
      // joinHousehold just wrote our `custom:household_id` claim to Cognito,
      // but the current token predates it — and requireHousehold returns a 403
      // (not a 401), so the auth interceptor's refresh-on-401 never kicks in.
      // Without refreshing here, the very next request (e.g. adding a plant)
      // reaches the backend with no household context and fails with
      // "User must belong to a household". Mirror HouseholdOnboarding's
      // first-household flow and refresh now so the token carries the claim.
      // Best-effort: if it fails, the interceptor still recovers on a 401.
      const { refreshToken, setTokens } = useAuthStore.getState();
      if (refreshToken) {
        try {
          const tokens = await authService.refreshToken(refreshToken);
          setTokens(tokens.idToken, tokens.accessToken, tokens.refreshToken);
        } catch {
          // fall through — the interceptor's on-demand refresh catches up.
        }
      }
      navigate('/');
    },
    onError: (err) => {
      setError(getErrorMessage(err));
    },
  });

  if (isLoading || (isAuthenticated && membershipsLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const isInvalid = validateError || !inviteData?.valid;

  return (
    <div className="min-h-screen flex flex-col justify-center py-12 sm:px-6 lg:px-8 bg-paper">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <BrandMark variant="wordmark" />
        </div>
        <h2 className="mt-6 text-center font-serif text-2xl text-ink">Join Household</h2>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <Card>
          {isInvalid ? (
            <div className="text-center space-y-4">
              <Alert variant="error">This invite link is invalid or has expired.</Alert>
              <p className="text-sm text-gray-500">
                Please ask for a new invite link from a household admin.
              </p>
              {isAuthenticated ? (
                <Link to="/onboarding">
                  <Button variant="secondary">Go to onboarding</Button>
                </Link>
              ) : (
                <Link to="/login">
                  <Button variant="secondary">Sign in</Button>
                </Link>
              )}
            </div>
          ) : isAlreadyMember ? (
            <div className="text-center space-y-4">
              <Alert variant="info">
                You&rsquo;re already a member of <strong>{inviteData?.household.name}</strong>.
              </Alert>
              <Link to="/">
                <Button variant="secondary">Go to your household</Button>
              </Link>
            </div>
          ) : !isAuthenticated ? (
            <div className="text-center space-y-4">
              <p className="text-gray-600">
                You've been invited to join <strong>{inviteData?.household.name}</strong>
              </p>
              <p className="text-sm text-gray-500">
                Sign in with an existing account to accept this invitation. New account registration
                is paused.
              </p>
              <CommercialHoldNotice compact />
              <div className="flex justify-center">
                <Link to={`/login?redirect=/join/${inviteCode}`}>
                  <Button>Sign in</Button>
                </Link>
              </div>
            </div>
          ) : (
            <div className="text-center space-y-6">
              {error && <Alert variant="error">{error}</Alert>}

              <p className="text-gray-600">You've been invited to join</p>
              <p className="text-xl font-semibold text-gray-900">{inviteData?.household.name}</p>

              <div className="flex gap-3 justify-center">
                <Link to="/onboarding">
                  <Button variant="secondary">Cancel</Button>
                </Link>
                <Button onClick={() => joinMutation.mutate()} isLoading={joinMutation.isPending}>
                  Join household
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
