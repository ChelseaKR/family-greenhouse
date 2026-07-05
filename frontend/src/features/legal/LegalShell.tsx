import { PublicShell, PageIntro } from '@/components/PublicShell';

interface LegalShellProps {
  title: string;
  effectiveDate: string;
  children: React.ReactNode;
}

/**
 * Shared chrome for /legal/privacy and /legal/terms. Rides on PublicShell
 * so the legal pages read as part of the same site as the blog, care
 * guides, and changelog rather than a differently-styled annex.
 */
export function LegalShell({ title, effectiveDate, children }: LegalShellProps) {
  return (
    <PublicShell>
      <PageIntro eyebrow="The fine print" title={title} />
      <p className="mt-4 text-sm text-gray-600">Effective {effectiveDate}.</p>

      <div className="prose-fg mt-10">{children}</div>
    </PublicShell>
  );
}
