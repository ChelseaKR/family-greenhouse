/**
 * The shareable redeem link for a gift code, and the code a link carries.
 *
 * The code goes in the URL fragment (`/redeem#FG-XXXX-…`), never the query
 * string: a fragment is not sent to the server, so the bearer credential never
 * reaches API Gateway, CloudFront logs or Google Analytics' page_location.
 */

/**
 * Loose client-side shape check, mirroring the server's
 * `normalizeGiftCode`: case, spaces, dashes and the Crockford confusables.
 * Returns the display form `FG-XXXX-XXXX-XXXX-XXXX`, or null. The server
 * re-validates; this only keeps junk out of storage and the input.
 */
export function normalizeGiftCodeInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let raw = input;
  try {
    raw = decodeURIComponent(input);
  } catch {
    // A malformed escape is just more characters to reject below.
  }
  const stripped = raw
    .toUpperCase()
    .replace(/[\s\-_#]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (!stripped.startsWith('FG')) return null;
  const body = stripped.slice(2);
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(body)) return null;
  return ['FG', ...(body.match(/.{4}/g) ?? [])].join('-');
}

/** `https://familygreenhouse.net/redeem#FG-…` on whatever origin is serving the page. */
export function giftRedeemLink(code: string, origin: string = window.location.origin): string {
  return `${origin}/redeem#${code}`;
}
