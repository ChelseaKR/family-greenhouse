/**
 * Empty-state illustration for the activity feed. A speech-bubble shape
 * with a subtle clock face inside — "nothing happened yet, but it will."
 */
export function EmptyActivity({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 240 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <ellipse cx="120" cy="160" rx="60" ry="6" fill="#EAF3DE" />
      <path
        d="M70 40 H170 a14 14 0 0 1 14 14 v60 a14 14 0 0 1 -14 14 H140 l-14 18 l-14 -18 H70 a14 14 0 0 1 -14 -14 V54 a14 14 0 0 1 14 -14 z"
        fill="#C0DD97"
      />
      <circle cx="120" cy="84" r="22" fill="#F5FAE9" />
      <circle cx="120" cy="84" r="22" stroke="#27500A" strokeWidth="2" fill="none" />
      <line
        x1="120"
        y1="84"
        x2="120"
        y2="70"
        stroke="#27500A"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <line
        x1="120"
        y1="84"
        x2="130"
        y2="90"
        stroke="#27500A"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="120" cy="84" r="2" fill="#27500A" />
    </svg>
  );
}
