/**
 * Dashboard page header art — a small botanical vignette that sits in the
 * top-right of the dashboard's title block. Three stylized plants in a
 * row, each in a terracotta pot, with a low sun cresting behind them.
 * Replaces what was a bare `Welcome back, Chelsea` H1.
 *
 * Sized via the consumer's `className` (defaults assume ~200×120 viewport).
 */
interface HeaderArtProps {
  className?: string;
}

export function DashboardHeaderArt({ className }: HeaderArtProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 240 120"
      fill="none"
      aria-hidden="true"
      stroke="#27500A"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Sun — soft Leaf Mid disc behind the plants */}
      <circle cx="170" cy="38" r="22" fill="#97C459" fillOpacity="0.4" stroke="none" />
      <circle cx="170" cy="38" r="16" fill="#97C459" fillOpacity="0.6" stroke="none" />
      {/* Small horizon line */}
      <line x1="0" y1="98" x2="240" y2="98" stroke="#27500A" strokeWidth="0.8" opacity="0.3" />

      {/* Left plant — short bushy guy */}
      <g transform="translate(40 62)">
        <path
          d="M 0 36 L 3 22 L 17 22 L 20 36 Q 10 40 0 36 Z"
          fill="#DC6C1F"
          stroke="#7E3219"
          strokeWidth="1.4"
        />
        <line x1="2" y1="23" x2="18" y2="23" stroke="#7E3219" strokeWidth="1.3" />
        <path d="M 10 22 Q 10 14 10 6" stroke="#3B6D11" strokeWidth="2.4" />
        <path d="M 10 14 Q 4 12 1 16 Q 7 16 10 14 Z" fill="#639922" />
        <path d="M 10 8 Q 16 6 18 10 Q 14 12 10 10 Z" fill="#639922" />
      </g>

      {/* Center plant — the tall one, monstera-ish */}
      <g transform="translate(110 50)">
        <path
          d="M 0 48 L 3 30 L 21 30 L 24 48 Q 12 52 0 48 Z"
          fill="#DC6C1F"
          stroke="#7E3219"
          strokeWidth="1.4"
        />
        <line x1="2" y1="31" x2="22" y2="31" stroke="#7E3219" strokeWidth="1.3" />
        <path d="M 12 30 Q 12 18 12 4" stroke="#3B6D11" strokeWidth="2.6" />
        {/* Large leaf left */}
        <path d="M 12 14 Q 0 10 -4 18 Q 4 20 12 16 Z" fill="#639922" />
        {/* Large leaf right */}
        <path d="M 12 10 Q 26 6 28 14 Q 20 18 12 14 Z" fill="#639922" />
        {/* Top bud */}
        <circle cx="12" cy="4" r="2.2" fill="#639922" stroke="none" />
      </g>

      {/* Right plant — succulent in a wider pot */}
      <g transform="translate(190 70)">
        <path
          d="M -2 28 L 0 18 L 20 18 L 22 28 Q 10 32 -2 28 Z"
          fill="#DC6C1F"
          stroke="#7E3219"
          strokeWidth="1.4"
        />
        <line x1="-2" y1="19" x2="22" y2="19" stroke="#7E3219" strokeWidth="1.3" />
        {/* Three rosette leaves */}
        <path d="M 10 18 Q 4 12 8 6 Q 12 12 10 18 Z" fill="#97C459" />
        <path d="M 10 18 Q 16 12 12 6 Q 8 12 10 18 Z" fill="#97C459" />
        <path d="M 10 18 Q 10 8 10 4" stroke="#3B6D11" strokeWidth="1.8" />
        <circle cx="10" cy="4" r="1.6" fill="#639922" stroke="none" />
      </g>

      {/* Two tiny ground sprigs for warmth */}
      <g transform="translate(15 96)" opacity="0.5">
        <path d="M 0 0 Q -2 -6 0 -10" />
        <path d="M -1 -6 Q -5 -8 -4 -4 Q -2 -3 -1 -6 Z" fill="#27500A" />
      </g>
      <g transform="translate(225 96)" opacity="0.5">
        <path d="M 0 0 Q 2 -6 0 -10" />
        <path d="M 1 -6 Q 5 -8 4 -4 Q 2 -3 1 -6 Z" fill="#27500A" />
      </g>
    </svg>
  );
}
