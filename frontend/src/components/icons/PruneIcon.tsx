/** Pruning shears closing around a leafy stem, on the shared 32-unit grid. */
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
      <path d="M20 29 Q19 20 20 11 Q20 7 22 4" />
      <path d="M21 7 Q26 4 28 8 Q25 12 20 11Z" fill="currentColor" fillOpacity="0.78" />
      <path d="M20 16 Q15 14 12 16" opacity="0.75" />
      <path d="M7 22 L16 16 M11 26 L16 16" />
      <path d="M16 16 L25 23 M16 16 L25 12" opacity="0.82" />
      <circle cx="6.5" cy="23" r="3.2" />
      <circle cx="10.5" cy="27" r="3.2" />
      <circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
