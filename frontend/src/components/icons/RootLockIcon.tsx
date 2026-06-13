/**
 * Landing feature icon — yours to keep. A padlock with roots growing
 * out of its base: the data is locked down, and it's planted with you,
 * not with us. Replaces the stock Heroicons ShieldCheckIcon on the
 * landing features grid. Same hand-drawn stroke conventions as the
 * botanical task icons (WaterDropIcon et al.).
 */
interface IconProps {
  className?: string;
}

export function RootLockIcon({ className }: IconProps) {
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
      {/* Shackle */}
      <path d="M 8.75 9.5 V 7.5 a 3.25 3.25 0 0 1 6.5 0 v 2" />
      {/* Lock body */}
      <rect x="5.75" y="9.5" width="12.5" height="7.5" rx="1.5" />
      {/* Keyhole */}
      <circle cx="12" cy="12.6" r="1" fill="currentColor" stroke="none" />
      <path d="M 12 13.6 V 14.9" />
      {/* Roots growing from the base — wavy, not straight legs */}
      <path d="M 8.6 17 C 8.8 18.6 8 19.8 6.8 20.7" />
      <path d="M 12 17 C 11.6 18.4 12.4 19.6 12 21" />
      <path d="M 12.1 19 Q 13.3 19.3 13.9 20.4" opacity="0.7" />
      <path d="M 15.4 17 C 15.2 18.6 16 19.8 17.2 20.7" />
    </svg>
  );
}
