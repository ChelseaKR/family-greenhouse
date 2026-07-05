/**
 * Botanical icon — pet safety. A paw print beside a small leaf, drawn in
 * the house style (32-grid, 1.4 stroke, partial fills) for the care-guide
 * seed-packet facts card. Neutral on purpose: the fact text says whether
 * the plant is safe; the icon only marks the topic.
 *
 * Stroke + fill are `currentColor`-able via the `className` prop's text-*
 * utilities so callers can recolor without re-exporting the icon.
 */
interface IconProps {
  className?: string;
}

export function PawLeafIcon({ className }: IconProps) {
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
      {/* Main pad — a soft rounded triangle */}
      <path
        d="M 13 27 Q 8.5 26.5 8.5 23 Q 8.5 20.5 11 19.5 Q 13.5 18.7 15.5 20.5 Q 17.5 22.5 16.5 25 Q 15.5 27.3 13 27 Z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path d="M 13 27 Q 8.5 26.5 8.5 23 Q 8.5 20.5 11 19.5 Q 13.5 18.7 15.5 20.5 Q 17.5 22.5 16.5 25 Q 15.5 27.3 13 27 Z" />
      {/* Toes — four uneven beans */}
      <ellipse
        cx="6.5"
        cy="17"
        rx="1.7"
        ry="2.2"
        fill="currentColor"
        fillOpacity="0.7"
        stroke="none"
        transform="rotate(-18 6.5 17)"
      />
      <ellipse
        cx="11"
        cy="13.5"
        rx="1.8"
        ry="2.3"
        fill="currentColor"
        fillOpacity="0.7"
        stroke="none"
        transform="rotate(-8 11 13.5)"
      />
      <ellipse
        cx="16.5"
        cy="13.5"
        rx="1.8"
        ry="2.3"
        fill="currentColor"
        fillOpacity="0.7"
        stroke="none"
        transform="rotate(10 16.5 13.5)"
      />
      <ellipse
        cx="20.5"
        cy="17"
        rx="1.7"
        ry="2.2"
        fill="currentColor"
        fillOpacity="0.7"
        stroke="none"
        transform="rotate(20 20.5 17)"
      />
      {/* Sprig leaning in from the right */}
      <path d="M 26 27 Q 26.5 20 25 13 Q 24.6 10.5 25.5 8" />
      <path
        d="M 25.2 14 Q 28.5 12.5 30 14.5 Q 27.5 16 25.2 14 Z"
        fill="currentColor"
        fillOpacity="0.7"
      />
      <path
        d="M 25.6 20 Q 22.5 19 21.5 21.5 Q 24.5 22.5 25.6 20 Z"
        fill="currentColor"
        fillOpacity="0.7"
      />
      <circle cx="25.5" cy="8" r="1.6" fill="currentColor" fillOpacity="0.9" stroke="none" />
    </svg>
  );
}
