/**
 * Landing feature icon — the plant's memory. Three stems of rising
 * height along one ground line: a bar chart, but grown. Replaces the
 * stock Heroicons ChartBarIcon on the landing features grid. Same
 * hand-drawn stroke conventions as the botanical task icons
 * (WaterDropIcon et al.).
 */
interface IconProps {
  className?: string;
}

export function GrowthRingsIcon({ className }: IconProps) {
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
      {/* Ground baseline */}
      <path d="M 3.5 20.5 Q 12 19.6 20.5 20.5" />
      {/* Short stem — the first entry in the log */}
      <path d="M 6.5 20 V 16.4" />
      <circle cx="6.5" cy="15.6" r="0.95" fill="currentColor" stroke="none" />
      {/* Middle stem with one leaf */}
      <path d="M 12 20 V 11.6" />
      <path
        d="M 12 14.4 Q 9.6 13.8 8.7 15.8 Q 11 16.3 12 14.4 Z"
        fill="currentColor"
        fillOpacity="0.8"
      />
      <circle cx="12" cy="10.8" r="0.95" fill="currentColor" stroke="none" />
      {/* Tall stem with two leaves — the full history */}
      <path d="M 17.5 20 V 6.6" />
      <path
        d="M 17.5 10 Q 15.1 9.4 14.2 11.4 Q 16.5 11.9 17.5 10 Z"
        fill="currentColor"
        fillOpacity="0.8"
      />
      <path
        d="M 17.5 13 Q 19.9 12.4 20.8 14.4 Q 18.5 14.9 17.5 13 Z"
        fill="currentColor"
        fillOpacity="0.8"
      />
      <circle cx="17.5" cy="5.8" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}
