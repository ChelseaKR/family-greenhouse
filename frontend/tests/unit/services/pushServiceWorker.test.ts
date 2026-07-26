import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type WorkerListener = (event: {
  data?: { json: () => unknown; text: () => string };
  notification?: { data?: { url?: string }; close: () => void };
  waitUntil: (promise: Promise<unknown>) => void;
}) => void;

const workerSource = readFileSync(resolve(process.cwd(), 'public/push-handler.js'), 'utf8');

function loadWorker() {
  const listeners = new Map<string, WorkerListener>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue([]);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const workerSelf = {
    location: { origin: 'https://familygreenhouse.test' },
    registration: { showNotification },
    clients: { matchAll, openWindow },
    addEventListener: vi.fn((type: string, listener: WorkerListener) => {
      listeners.set(type, listener);
    }),
  };

  vm.runInNewContext(workerSource, { self: workerSelf, URL });
  return { listeners, showNotification, matchAll, openWindow };
}

describe('push service worker', () => {
  it('turns the server payload into a visible background notification', async () => {
    const { listeners, showNotification } = loadWorker();
    let completion: Promise<unknown> | undefined;

    listeners.get('push')?.({
      data: {
        json: () => ({
          title: 'Fern needs water',
          body: 'Watering is due today.',
          url: '/tasks?filter=due',
          tag: 'task-123',
        }),
        text: () => '',
      },
      waitUntil: (promise) => {
        completion = promise;
      },
    });
    await completion;

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
  });

  it('opens notification links and refuses cross-origin destinations', async () => {
    const { listeners, openWindow } = loadWorker();
    const close = vi.fn();
    let completion: Promise<unknown> | undefined;

    listeners.get('notificationclick')?.({
      notification: { data: { url: 'https://phishing.example/steal' }, close },
      waitUntil: (promise) => {
        completion = promise;
      },
    });
    await completion;

    expect(close).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledWith('https://familygreenhouse.test/');
  });
});
