/**
 * Landing feature icon — reminders. A bell-shaped flower (campanula)
 * hanging from an arched stem, with two chime waves rising off the bloom:
 * the reminder bell, grown instead of forged. Replaces the stock
 * Heroicons BellAlertIcon on the landing features grid. Same hand-drawn
 * stroke conventions as the botanical task icons (WaterDropIcon et al.).
 */
interface IconProps {
  className?: string;
}

export function ReminderBellbloomIcon({ className }: IconProps) {
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
      {/* Arching stem from the ground up to the bloom */}
      <path d="M 4.5 21 C 4.5 13.5 7.5 7.5 14 6.5" />
      {/* Leaf on the stem */}
      <path
        d="M 6.4 14.6 Q 3.2 14.2 2.6 16.6 Q 5.6 17 6.6 14.8 Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      {/* Hanging bell flower */}
      <path d="M 14 6.5 c -2.4 0.5 -3.1 2.2 -3.1 4.3 0 1.5 -0.6 2.5 -1.5 3.4 h 9.2 c -0.9 -0.9 -1.5 -1.9 -1.5 -3.4 0 -2.1 -0.7 -3.8 -3.1 -4.3 z" />
      {/* Clapper / stamen */}
      <circle cx="14" cy="16" r="1" fill="currentColor" stroke="none" />
      {/* Chime waves — the reminder going out */}
      <path d="M 20.6 8.4 Q 21.8 10.4 20.8 12.4" opacity="0.6" />
      <path d="M 22 7.2 Q 23.2 9.6 22.2 12" opacity="0.35" />
    </svg>
  );
}
