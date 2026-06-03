/**
 * Botanical task-type icon — water. A water droplet resting on the curl
 * of a leaf. Used in place of the generic Heroicons CalendarIcon /
 * ClockIcon pattern that the dashboard inherited from Tailwind UI.
 *
 * Stroke + fill are `currentColor`-able via the `className` prop's text-*
 * utilities so callers can recolor without re-exporting the icon.
 */
interface IconProps {
  className?: string;
}

export function WaterDropIcon({ className }: IconProps) {
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
      {/* Leaf platter underneath — a tilted leaf with the curl catching the drop */}
      <path
        d="M 6 22 Q 6 16 12 14 Q 22 12 26 18 Q 26 24 18 24 Q 8 24 6 22 Z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path d="M 8 21 Q 14 19 22 21" />
      {/* Water drop */}
      <path
        d="M 16 5
           C 12 11, 10 14, 10 17
           C 10 20, 13 22, 16 22
           C 19 22, 22 20, 22 17
           C 22 14, 20 11, 16 5 Z"
        fill="currentColor"
        fillOpacity="0.95"
        stroke="currentColor"
        strokeWidth="0.8"
      />
      {/* Highlight on the drop */}
      <path d="M 13 13 Q 12 16 14 18" stroke="white" strokeWidth="1.1" opacity="0.7" />
    </svg>
  );
}
