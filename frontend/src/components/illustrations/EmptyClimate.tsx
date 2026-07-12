/**
 * Empty-state illustration for the climate card when no location is set.
 * A globe with a pin — "tell us where you are."
 */
export function EmptyClimate({ className }: { className?: string }) {
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
      <ellipse cx="120" cy="158" rx="60" ry="6" fill="#DDEEE7" />
      <circle cx="120" cy="92" r="46" fill="#C0DD97" />
      <path
        d="M74 92 a46 46 0 0 1 92 0"
        fill="none"
        stroke="#27500A"
        strokeWidth="1.5"
        opacity="0.4"
      />
      <path
        d="M120 46 a46 46 0 0 1 0 92"
        fill="none"
        stroke="#27500A"
        strokeWidth="1.5"
        opacity="0.4"
      />
      <ellipse
        cx="120"
        cy="92"
        rx="20"
        ry="46"
        fill="none"
        stroke="#27500A"
        strokeWidth="1.5"
        opacity="0.4"
      />
      <path
        d="M138 56 c-10 0 -18 8 -18 18 c0 14 18 30 18 30 s18 -16 18 -30 c0 -10 -8 -18 -18 -18 z"
        fill="#dc6c1f"
        stroke="#a23f1a"
        strokeWidth="1.5"
      />
      <circle cx="138" cy="74" r="6" fill="white" />
    </svg>
  );
}
