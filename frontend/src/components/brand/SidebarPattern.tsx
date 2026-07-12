/**
 * Greenhouse-pane texture for the dark navigation rail. The straight frame
 * gives the sidebar product-specific structure; one climbing vine keeps it
 * from feeling architectural or sterile.
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
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g stroke="white" strokeWidth="1.25" opacity="0.55">
        <path d="M -40 120 L 70 10 L 180 120 L 290 10" />
        <path d="M -40 360 L 70 250 L 180 360 L 290 250" />
        <path d="M -40 600 L 70 490 L 180 600 L 290 490" />
        <path d="M 70 10 V 600 M 180 120 V 600" opacity="0.5" />
      </g>

      <g stroke="white" strokeWidth="1.6" opacity="0.9">
        <path d="M 24 602 C 28 510 12 432 36 346 C 54 282 38 212 62 138" />
        <path d="M 39 338 Q 74 320 84 344 Q 55 354 39 338 Z" fill="white" opacity="0.7" />
        <path d="M 32 410 Q 2 398 -8 422 Q 18 432 32 410 Z" fill="white" opacity="0.58" />
        <path d="M 53 244 Q 82 228 92 248 Q 68 260 53 244 Z" fill="white" opacity="0.68" />
        <path d="M 58 174 Q 30 160 20 182 Q 44 192 58 174 Z" fill="white" opacity="0.58" />
        <circle cx="62" cy="138" r="3" fill="white" stroke="none" />
      </g>
    </svg>
  );
}
