/**
 * Landing feature icon — the scannable week. A calendar page with its
 * two binding posts, and a single leaf growing across the date grid:
 * the week, but for plants. Replaces the stock Heroicons
 * CalendarDaysIcon on the landing features grid. Same hand-drawn stroke
 * conventions as the botanical task icons (WaterDropIcon et al.).
 */
interface IconProps {
  className?: string;
}

export function CalendarLeafIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Calendar page */}
      <rect x="3.75" y="5.25" width="16.5" height="15" rx="2" />
      {/* Header rule, hand-drawn slightly off-straight */}
      <path d="M 4 9.75 Q 12 9.3 20 9.75" />
      {/* Binding posts */}
      <path d="M 8.25 3 V 6.5" />
      <path d="M 15.75 3 V 6.5" />
      {/* Leaf across the date grid */}
      <path
        d="M 8.6 17.4 Q 8.6 12.6 15.4 12.6 Q 15.4 17.4 8.6 17.4 Z"
        fill="currentColor"
        fillOpacity="0.8"
      />
      {/* Leaf stem trailing off the blade */}
      <path d="M 8.6 17.4 Q 7.4 18 6.8 18.6" />
    </svg>
  );
}
