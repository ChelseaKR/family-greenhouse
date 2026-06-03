/**
 * Botanical task-type icon — custom (anything that's not water/fertilize/
 * prune/repot). A clipboard with a small sprig clipped to it. Friendlier
 * than a generic "more" dot pattern.
 */
interface IconProps {
  className?: string;
}

export function CustomTaskIcon({ className }: IconProps) {
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
      {/* Clipboard body */}
      <rect x="8" y="8" width="16" height="20" rx="2" fill="currentColor" fillOpacity="0.18" />
      {/* Clip at the top */}
      <rect x="12" y="5" width="8" height="5" rx="1.4" fill="currentColor" fillOpacity="0.6" />
      {/* Three ruled lines on the clipboard */}
      <line x1="12" y1="16" x2="20" y2="16" strokeWidth="1" opacity="0.5" />
      <line x1="12" y1="20" x2="20" y2="20" strokeWidth="1" opacity="0.5" />
      <line x1="12" y1="24" x2="18" y2="24" strokeWidth="1" opacity="0.5" />
      {/* Small sprig poking out from behind the clip — the botanical touch */}
      <path d="M 22 10 Q 24 8 25 5" />
      <path d="M 24 8 Q 26 7 27 9 Q 25 9 23 8 Z" fill="currentColor" fillOpacity="0.85" />
    </svg>
  );
}
