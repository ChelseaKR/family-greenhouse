/**
 * Custom illustration for empty plant lists. Inline SVG so it's part of the
 * component tree (no extra request) and inherits theme colors via
 * `currentColor` where appropriate.
 */
export function EmptyPlants({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 240 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M36 148V68L120 22l84 46v80"
        fill="#F7F8F2"
        stroke="#DDEEE7"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M120 23v125M37 68h166" stroke="#B7D9D1" strokeWidth="1.5" opacity="0.7" />
      <ellipse cx="120" cy="155" rx="80" ry="8" fill="#DDEEE7" />
      <path d="M76 132 L84 168 H156 L164 132 Z" fill="#c8541a" />
      <rect x="74" y="128" width="92" height="6" rx="1.5" fill="#a23f1a" />
      <ellipse cx="120" cy="132" rx="42" ry="4" fill="#3d2814" />
      <path d="M120 132 V70" stroke="#27500A" strokeWidth="3" strokeLinecap="round" />
      <path d="M120 90 C92 86 78 60 88 44 C112 44 128 64 120 90 Z" fill="#639922" />
      <path d="M120 90 C148 86 162 60 152 44 C128 44 112 64 120 90 Z" fill="#4F7A1B" />
      <path d="M120 70 C112 60 112 38 120 30 C128 38 128 60 120 70 Z" fill="#97C459" />
      <circle cx="60" cy="50" r="3" fill="#97C459" />
      <circle cx="180" cy="38" r="2" fill="#97C459" />
      <circle cx="200" cy="80" r="2.5" fill="#DC6C1F" />
      <circle cx="40" cy="100" r="2" fill="#97C459" />
    </svg>
  );
}
