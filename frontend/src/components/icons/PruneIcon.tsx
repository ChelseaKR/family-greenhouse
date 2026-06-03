/**
 * Botanical task-type icon — prune. A stem with one leaf removed (the
 * "trim mark") and a small pair of pruning scissors below. Reads as
 * shaping/maintenance rather than the generic scissors that would feel
 * surgical.
 */
interface IconProps {
  className?: string;
}

export function PruneIcon({ className }: IconProps) {
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
      {/* Stem with branching */}
      <path d="M 14 28 Q 14 20 16 12 Q 16 8 18 5" />
      {/* Remaining leaf at top */}
      <path d="M 17 6 Q 22 4 24 8 Q 22 12 17 10 Z" fill="currentColor" fillOpacity="0.85" />
      {/* Snipped leaf stub — short branch with nothing on the end (the cut) */}
      <path d="M 15 16 Q 10 16 8 18" opacity="0.8" />
      {/* Two small "X" cut marks to indicate the trim point */}
      <line x1="6.5" y1="18.5" x2="9.5" y2="15.5" strokeWidth="1.1" />
      <line x1="6.5" y1="15.5" x2="9.5" y2="18.5" strokeWidth="1.1" />
      {/* Tiny side leaf below (the kept growth) */}
      <path d="M 15 22 Q 19 22 21 20 Q 19 24 15 24 Z" fill="currentColor" fillOpacity="0.6" />
    </svg>
  );
}
