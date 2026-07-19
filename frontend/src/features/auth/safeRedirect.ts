const REDIRECT_VALIDATION_ORIGIN = 'https://family-greenhouse.invalid';

/**
 * Accept only root-relative, same-origin app locations.
 *
 * Browser URL parsing treats backslashes like forward slashes for special
 * schemes, so `/\\evil.example` can become a network-path reference even
 * though it passes a simple `startsWith('/')` check. Decode the pathname a few
 * times as well so encoded and double-encoded separator variants cannot cross
 * the register -> confirm -> login handoff.
 */
export function safeAppRedirect(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/')) return null;

  const pathEnd = value.search(/[?#]/);
  let pathname = pathEnd === -1 ? value : value.slice(0, pathEnd);

  for (let depth = 0; depth < 5; depth += 1) {
    if (pathname.startsWith('//') || pathname.includes('\\')) return null;

    try {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    } catch {
      return null;
    }
  }

  if (pathname.startsWith('//') || pathname.includes('\\')) return null;

  try {
    const resolved = new URL(value, `${REDIRECT_VALIDATION_ORIGIN}/`);
    if (resolved.origin !== REDIRECT_VALIDATION_ORIGIN) return null;
    if (resolved.pathname.startsWith('//') || resolved.pathname.includes('\\')) return null;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return null;
  }
}
