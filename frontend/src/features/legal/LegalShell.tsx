import { Link } from 'react-router-dom';
import { BrandMark } from '@/components/BrandMark';
import { Footer } from '@/components/Footer';

interface LegalShellProps {
  title: string;
  effectiveDate: string;
  children: React.ReactNode;
}

/**
 * Shared chrome for /legal/privacy and /legal/terms. Same header + footer
 * pattern as the blog and changelog so the marketing site reads as a
 * consistent surface, not a grab bag of differently-styled pages.
 */
export function LegalShell({ title, effectiveDate, children }: LegalShellProps) {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-gray-200">
        <nav className="mx-auto max-w-3xl flex items-center justify-between p-6">
          <Link to="/" aria-label="Family Greenhouse home">
            <BrandMark variant="wordmark" size="sm" />
          </Link>
          <Link to="/" className="text-sm font-medium text-primary-700 hover:underline">
            Try the app →
          </Link>
        </nav>
      </header>

      <main className="flex-1 mx-auto max-w-3xl w-full px-6 py-16">
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
          {title}
        </h1>
        <p className="mt-2 text-sm text-gray-500">Effective {effectiveDate}.</p>

        <div className="prose-fg mt-10">{children}</div>
      </main>

      <Footer />
    </div>
  );
}
