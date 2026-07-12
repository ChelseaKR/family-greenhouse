/**
 * Empty-state illustration for the Household roster when only the caller
 * is a member. Two stylized figures with a "+" between them — visually
 * suggests the action ("invite someone") rather than the lack of state.
 */
export function EmptyMembers({ className }: { className?: string }) {
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
      <ellipse cx="120" cy="156" rx="80" ry="6" fill="#DDEEE7" />
      {/* Existing member — solid */}
      <circle cx="84" cy="74" r="20" fill="#639922" />
      <path d="M64 144 c0 -20 12 -34 20 -34 s20 14 20 34" fill="#639922" />
      {/* Invitee — dashed silhouette */}
      <circle
        cx="156"
        cy="74"
        r="20"
        fill="none"
        stroke="#97C459"
        strokeWidth="2"
        strokeDasharray="4 3"
      />
      <path
        d="M136 144 c0 -20 12 -34 20 -34 s20 14 20 34"
        fill="none"
        stroke="#97C459"
        strokeWidth="2"
        strokeDasharray="4 3"
      />
      {/* Plus between */}
      <circle cx="120" cy="100" r="14" fill="#27500A" />
      <line
        x1="120"
        y1="92"
        x2="120"
        y2="108"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <line
        x1="112"
        y1="100"
        x2="128"
        y2="100"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
