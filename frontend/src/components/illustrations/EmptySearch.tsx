/**
 * Empty-state illustration for "no search results." A magnifying glass
 * over a tilted leaf — playful and on-brand without being saccharine.
 */
export function EmptySearch({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 240 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <ellipse cx="120" cy="156" rx="60" ry="6" fill="#EAF3DE" />
      <path
        d="M100 130 C 80 124, 70 100, 86 80 C 110 70, 130 90, 124 110 C 120 124, 110 130, 100 130 Z"
        fill="#C0DD97"
      />
      <circle cx="138" cy="82" r="32" fill="white" stroke="#27500A" strokeWidth="3" />
      <line
        x1="160"
        y1="104"
        x2="180"
        y2="124"
        stroke="#27500A"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <path
        d="M132 70 C 122 72, 116 82, 122 92"
        stroke="#639922"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
