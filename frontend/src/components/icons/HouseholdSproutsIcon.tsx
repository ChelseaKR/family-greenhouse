/**
 * Landing feature icon — shared household care. Three sprouts of
 * different heights growing from the same patch of ground: everyone in
 * the house, tending the same garden. Replaces the stock Heroicons
 * UserGroupIcon on the landing features grid. Same hand-drawn stroke
 * conventions as the botanical task icons (WaterDropIcon et al.).
 */
interface IconProps {
  className?: string;
}

export function HouseholdSproutsIcon({ className }: IconProps) {
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
      {/* Shared ground line */}
      <path d="M 3.5 20.5 Q 12 19.8 20.5 20.5" />
      {/* Tall center sprout with two leaves */}
      <path d="M 12 20 V 9" />
      <path
        d="M 12 11.6 Q 9.4 10.9 8.4 12.8 Q 10.8 13.4 12 11.6 Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <path
        d="M 12 14.2 Q 14.6 13.5 15.6 15.4 Q 13.2 16 12 14.2 Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <circle cx="12" cy="8.6" r="1.1" fill="currentColor" stroke="none" />
      {/* Shorter sprout, left */}
      <path d="M 5.6 20 Q 5.6 16.8 6.8 14.4" />
      <path
        d="M 6.3 16.2 Q 4.4 15.4 3.4 16.7 Q 5.3 17.5 6.4 16.4 Z"
        fill="currentColor"
        fillOpacity="0.7"
      />
      <circle cx="7" cy="14" r="0.9" fill="currentColor" stroke="none" />
      {/* Shorter sprout, right */}
      <path d="M 18.4 20 Q 18.4 16.8 17.2 14.4" />
      <path
        d="M 17.7 16.2 Q 19.6 15.4 20.6 16.7 Q 18.7 17.5 17.6 16.4 Z"
        fill="currentColor"
        fillOpacity="0.7"
      />
      <circle cx="17" cy="14" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
