/* global self */

const DEFAULT_TITLE = 'Family Greenhouse';
const DEFAULT_DESTINATION = '/';

function readPushPayload(event) {
  if (!event.data) return {};
  try {
    const parsed = event.data.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    try {
      const body = event.data.text();
      return body ? { body } : {};
    } catch {
      return {};
    }
  }
}

function safeDestination(value) {
  try {
    const destination = new URL(
      typeof value === 'string' && value ? value : DEFAULT_DESTINATION,
      self.location.origin
    );
    // Push payloads originate on the server, but still treat their link as
    // untrusted input. Notification clicks must never navigate to another
    // origin.
    if (destination.origin === self.location.origin) return destination.href;
  } catch {
    // Fall through to the app home page.
  }
  return new URL(DEFAULT_DESTINATION, self.location.origin).href;
}

self.addEventListener('push', (event) => {
  const payload = readPushPayload(event);
  const title =
    typeof payload.title === 'string' && payload.title.trim() ? payload.title : DEFAULT_TITLE;
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: '/brand/icon-192.png',
    badge: '/brand/icon-192.png',
    data: { url: safeDestination(payload.url) },
  };
  if (typeof payload.tag === 'string' && payload.tag) {
    options.tag = payload.tag;
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = safeDestination(event.notification.data?.url);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const target = windows.find((client) => client.url === targetUrl);
      if (target) return target.focus();

      const existingAppWindow = windows[0];
      if (existingAppWindow) {
        if ('navigate' in existingAppWindow) {
          await existingAppWindow.navigate(targetUrl);
        }
        return existingAppWindow.focus();
      }

      return self.clients.openWindow ? self.clients.openWindow(targetUrl) : undefined;
    })()
  );
});
