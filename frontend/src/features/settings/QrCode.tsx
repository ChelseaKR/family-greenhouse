import { useEffect, useState } from 'react';

interface QrCodeProps {
  value: string;
  /** Accessible name for the image. */
  label: string;
  /** Shown instead of the image if the encoder cannot load. */
  unavailableText: string;
}

/**
 * A QR code drawn in the browser. The payload here is an authenticator secret,
 * so it is never sent to a QR-image service; `uqr` encodes it locally and it
 * is rendered as plain SVG rectangles (no innerHTML). The encoder is loaded on
 * demand, so it costs nothing until someone opens authenticator setup.
 *
 * Always black on white, whatever the theme: authenticator cameras read dark
 * modules on a light field, and an inverted code fails in several of them.
 */
export function QrCode({ value, label, unavailableText }: QrCodeProps) {
  const [modules, setModules] = useState<boolean[][] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let canceled = false;
    setModules(null);
    setFailed(false);
    import('uqr')
      .then(({ encode }) => {
        if (!canceled) setModules(encode(value, { ecc: 'M', border: 2 }).data);
      })
      .catch(() => {
        if (!canceled) setFailed(true);
      });
    return () => {
      canceled = true;
    };
  }, [value]);

  if (failed) {
    return <p className="text-sm text-gray-700">{unavailableText}</p>;
  }
  if (!modules) {
    return <div className="h-48 w-48 animate-pulse rounded-md bg-gray-100" aria-hidden="true" />;
  }

  const size = modules.length;
  let path = '';
  modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    });
  });

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className="h-48 w-48 rounded-md border border-gray-200"
      shapeRendering="crispEdges"
      data-testid="totp-qr"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
