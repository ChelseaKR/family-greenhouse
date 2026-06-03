/**
 * Section divider — a small botanical sprig flanked by two horizontal
 * rules. Use wherever a softer break than `border-b border-gray-200` is
 * appropriate. Stroke is `currentColor`; size via the className prop.
 */
interface SprigDividerProps {
  className?: string;
}

export function SprigDivider({ className }: SprigDividerProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 160 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="0" y1="16" x2="56" y2="16" opacity="0.4" />
      <line x1="104" y1="16" x2="160" y2="16" opacity="0.4" />
      <path d="M 80 24 Q 80 18 80 8" />
      <path d="M 80 14 Q 72 12 68 18 Q 76 18 80 14 Z" fill="currentColor" opacity="0.85" />
      <path d="M 80 18 Q 88 16 92 22 Q 84 22 80 18 Z" fill="currentColor" opacity="0.85" />
      <circle cx="80" cy="8" r="2.2" fill="currentColor" opacity="0.9" />
    </svg>
  );
}
