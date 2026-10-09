import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type WorkerListener = (event: {
  data?: { json: () => unknown; text: () => string };
  notification?: { data?: Record<string, unknown>; close: () => void };
  action?: string;
  waitUntil: (promise: Promise<unknown>) => void;
}) => void;

const workerSource = readFileSync(resolve(process.cwd(), 'public/push-handler.js'), 'utf8');

function loadWorker(options: { maxActions?: number; windows?: unknown[] } = {}) {
  const listeners = new Map<string, WorkerListener>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue(options.windows ?? []);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const workerSelf = {
    location: { origin: 'https://familygreenhouse.test' },
    registration: { showNotification },
    clients: { matchAll, openWindow },
    addEventListener: vi.fn((type: string, listener: WorkerListener) => {
      listeners.set(type, listener);
    }),
  };

  const context: Record<string, unknown> = { self: workerSelf, URL };
  if (options.maxActions !== undefined) context.Notification = { maxActions: options.maxActions };
  vm.runInNewContext(workerSource, context);
  return { listeners, showNotification, matchAll, openWindow };
}

const SINGLE_TASK = {
  title: 'Water the Fern',
  body: 'Due today. Mark it done once you have, or snooze it until tomorrow.',
  url: '/plants/p1?task=t1#care',
  tag: 'reminder-hh-2026-06-01',
  task: { taskId: 't1', plantId: 'p1', expectedNextDue: '2026-06-01T08:00:00.000Z' },
  actions: { done: 'Done', snooze: 'Snooze until tomorrow' },
};

function pushEvent(payload: unknown) {
  let completion: Promise<unknown> | undefined;
  return {
    event: {
      data: { json: () => payload, text: () => '' },
      waitUntil: (promise: Promise<unknown>) => {
        completion = promise;
      },
    },
    done: () => completion,
  };
}

function clickEvent(data: Record<string, unknown>, action = '') {
  let completion: Promise<unknown> | undefined;
  const close = vi.fn();
  return {
    event: {
      notification: { data, close },
      action,
      waitUntil: (promise: Promise<unknown>) => {
        completion = promise;
      },
    },
    close,
    done: () => completion,
  };
}

describe('push service worker', () => {
  it('turns the server payload into a visible background notification', async () => {
    const { listeners, showNotification } = loadWorker();
    const { event, done } = pushEvent({
      title: 'Fern needs water',
      body: 'Watering is due today.',
      url: '/tasks?filter=due',
      tag: 'task-123',
    });

    listeners.get('push')?.(event);
    await done();

    expect(showNotification).toHaveBeenCalledWith(
      'Fern needs water',
      expect.objectContaining({
        body: 'Watering is due today.',
        tag: 'task-123',
        icon: '/brand/icon-192.png',
        badge: '/brand/icon-192.png',
        data: { url: 'https://familygreenhouse.test/tasks?filter=due' },
      })
    );
    expect(showNotification.mock.calls[0][1]).not.toHaveProperty('actions');
  });

  it('opens notification links and refuses cross-origin destinations', async () => {
    const { listeners, openWindow } = loadWorker();
    const { event, close, done } = clickEvent({ url: 'https://phishing.example/steal' });

    listeners.get('notificationclick')?.(event);
    await done();

    expect(close).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledWith('https://familygreenhouse.test/');
  });

  describe('a reminder about one task', () => {
    it('shows Done and Snooze buttons where the browser allows them, and keeps the task ids', async () => {
      const { listeners, showNotification } = loadWorker({ maxActions: 2 });
      const { event, done } = pushEvent(SINGLE_TASK);

      listeners.get('push')?.(event);
      await done();

      expect(showNotification).toHaveBeenCalledWith(
        'Water the Fern',
        expect.objectContaining({
          actions: [
            { action: 'done', title: 'Done' },
            { action: 'snooze', title: 'Snooze until tomorrow' },
          ],
          data: {
            url: 'https://familygreenhouse.test/plants/p1?task=t1#care',
            task: { taskId: 't1', plantId: 'p1', expectedNextDue: '2026-06-01T08:00:00.000Z' },
          },
        })
      );
    });

    it('shows no buttons where the browser has no room for them, and still carries the task', async () => {
      for (const maxActions of [undefined, 0, 1]) {
        const { listeners, showNotification } = loadWorker({ maxActions });
        const { event, done } = pushEvent(SINGLE_TASK);
        listeners.get('push')?.(event);
        await done();
        const options = showNotification.mock.calls[0][1] as Record<string, unknown>;
        expect(options).not.toHaveProperty('actions');
        expect(options.data).toMatchObject({ task: { taskId: 't1' } });
      }
    });

    it('shows no buttons for a reminder that names no task, whatever labels it carries', async () => {
      const { listeners, showNotification } = loadWorker({ maxActions: 2 });
      const { event, done } = pushEvent({ ...SINGLE_TASK, task: undefined });
      listeners.get('push')?.(event);
      await done();
      const options = showNotification.mock.calls[0][1] as Record<string, unknown>;
      expect(options).not.toHaveProperty('actions');
      expect(options.data).toEqual({ url: 'https://familygreenhouse.test/plants/p1?task=t1#care' });
    });

    it('reads only the three ids from the task, never anything else the payload puts there', async () => {
      const { listeners, showNotification } = loadWorker({ maxActions: 2 });
      const { event, done } = pushEvent({
        ...SINGLE_TASK,
        task: { ...SINGLE_TASK.task, notes: 'private', token: 'secret' },
      });
      listeners.get('push')?.(event);
      await done();
      const options = showNotification.mock.calls[0][1] as { data: { task: unknown } };
      expect(options.data.task).toEqual(SINGLE_TASK.task);
    });
  });

  describe('a chosen action', () => {
    const data = {
      url: 'https://familygreenhouse.test/plants/p1?task=t1#care',
      task: SINGLE_TASK.task,
    };
    const expectedMessage = {
      type: 'fg:push-action',
      action: 'done',
      taskId: 't1',
      plantId: 'p1',
      expectedNextDue: '2026-06-01T08:00:00.000Z',
    };

    it('is handed to an open page as a message, without navigating it away', async () => {
      const page = {
        url: 'https://familygreenhouse.test/dashboard',
        postMessage: vi.fn(),
        focus: vi.fn(),
        navigate: vi.fn(),
      };
      const { listeners, openWindow } = loadWorker({ windows: [page] });
      const { event, close, done } = clickEvent(data, 'done');

      listeners.get('notificationclick')?.(event);
      await done();

      expect(close).toHaveBeenCalledOnce();
      expect(page.postMessage).toHaveBeenCalledWith(expectedMessage);
      expect(page.navigate).not.toHaveBeenCalled();
      expect(openWindow).not.toHaveBeenCalled();
    });

    it('opens the task plant when no page is open, and hands the action to that page', async () => {
      const opened = { postMessage: vi.fn() };
      const { listeners, openWindow } = loadWorker();
      openWindow.mockResolvedValue(opened);
      const { event, done } = clickEvent(data, 'snooze');

      listeners.get('notificationclick')?.(event);
      await done();

      expect(openWindow).toHaveBeenCalledWith(
        'https://familygreenhouse.test/plants/p1?task=t1#care'
      );
      expect(opened.postMessage).toHaveBeenCalledWith({ ...expectedMessage, action: 'snooze' });
    });

    it('changes nothing when the page could not be opened', async () => {
      const { listeners, openWindow } = loadWorker();
      openWindow.mockResolvedValue(null);
      const { event, done } = clickEvent(data, 'done');

      listeners.get('notificationclick')?.(event);
      await expect(done()).resolves.toBeUndefined();
    });

    it('is ignored for an action id the page does not know, and for a notification with no task', async () => {
      const page = {
        url: 'https://familygreenhouse.test/dashboard',
        postMessage: vi.fn(),
        focus: vi.fn(),
      };
      const { listeners } = loadWorker({ windows: [page] });

      const unknown = clickEvent(data, 'archive');
      listeners.get('notificationclick')?.(unknown.event);
      await unknown.done();
      expect(page.postMessage).not.toHaveBeenCalled();
      // A plain tap on an open page focuses it at the link, as before.
      expect(page.focus).toHaveBeenCalledOnce();

      const noTask = clickEvent({ url: data.url }, 'done');
      listeners.get('notificationclick')?.(noTask.event);
      await noTask.done();
      expect(page.postMessage).not.toHaveBeenCalled();
    });
  });
});
