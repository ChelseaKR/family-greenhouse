import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { TitleUnderline } from '@/components/brand/TitleUnderline';

interface AuthShellProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Optional sub-footer below the card (e.g. "Don't have an account?"). */
  footer?: ReactNode;
}

/**
 * Shared chrome for sign-in / register / forgot-password / reset /
 * confirm pages. Replaces the prior `bg-gray-50` + bold sans-serif title
 * pattern with the warm paper background, Bitter serif title, and
 * hand-drawn underline that matches the rest of the journal aesthetic.
 *
 * The botanical sprigs anchor the page corners on desktop and fade on
 * mobile so the form has room to breathe on small screens.
 */
export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="greenhouse-grid relative min-h-screen flex flex-col justify-center overflow-hidden bg-paper px-4 py-12 sm:px-6 lg:px-8">
      <CornerSprig
        className="pointer-events-none absolute -left-8 top-0 hidden md:block w-56 h-auto text-primary-300/50"
        aria-hidden="true"
      />
      <CornerSprig
        className="pointer-events-none absolute -right-8 bottom-0 hidden md:block w-56 h-auto text-primary-300/50 -scale-x-100 -scale-y-100"
        aria-hidden="true"
      />

      <div className="relative sm:mx-auto sm:w-full sm:max-w-md text-center">
        <Link to="/" aria-label="Family Greenhouse home" className="inline-block">
          <img src="/brand/icon.svg" alt="" aria-hidden="true" className="mx-auto h-14 w-auto" />
          <p className="mt-3 font-serif text-xl text-ink leading-none">Family Greenhouse</p>
          <p className="mt-1 text-[10px] uppercase tracking-[0.22em] text-primary-700 font-semibold">
            Grow together
          </p>
        </Link>
        <h1 className="mt-8 font-serif text-3xl text-ink leading-tight">{title}</h1>
        <div className="mt-1 flex justify-center">
          <TitleUnderline className="h-3 w-32 text-primary-600" />
        </div>
        {subtitle && <p className="mt-3 text-sm text-gray-600">{subtitle}</p>}
      </div>

      <div className="relative mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="glass-surface rounded-2xl border border-dew/60 bg-paper/90 px-4 py-8 shadow-journal backdrop-blur-sm sm:px-10">
          {children}
        </div>
        {footer && <p className="mt-6 text-center text-sm text-gray-700">{footer}</p>}
      </div>
    </div>
  );
}

/**
 * Decorative botanical sprig anchored to the corners of the auth shell.
 * Stroke is `currentColor` so opacity tints come from the caller.
 */
function CornerSprig({
  className,
  ...rest
}: React.SVGProps<SVGSVGElement> & { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 180 240"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <path d="M 40 240 Q 38 160 50 80 Q 52 50 50 20" />
      <path d="M 50 70 Q 18 62 8 80 Q 36 88 50 72 Z" fill="currentColor" opacity="0.7" />
      <path d="M 50 130 Q 84 122 96 138 Q 64 146 50 132 Z" fill="currentColor" opacity="0.7" />
      <path d="M 50 190 Q 18 184 10 200 Q 36 210 50 192 Z" fill="currentColor" opacity="0.7" />
      <circle cx="50" cy="20" r="3" fill="currentColor" />
      <path d="M 110 240 Q 112 180 122 140" />
      <path d="M 122 160 Q 150 154 158 168 Q 140 174 122 162 Z" fill="currentColor" opacity="0.6" />
      <circle cx="122" cy="140" r="2.4" fill="currentColor" />
    </svg>
  );
}
