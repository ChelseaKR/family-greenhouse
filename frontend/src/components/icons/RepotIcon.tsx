/** A plant moving from a small pot into a larger pot. */
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
      <path d="M8 20V12" />
      <path d="M8 14 Q4.5 13 3 15.5 Q6 16.5 8 14Z" fill="currentColor" fillOpacity="0.8" />
      <path d="M8 11 Q11.5 9 13 12 Q10.5 13.5 8 11Z" fill="currentColor" fillOpacity="0.8" />
      <path d="M3 20H13L12 28H4Z" fill="currentColor" fillOpacity="0.16" />
      <path d="M2 20.5H14" />

      <path d="M14 15H24M21 12l3 3-3 3" strokeWidth="1.8" />

      <path d="M18 19H30L28.5 29H19.5Z" fill="currentColor" fillOpacity="0.28" />
      <path d="M17 19.5H31" strokeWidth="1.7" />
    </svg>
  );
}
