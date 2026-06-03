/**
 * Hand-drawn underline beneath page titles. Two slightly mismatched
 * strokes overlap to give it variable line weight; seed dots at each end
 * for botanical flavor. Stroke is `currentColor` so consumers recolor via
 * `text-*` utility classes.
 */
interface TitleUnderlineProps {
  className?: string;
}

export function TitleUnderline({ className }: TitleUnderlineProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 240 14"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M 6 8 Q 60 4 120 7 T 234 8" strokeWidth="3" opacity="0.85" />
      <path d="M 30 9 Q 100 6 160 8 T 220 9" strokeWidth="2" opacity="0.5" />
      <circle cx="6" cy="8" r="2" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="234" cy="8" r="2" fill="currentColor" stroke="none" opacity="0.7" />
    </svg>
  );
}
