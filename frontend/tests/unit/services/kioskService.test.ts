import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  kioskService,
  KioskLinkInactiveError,
  KIOSK_FALLBACK_POLL_SECONDS,
} from '@/services/kioskService';

const TOKEN = 'a'.repeat(64);

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('kioskService.getView', () => {
  it('returns the task list and the server-chosen poll interval', async () => {
    mockFetch(200, { pollIntervalSeconds: 900, tasks: [] });
    const view = await kioskService.getView(TOKEN);
    expect(view.pollIntervalSeconds).toBe(900);
    expect(view.tasks).toEqual([]);
  });

  it('falls back to the SAME interval the server defaults to', async () => {
    // A client that guessed faster than the server would silently multiply
    // the monthly bill — this is the one feature costed by wall-clock time.
    mockFetch(200, { tasks: [] });
    const view = await kioskService.getView(TOKEN);
    expect(view.pollIntervalSeconds).toBe(KIOSK_FALLBACK_POLL_SECONDS);
    expect(KIOSK_FALLBACK_POLL_SECONDS).toBe(300);
  });

  it('throws rather than inventing an empty task list', async () => {
    // A malformed body is a read we did not get. Coercing it to [] would put
    // "all caught up" on a wall screen on the strength of nothing.
    mockFetch(200, { pollIntervalSeconds: 300 });
    await expect(kioskService.getView(TOKEN)).rejects.toThrow(/no task list/i);
  });

  it('raises KioskLinkInactiveError for a revoked or unknown token', async () => {
    mockFetch(404, { message: 'nope' });
    await expect(kioskService.getView(TOKEN)).rejects.toBeInstanceOf(KioskLinkInactiveError);
  });

  it('raises a plain error for a server failure, so the page says "couldn’t load"', async () => {
    mockFetch(500, { message: 'boom' });
    const error = await kioskService.getView(TOKEN).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(KioskLinkInactiveError);
  });

  it('percent-encodes the token into the path', async () => {
    const fetchMock = mockFetch(200, { pollIntervalSeconds: 300, tasks: [] });
    await kioskService.getView('a/b');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/kiosk/a%2Fb');
  });
});

describe('kioskService.completeTask', () => {
  it('sends the expected occurrence so a double tap cannot roll the schedule twice', async () => {
    const fetchMock = mockFetch(200, {
      taskId: 't1',
      plantName: 'Monstera',
      taskType: 'water',
      dueDate: '2026-09-10T00:00:00.000Z',
      spaceName: null,
      placementNote: null,
      overdue: false,
    });
    await kioskService.completeTask(TOKEN, 't1', '2026-09-03T00:00:00.000Z');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      expectedNextDue: '2026-09-03T00:00:00.000Z',
    });
  });

  it('raises KioskLinkInactiveError when the link died mid-session', async () => {
    mockFetch(404, { message: 'nope' });
    await expect(
      kioskService.completeTask(TOKEN, 't1', '2026-09-03T00:00:00.000Z')
    ).rejects.toBeInstanceOf(KioskLinkInactiveError);
  });
});
