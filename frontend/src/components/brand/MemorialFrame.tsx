/**
 * Two mirrored botanical sprigs that flank the "In loving memory of my mom"
 * line at the bottom of the app shell. Currently shipped as an inline
 * decoration around that single text node — see Layout.tsx.
 */
interface MemorialFrameProps {
  className?: string;
}

export function MemorialFrame({ className }: MemorialFrameProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 360 40"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g transform="translate(40 20)">
        <path d="M -28 0 Q -10 0 4 -8" />
        <path d="M -14 -2 Q -20 -10 -10 -12 Q -8 -6 -14 -2 Z" fill="currentColor" opacity="0.7" />
        <path d="M 0 -6 Q -4 -14 6 -16 Q 8 -10 0 -6 Z" fill="currentColor" opacity="0.7" />
        <circle cx="4" cy="-8" r="2" fill="currentColor" opacity="0.85" stroke="none" />
      </g>
      <g transform="translate(320 20) scale(-1 1)">
        <path d="M -28 0 Q -10 0 4 -8" />
        <path d="M -14 -2 Q -20 -10 -10 -12 Q -8 -6 -14 -2 Z" fill="currentColor" opacity="0.7" />
        <path d="M 0 -6 Q -4 -14 6 -16 Q 8 -10 0 -6 Z" fill="currentColor" opacity="0.7" />
        <circle cx="4" cy="-8" r="2" fill="currentColor" opacity="0.85" stroke="none" />
      </g>
    </svg>
  );
}
