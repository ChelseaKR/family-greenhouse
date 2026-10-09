import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

const runner = vi.hoisted(() => ({ runPushAction: vi.fn() }));
vi.mock('@/services/pushActionRunner', () => ({
  runPushAction: runner.runPushAction,
  SNOOZE_DAYS: 1,
}));

import {
  initPushActions,
  performPushAction,
  pushActionFromId,
  readPushActionMessage,
  readPushTaskRef,
  PUSH_ACTION_MESSAGE_TYPE,
  __resetPushActionsForTests,
} from '@/services/pushActions';

const client = { invalidateQueries: vi.fn() } as unknown as QueryClient;

describe('push action requests', () => {
  it('recognises the two action ids and nothing else', () => {
    expect(pushActionFromId('done')).toBe('done');
    expect(pushActionFromId('snooze')).toBe('snooze');
    expect(pushActionFromId('tap')).toBeNull();
    expect(pushActionFromId('dismiss')).toBeNull();
    expect(pushActionFromId('')).toBeNull();
    expect(pushActionFromId(undefined)).toBeNull();
    expect(pushActionFromId({ toString: () => 'done' })).toBeNull();
  });

  it('reads the task ids by name and drops everything else', () => {
    expect(
      readPushTaskRef({
        taskId: 't1',
        plantId: 'p1',
        expectedNextDue: '2026-06-01T08:00:00.000Z',
        aps: { alert: {} },
        url: 'https://familygreenhouse.net/plants/p1',
        notes: 'private',
      })
    ).toEqual({ taskId: 't1', plantId: 'p1', expectedNextDue: '2026-06-01T08:00:00.000Z' });
    expect(readPushTaskRef({ taskId: 't1' })).toEqual({ taskId: 't1' });
    expect(readPushTaskRef({ taskId: '  ', plantId: 'p1' })).toBeNull();
    expect(readPushTaskRef({ plantId: 'p1' })).toBeNull();
    expect(readPushTaskRef({ taskId: 42 })).toBeNull();
    expect(readPushTaskRef('t1')).toBeNull();
    expect(readPushTaskRef(null)).toBeNull();
  });

  it('accepts only a well-formed worker message', () => {
    const message = { type: PUSH_ACTION_MESSAGE_TYPE, action: 'done', taskId: 't1', plantId: 'p1' };
    expect(readPushActionMessage(message)).toEqual({ action: 'done', taskId: 't1', plantId: 'p1' });
    expect(readPushActionMessage({ ...message, type: 'other' })).toBeNull();
    expect(readPushActionMessage({ ...message, action: 'delete' })).toBeNull();
    expect(readPushActionMessage({ ...message, taskId: '' })).toBeNull();
    expect(readPushActionMessage('fg:push-action')).toBeNull();
  });
});

describe('performing a push action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPushActionsForTests();
  });
  afterEach(() => __resetPushActionsForTests());

  it('runs the request with the query client the app registered', async () => {
    runner.runPushAction.mockResolvedValue('done');
    initPushActions(client);

    await expect(performPushAction({ action: 'done', taskId: 't1' })).resolves.toBe('done');
    expect(runner.runPushAction).toHaveBeenCalledWith({ action: 'done', taskId: 't1' }, client);
  });

  it('reports failure instead of throwing when the runner cannot run', async () => {
    runner.runPushAction.mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(performPushAction({ action: 'snooze', taskId: 't1' })).resolves.toBe('failed');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('listening for the service worker', () => {
  const container = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    startMessages: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetPushActionsForTests();
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
    delete (window as { Capacitor?: unknown }).Capacitor;
  });
  afterEach(() => {
    __resetPushActionsForTests();
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  function handler(): (event: { data: unknown }) => void {
    const call = container.addEventListener.mock.calls.find(([type]) => type === 'message');
    if (!call) throw new Error('no message listener attached');
    return call[1] as (event: { data: unknown }) => void;
  }

  it('attaches once, and starts queued messages so a page the worker opened hears its action', () => {
    initPushActions(client);
    initPushActions(client);

    expect(container.addEventListener).toHaveBeenCalledTimes(1);
    expect(container.addEventListener.mock.calls[0][0]).toBe('message');
    expect(container.startMessages).toHaveBeenCalledTimes(1);
  });

  it('performs a well-formed action message and ignores every other message', async () => {
    runner.runPushAction.mockResolvedValue('done');
    initPushActions(client);
    const onMessage = handler();

    onMessage({ data: { type: PUSH_ACTION_MESSAGE_TYPE, action: 'done', taskId: 't1' } });
    onMessage({ data: { type: 'workbox-broadcast', payload: {} } });
    onMessage({ data: 'hello' });
    onMessage({ data: { type: PUSH_ACTION_MESSAGE_TYPE, action: 'done' } });
    await vi.waitFor(() => expect(runner.runPushAction).toHaveBeenCalledTimes(1));

    expect(runner.runPushAction).toHaveBeenCalledWith({ action: 'done', taskId: 't1' }, client);
  });

  it('does not listen inside the native shells, which have no worker', () => {
    (window as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };

    initPushActions(client);

    expect(container.addEventListener).not.toHaveBeenCalled();
  });
});
