// Pure browser Web Push endpoint policy shared by Lambda persistence and the
// local HTTP server. Keep this module dependency-free: local development must
// not need DynamoDB environment variables merely to validate a URL.
const ALLOWED_PUSH_HOSTS = new Set([
  'android.googleapis.com',
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
]);
const ALLOWED_PUSH_HOST_SUFFIXES = ['.notify.windows.com', '.wns.windows.com'];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      (url.port === '' || url.port === '443') &&
      url.username === '' &&
      url.password === '' &&
      (ALLOWED_PUSH_HOSTS.has(hostname) ||
        ALLOWED_PUSH_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))
    );
  } catch {
    return false;
  }
}
