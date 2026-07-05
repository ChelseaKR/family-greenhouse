/**
 * Botanical icon — humidity. A leaf with mist beads hanging above it,
 * drawn in the house style (32-grid, 1.4 stroke, partial fills) for the
 * care-guide seed-packet facts card.
 *
 * Stroke + fill are `currentColor`-able via the `className` prop's text-*
 * utilities so callers can recolor without re-exporting the icon.
 */
interface IconProps {
  className?: string;
}

export function MistLeafIcon({ className }: IconProps) {
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
      {/* Mist — three drifting dashes and two beads */}
      <path d="M 7 7.5 Q 11 6 15 7.5" opacity="0.55" />
      <path d="M 17 5.5 Q 21 4.2 25 5.5" opacity="0.55" />
      <path d="M 12 11 Q 16 9.7 20 11" opacity="0.55" />
      <circle cx="24" cy="10.5" r="1.3" fill="currentColor" fillOpacity="0.8" stroke="none" />
      <circle cx="8.5" cy="12" r="1" fill="currentColor" fillOpacity="0.8" stroke="none" />
      {/* Leaf catching the moisture */}
      <path
        d="M 16 28 Q 8 24 8 18.5 Q 8 14.5 12.5 14 Q 20 13.5 23.5 17 Q 24.5 23 19 26.5 Q 17.5 27.5 16 28 Z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path d="M 16 28 Q 8 24 8 18.5 Q 8 14.5 12.5 14 Q 20 13.5 23.5 17 Q 24.5 23 19 26.5 Q 17.5 27.5 16 28 Z" />
      {/* Midrib */}
      <path d="M 11 16.5 Q 16 20 19.5 25" opacity="0.7" />
      {/* One bead resting on the leaf */}
      <circle cx="14" cy="19" r="1.2" fill="currentColor" fillOpacity="0.9" stroke="none" />
    </svg>
  );
}
