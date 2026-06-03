/**
 * Empty-state illustration for the Tasks list. A clipboard with a single
 * checkmark — drawn flat to match the EmptyPlants aesthetic. The
 * checkmark is in primary green so the eye reads "what completion will
 * look like" rather than emptiness.
 */
export function EmptyTasks({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 240 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <ellipse cx="120" cy="160" rx="64" ry="6" fill="#EAF3DE" />
      <rect x="78" y="36" width="84" height="112" rx="8" fill="#fef9c3" />
      <rect x="78" y="36" width="84" height="14" rx="8" fill="#facc15" />
      <rect x="100" y="28" width="40" height="14" rx="4" fill="#a16207" />
      <rect x="106" y="34" width="28" height="2" rx="1" fill="#fef9c3" />
      <line
        x1="92"
        y1="68"
        x2="148"
        y2="68"
        stroke="#a16207"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.4"
      />
      <line
        x1="92"
        y1="84"
        x2="138"
        y2="84"
        stroke="#a16207"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.3"
      />
      <line
        x1="92"
        y1="100"
        x2="142"
        y2="100"
        stroke="#a16207"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.3"
      />
      <circle cx="118" cy="124" r="14" fill="#639922" />
      <path
        d="M112 124 L117 129 L125 119"
        stroke="white"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
