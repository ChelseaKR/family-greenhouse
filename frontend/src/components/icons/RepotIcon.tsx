/**
 * Botanical task-type icon — repot. A leaf with roots reaching out of one
 * pot into a slightly larger one. Reads as "moving up a size" rather than
 * the generic Tailwind UI ArrowsRightLeftIcon swap arrows.
 */
interface IconProps {
  className?: string;
}

export function RepotIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Terracotta pot — trapezoidal */}
      <path
        d="M 8 18
           L 9 26
           L 22 26
           L 23 18
           Q 15.5 16 8 18 Z"
        fill="currentColor"
        fillOpacity="0.22"
      />
      {/* Pot rim */}
      <line x1="7" y1="18.5" x2="24" y2="18.5" strokeWidth="1.6" />
      {/* Plant rising from the pot */}
      <path d="M 15 18 Q 15 13 15 9" />
      {/* Two leaves at the top */}
      <path d="M 15 11 Q 11 10 9 13 Q 12 13 15 11 Z" fill="currentColor" fillOpacity="0.85" />
      <path d="M 15 9 Q 19 7 21 10 Q 18 11 15 9 Z" fill="currentColor" fillOpacity="0.85" />
      {/* Roots emerging through the pot bottom — the "needs more room" signal */}
      <path d="M 11 26 Q 11 28 9 30" opacity="0.7" />
      <path d="M 15 26 Q 15 28 15 30" opacity="0.7" />
      <path d="M 19 26 Q 19 28 21 30" opacity="0.7" />
    </svg>
  );
}
