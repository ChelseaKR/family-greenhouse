/**
 * Landing feature icon — works at the sink. A phone outline with a
 * little sprout filling the screen: the app installed where the watering
 * happens. Replaces the stock Heroicons DevicePhoneMobileIcon on the
 * landing features grid. Same hand-drawn stroke conventions as the
 * botanical task icons (WaterDropIcon et al.).
 */
interface IconProps {
  className?: string;
}

export function PhoneLeafIcon({ className }: IconProps) {
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
      {/* Phone body */}
      <rect x="7" y="2.75" width="10" height="18.5" rx="2.5" />
      {/* Home indicator */}
      <path d="M 10.75 18.6 H 13.25" />
      {/* Sprout on the screen */}
      <path d="M 12 15.8 V 8.4" />
      <path
        d="M 12 10.8 Q 9.4 10.1 8.6 12.1 Q 10.9 12.7 12 10.8 Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <path
        d="M 12 13.2 Q 14.6 12.5 15.4 14.5 Q 13.1 15.1 12 13.2 Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
