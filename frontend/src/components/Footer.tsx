import { Link } from 'react-router-dom';
import { MemorialFrame } from './brand/MemorialFrame';

const FOOTER_LINKS = [
  { label: 'Care guides', to: '/care' },
  { label: 'Blog', to: '/blog' },
  { label: 'Plans', to: '/pricing' },
  { label: 'Changelog', to: '/changelog' },
  { label: 'Status', to: '/status' },
  { label: 'Support', to: '/support' },
  { label: 'Privacy', to: '/legal/privacy' },
  { label: 'Delete account', to: '/account-deletion' },
  { label: 'Terms', to: '/legal/terms' },
];

/**
 * Footer rendered at the bottom of public content pages (via PublicShell).
 * Compact cousin of the landing page's full footer: same dark-green
 * ground, same memorial treatment, plus one row of cross-links so
 * readers arriving from search can find the rest of the site.
 *
 * The dedication line is intentional and quiet — please leave it.
 */
export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="bg-primary-900">
      <div className="mx-auto max-w-7xl px-6 py-10 text-center">
        <nav aria-label="Footer" className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          {FOOTER_LINKS.map((link) => (
            <Link key={link.to} to={link.to} className="text-sm text-primary-200 hover:text-white">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="mt-8 flex items-center justify-center gap-4">
          <MemorialFrame className="hidden sm:block h-8 w-32 text-primary-300/50" />
          <p className="text-sm italic text-primary-200">
            In loving memory of my mom, Joyce — who taught us to keep growing.
          </p>
          <MemorialFrame className="hidden sm:block h-8 w-32 text-primary-300/50 -scale-x-100" />
        </div>
        <p className="mt-6 text-sm text-primary-200">
          &copy; {year} Family Greenhouse. Plant data powered by{' '}
          <a
            href="https://perenual.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-white"
          >
            Perenual
          </a>
          .
        </p>
      </div>
    </footer>
  );
}
