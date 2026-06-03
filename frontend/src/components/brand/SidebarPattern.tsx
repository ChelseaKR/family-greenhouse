/**
 * Decorative botanical pattern that overlays the dark-green sidebar.
 * Absolute-positioned by the consumer at low opacity (~7%) — adds
 * "garden in the margins" warmth without competing with the nav items.
 */
interface SidebarPatternProps {
  className?: string;
}

export function SidebarPattern({ className }: SidebarPatternProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 280 600"
      fill="none"
      stroke="#ffffff"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {/* Repeating tile content — staggered so it doesn't grid-lock visually */}
      <g transform="translate(40 70) rotate(-15)">
        <path d="M 0 28 Q 0 14 0 0" />
        <path d="M 0 8 Q -12 6 -16 14 Q -8 16 0 10 Z" fill="#ffffff" opacity="0.7" />
        <path d="M 0 18 Q 12 16 16 24 Q 8 26 0 20 Z" fill="#ffffff" opacity="0.7" />
      </g>
      <g transform="translate(220 180) rotate(18)">
        <path
          d="M 0 0 C -18 -5, -28 10, -22 28 C -16 40, 4 38, 14 26 C 22 12, 12 -5, 0 0 Z"
          fill="#ffffff"
          opacity="0.6"
        />
      </g>
      <g transform="translate(55 320) rotate(10)">
        <path d="M 0 22 Q 0 10 0 -2" />
        <path d="M 0 8 Q -10 6 -14 12 Q -8 14 0 10 Z" fill="#ffffff" opacity="0.7" />
        <path d="M 0 16 Q 10 14 14 22 Q 8 24 0 18 Z" fill="#ffffff" opacity="0.7" />
        <circle cx="0" cy="-2" r="2" fill="#ffffff" opacity="0.7" />
      </g>
      <g transform="translate(180 440) rotate(-8)">
        <path
          d="M 0 0 C -12 -4, -18 8, -14 20 C -10 28, 2 26, 8 18 C 12 8, 8 -4, 0 0 Z"
          fill="#ffffff"
          opacity="0.5"
        />
      </g>
      <g transform="translate(70 530) rotate(5)">
        <path d="M 0 24 Q 0 12 0 0" />
        <path d="M 0 10 Q -10 8 -14 14 Q -8 16 0 12 Z" fill="#ffffff" opacity="0.6" />
        <path d="M 0 18 Q 10 16 14 22 Q 8 24 0 20 Z" fill="#ffffff" opacity="0.6" />
      </g>
      <circle cx="170" cy="100" r="2" fill="#ffffff" opacity="0.5" />
      <circle cx="100" cy="240" r="1.5" fill="#ffffff" opacity="0.5" />
      <circle cx="230" cy="350" r="2" fill="#ffffff" opacity="0.5" />
      <circle cx="140" cy="500" r="1.5" fill="#ffffff" opacity="0.5" />
    </svg>
  );
}
