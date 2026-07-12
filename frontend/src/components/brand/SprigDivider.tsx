/**
 * Section divider based on the roofline and threshold of a greenhouse.
 * It carries actual product meaning and remains legible in long screenshots,
 * unlike the previous tiny sprig.
 */
interface SprigDividerProps {
  className?: string;
}

export function SprigDivider({ className }: SprigDividerProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 160 32"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M 0 24 H 55 L 80 7 L 105 24 H 160" strokeWidth="1.5" opacity="0.62" />
      <path d="M 64 24 V 18 M 80 8 V 24 M 96 24 V 18" strokeWidth="1.2" opacity="0.45" />
      <path
        d="M 80 21 Q 72 17 69 21 Q 75 25 80 21 Z M 80 18 Q 88 14 91 18 Q 85 22 80 18 Z"
        fill="currentColor"
        stroke="none"
        opacity="0.9"
      />
      <path d="M 57 26 H 103" strokeWidth="2.4" opacity="0.75" />
    </svg>
  );
}
