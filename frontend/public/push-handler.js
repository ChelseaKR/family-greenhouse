/* global self, Notification */

const DEFAULT_TITLE = 'Family Greenhouse';
const DEFAULT_DESTINATION = '/';

// The two things a person can do from a reminder about one task, and the
// message that hands the choice to a page. The ids and the message type must
// match frontend/src/services/pushActions.ts, which receives them.
const ACTION_IDS = ['done', 'snooze'];
const ACTION_MESSAGE_TYPE = 'fg:push-action';

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

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// The task a reminder is about: three ids, read by name, nothing else.
function readTask(value) {
  if (!value || typeof value !== 'object' || !nonEmptyString(value.taskId)) return null;
  const task = { taskId: value.taskId };
  if (nonEmptyString(value.plantId)) task.plantId = value.plantId;
  if (nonEmptyString(value.expectedNextDue)) task.expectedNextDue = value.expectedNextDue;
  return task;
}

// Action buttons, where this browser shows them (Chrome and Edge do; Firefox
// and Safari ignore `actions`, and asking for more than `maxActions` throws).
function actionsFor(payload, task) {
  if (!task || !payload.actions || typeof payload.actions !== 'object') return [];
  const max = typeof Notification !== 'undefined' ? Number(Notification.maxActions) : 0;
  const actions = [];
  for (const id of ACTION_IDS) {
    const title = payload.actions[id];
    if (nonEmptyString(title)) actions.push({ action: id, title });
  }
  return actions.length > 0 && max >= actions.length ? actions : [];
}

self.addEventListener('push', (event) => {
  const payload = readPushPayload(event);
  const title =
    typeof payload.title === 'string' && payload.title.trim() ? payload.title : DEFAULT_TITLE;
  const task = readTask(payload.task);
  const data = { url: safeDestination(payload.url) };
  if (task) data.task = task;
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: '/brand/icon-192.png',
    badge: '/brand/icon-192.png',
    data,
  };
  if (typeof payload.tag === 'string' && payload.tag) {
    options.tag = payload.tag;
  }
  const actions = actionsFor(payload, task);
  if (actions.length > 0) options.actions = actions;

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = safeDestination(data.url);
  const task = readTask(data.task);
  const action = task && ACTION_IDS.includes(event.action) ? event.action : null;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      if (action) {
        // The worker holds no session, so the page does the work with its
        // own: an open one quietly, or else the one opened at the task's
        // plant, which hears the message once it starts listening.
        const message = { type: ACTION_MESSAGE_TYPE, action, ...task };
        const existing = windows[0];
        if (existing) {
          existing.postMessage(message);
          return;
        }
        const opened = self.clients.openWindow ? await self.clients.openWindow(targetUrl) : null;
        if (opened && typeof opened.postMessage === 'function') opened.postMessage(message);
        return;
      }

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
