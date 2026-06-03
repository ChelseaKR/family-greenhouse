/**
 * Botanical task-type icon — fertilize. A sprouting seed with three tiny
 * shoots; reads as "feed the soil and watch it grow." Pairs with the water
 * drop icon stylistically.
 */
interface IconProps {
  className?: string;
}

export function FertilizeIcon({ className }: IconProps) {
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
      {/* Soil mound */}
      <path
        d="M 4 24 Q 6 19 16 19 Q 26 19 28 24 Q 28 27 16 27 Q 4 27 4 24 Z"
        fill="currentColor"
        fillOpacity="0.22"
      />
      {/* Three small dots in the soil = nutrients */}
      <circle cx="10" cy="23" r="1" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="17" cy="24" r="1" fill="currentColor" stroke="none" opacity="0.7" />
      <circle cx="23" cy="23" r="1" fill="currentColor" stroke="none" opacity="0.7" />
      {/* Center sprout — main stem with two side leaves */}
      <path d="M 16 19 Q 16 13 16 6" />
      <path d="M 16 12 Q 12 11 10 14 Q 13 14 16 12 Z" fill="currentColor" fillOpacity="0.85" />
      <path d="M 16 14 Q 20 13 22 16 Q 19 16 16 14 Z" fill="currentColor" fillOpacity="0.85" />
      {/* Bud at the tip */}
      <circle cx="16" cy="6" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
