import { Navigate, Outlet, useLocation } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStore } from '@/store/authStore';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from './LoadingSpinner';

export function ProtectedRoute() {
  const { t } = useTranslation();
  // Select only the two fields used (via useShallow) so a silent token
  // refresh doesn't re-render this route guard and its whole subtree.
  const { isAuthenticated, isLoading } = useAuthStore(
    useShallow((s) => ({ isAuthenticated: s.isAuthenticated, isLoading: s.isLoading }))
  );
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" role="status">
        <LoadingSpinner size="lg" />
        <span className="sr-only">{t('common.loadingDots')}</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
