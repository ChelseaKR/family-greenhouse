/**
 * A living baseline for display titles: one confident stroke with a small
 * leaf emerging from it. The simplified mark stays visible at mobile scale.
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
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M 5 9 Q 76 5 148 8 Q 196 10 235 7" strokeWidth="2.7" opacity="0.9" />
      <path
        d="M 174 8 Q 181 1 190 4 Q 185 11 174 8 Z"
        fill="currentColor"
        stroke="none"
        opacity="0.82"
      />
      <circle cx="5" cy="9" r="1.7" fill="currentColor" stroke="none" opacity="0.65" />
    </svg>
  );
}
