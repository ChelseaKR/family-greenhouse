/**
 * Growth-history icon on the shared 32-unit botanical grid. Three dated
 * shoots rise from one baseline, so it reads as both a log and living growth.
 */
interface IconProps {
  className?: string;
}

export function GrowthRingsIcon({ className }: IconProps) {
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
      <path d="M4 27 Q16 25.8 28 27" opacity="0.7" />
      <path d="M8.5 26V21.5M16 26V15M23.5 26V8" />
      <circle cx="8.5" cy="20.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="16" cy="14" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="23.5" cy="7" r="1.3" fill="currentColor" stroke="none" />
      <path
        d="M16 19 Q12.5 18 11.2 20.5 Q14.5 21.4 16 19Z"
        fill="currentColor"
        fillOpacity="0.75"
      />
      <path
        d="M23.5 12 Q20 11 18.8 13.5 Q22 14.4 23.5 12Z"
        fill="currentColor"
        fillOpacity="0.75"
      />
      <path
        d="M23.5 17 Q27 16 28.2 18.5 Q25 19.4 23.5 17Z"
        fill="currentColor"
        fillOpacity="0.75"
      />
    </svg>
  );
}
