/**
 * Botanical icon — light. A low sun with hand-drawn rays and a small
 * seedling leaning toward it. Drawn in the house style (32-grid, 1.4
 * stroke, partial fills) for the care-guide seed-packet facts card.
 *
 * Stroke + fill are `currentColor`-able via the `className` prop's text-*
 * utilities so callers can recolor without re-exporting the icon.
 */
interface IconProps {
  className?: string;
}

export function SunGlowIcon({ className }: IconProps) {
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
      {/* Sun disc, slightly off-center like a quick sketch */}
      <circle cx="19" cy="13" r="5.5" fill="currentColor" fillOpacity="0.18" />
      <circle cx="19" cy="13" r="5.5" />
      {/* Rays — uneven lengths on purpose */}
      <path d="M 19 3.5 L 19 5.8" />
      <path d="M 26 6 L 24.4 7.6" />
      <path d="M 28.5 13 L 26.2 13" />
      <path d="M 26 20 L 24.4 18.4" />
      <path d="M 12 6 L 13.6 7.6" />
      {/* Seedling leaning toward the light */}
      <path d="M 8 28 Q 8.5 23 10 19.5" />
      <path d="M 9 23 Q 5.5 22 4.5 24.5 Q 7.5 25.5 9 23 Z" fill="currentColor" fillOpacity="0.7" />
      <path d="M 10 20 Q 13 18.5 14.5 20 Q 12 21.8 10 20 Z" fill="currentColor" fillOpacity="0.7" />
      {/* Soil line */}
      <path d="M 4.5 28.5 Q 9 27.5 14 28.5" opacity="0.6" />
    </svg>
  );
}
