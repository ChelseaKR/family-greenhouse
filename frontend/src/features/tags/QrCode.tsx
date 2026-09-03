import { useMemo } from 'react';
import { encodeQr, qrToSvgPath, type QrEcLevel } from './qr';

interface QrCodeProps {
  /** The URL (or text) the code encodes. */
  value: string;
  /** Accessible name — the code itself is decorative to a screen reader. */
  title: string;
  /** Rendered edge length, any CSS length. Defaults to filling its box. */
  size?: string;
  ecLevel?: QrEcLevel;
  className?: string;
}

/**
 * A QR code as inline SVG — no canvas, no image request, no dependency
 * (see `./qr.ts` for why the encoder is in-house). SVG matters here because
 * the only thing that happens to this element is being printed: a vector
 * stays crisp at any printer DPI, where a 200px canvas bitmap does not.
 *
 * Error correction defaults to Q (~25% recoverable) rather than the usual M:
 * these codes get printed on paper, stuck in a pot, and splashed while
 * someone waters the plant.
 */
export function QrCode({ value, title, size, ecLevel = 'Q', className }: QrCodeProps) {
  const { path, extent } = useMemo(() => {
    const matrix = encodeQr(value, ecLevel);
    const quiet = 4; // the standard's minimum quiet zone, in modules
    return { path: qrToSvgPath(matrix, quiet), extent: matrix.length + quiet * 2 };
  }, [value, ecLevel]);

  return (
    <svg
      role="img"
      aria-label={title}
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      className={className}
      shapeRendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
