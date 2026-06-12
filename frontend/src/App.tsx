import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { Layout } from '@/components/Layout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { NotFoundPage } from '@/components/NotFoundPage';
import { Toaster } from '@/components/Toaster';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Route-level code splitting. Each feature module compiles into its own
// chunk; the initial bundle drops by ~150 KB because the marketing landing
// page, plant flows, billing, etc. don't ship until the user navigates to
// them. The named-export helper keeps the rest of the codebase ergonomic.
const lazyNamed = <K extends string, T extends Record<string, React.ComponentType<unknown>>>(
  importer: () => Promise<T>,
  name: K
) => lazy(() => importer().then((m) => ({ default: m[name] })));

const LandingPage = lazyNamed(() => import('@/features/landing/LandingPage'), 'LandingPage');
const LoginPage = lazyNamed(() => import('@/features/auth/LoginPage'), 'LoginPage');
const RegisterPage = lazyNamed(() => import('@/features/auth/RegisterPage'), 'RegisterPage');
const ConfirmEmailPage = lazyNamed(
  () => import('@/features/auth/ConfirmEmailPage'),
  'ConfirmEmailPage'
);
const ForgotPasswordPage = lazyNamed(
  () => import('@/features/auth/ForgotPasswordPage'),
  'ForgotPasswordPage'
);
const ResetPasswordPage = lazyNamed(
  () => import('@/features/auth/ResetPasswordPage'),
  'ResetPasswordPage'
);
const DashboardPage = lazyNamed(
  () => import('@/features/dashboard/DashboardPage'),
  'DashboardPage'
);
const PlantsPage = lazyNamed(() => import('@/features/plants/PlantsPage'), 'PlantsPage');
const PlantDetailPage = lazyNamed(
  () => import('@/features/plants/PlantDetailPage'),
  'PlantDetailPage'
);
const AddPlantPage = lazyNamed(() => import('@/features/plants/AddPlantPage'), 'AddPlantPage');
const ImportPlantsPage = lazyNamed(
  () => import('@/features/plants/ImportPlantsPage'),
  'ImportPlantsPage'
);
const SharedPlantPage = lazyNamed(
  () => import('@/features/plants/SharedPlantPage'),
  'SharedPlantPage'
);
const TasksPage = lazyNamed(() => import('@/features/tasks/TasksPage'), 'TasksPage');
const HouseholdPage = lazyNamed(
  () => import('@/features/household/HouseholdPage'),
  'HouseholdPage'
);
const SettingsPage = lazyNamed(() => import('@/features/settings/SettingsPage'), 'SettingsPage');
const HelpPage = lazyNamed(() => import('@/features/help/HelpPage'), 'HelpPage');
const AnalyticsPage = lazyNamed(
  () => import('@/features/analytics/AnalyticsPage'),
  'AnalyticsPage'
);
const ChatPage = lazyNamed(() => import('@/features/chat/ChatPage'), 'ChatPage');
const WelcomeFlow = lazyNamed(() => import('@/features/onboarding/WelcomeFlow'), 'WelcomeFlow');
const HouseholdOnboarding = lazyNamed(
  () => import('@/features/household/HouseholdOnboarding'),
  'HouseholdOnboarding'
);
const JoinHouseholdPage = lazyNamed(
  () => import('@/features/household/JoinHouseholdPage'),
  'JoinHouseholdPage'
);
const BlogIndex = lazyNamed(() => import('@/features/blog/BlogIndex'), 'BlogIndex');
const BlogPost = lazyNamed(() => import('@/features/blog/BlogPost'), 'BlogPost');
const CareIndex = lazyNamed(() => import('@/features/care/CareIndex'), 'CareIndex');
const CareGuidePage = lazyNamed(() => import('@/features/care/CareGuidePage'), 'CareGuidePage');
const ChangelogPage = lazyNamed(
  () => import('@/features/changelog/ChangelogPage'),
  'ChangelogPage'
);
const PrivacyPage = lazyNamed(() => import('@/features/legal/PrivacyPage'), 'PrivacyPage');
const TermsPage = lazyNamed(() => import('@/features/legal/TermsPage'), 'TermsPage');
const StatusPage = lazyNamed(() => import('@/features/status/StatusPage'), 'StatusPage');
const PricingPage = lazyNamed(() => import('@/features/pricing/PricingPage'), 'PricingPage');

/**
 * Single source of truth for the /onboarding route gate. Default: bounce
 * already-onboarded users to /welcome. With `?mode=add`, render the
 * onboarding form so a user with an existing household can spin up a
 * second one (multi-household).
 */
function OnboardingGate({ hasHousehold }: { hasHousehold: boolean }) {
  const [params] = useSearchParams();
  const isAddingAnother = params.get('mode') === 'add';
  if (hasHousehold && !isAddingAnother) {
    return <Navigate to="/welcome" replace />;
  }
  return <HouseholdOnboarding />;
}

function RouteFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" role="status">
      <LoadingSpinner size="lg" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

function App() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const user = useAuthStore((state) => state.user);
  const hasHousehold = user?.householdId != null;

  return (
    <>
      {/* The skip link must point to a target that exists on every page,
          including unauthenticated routes that don't render the Layout. We
          give the Suspense wrapper the id and tabindex so it's always
          focusable from the link. */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Toaster />
      <RouteErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <div id="main-content" tabIndex={-1}>
            <Routes>
              {/* Public routes */}
              <Route
                path="/"
                element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <LandingPage />}
              />
              <Route
                path="/login"
                element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />}
              />
              <Route
                path="/register"
                element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <RegisterPage />}
              />
              <Route path="/confirm-email" element={<ConfirmEmailPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/join/:inviteCode" element={<JoinHouseholdPage />} />
              {/* Public cutting-share landing page — works logged-out (the
                  preview endpoint has no auth, like invite validation). */}
              <Route path="/shared/:code" element={<SharedPlantPage />} />
              <Route path="/blog" element={<BlogIndex />} />
              <Route path="/care" element={<CareIndex />} />
              <Route path="/care/:slug" element={<CareGuidePage />} />
              <Route path="/blog/:slug" element={<BlogPost />} />
              <Route path="/changelog" element={<ChangelogPage />} />
              <Route path="/legal/privacy" element={<PrivacyPage />} />
              <Route path="/legal/terms" element={<TermsPage />} />
              <Route path="/status" element={<StatusPage />} />
              <Route path="/pricing" element={<PricingPage />} />

              {/* Protected routes */}
              <Route element={<ProtectedRoute />}>
                <Route
                  path="/onboarding"
                  element={
                    // `?mode=add` lets users create an additional household
                    // from the switcher without bouncing them off this route.
                    <OnboardingGate hasHousehold={hasHousehold} />
                  }
                />
                <Route path="/welcome" element={<WelcomeFlow />} />

                <Route element={hasHousehold ? <Layout /> : <Navigate to="/onboarding" replace />}>
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/plants" element={<PlantsPage />} />
                  <Route path="/plants/new" element={<AddPlantPage />} />
                  <Route path="/plants/import" element={<ImportPlantsPage />} />
                  <Route path="/plants/:plantId" element={<PlantDetailPage />} />
                  <Route path="/tasks" element={<TasksPage />} />
                  <Route path="/chat" element={<ChatPage />} />
                  <Route path="/household" element={<HouseholdPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/settings/billing" element={<SettingsPage />} />
                  <Route path="/help" element={<HelpPage />} />
                  <Route path="/analytics" element={<AnalyticsPage />} />
                </Route>
              </Route>

              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </div>
        </Suspense>
      </RouteErrorBoundary>
    </>
  );
}

export default App;
