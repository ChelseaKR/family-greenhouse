import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  caretakerVisitService,
  CaretakerLinkInactiveError,
} from '@/services/caretakerVisitService';

/**
 * The public caretaker client talks to the API with a bare `fetch` (no axios
 * interceptors) because a caretaker has no session to refresh. These tests pin
 * the two things that depend on: a 404/410 becomes the "link is no longer
 * active" error rather than a generic failure, and the photo add really is the
 * two-step presign → upload → confirm contract, so nothing is attached to a
 * plant that did not land in storage first.
 */
const API = 'http://localhost:4000';
const TOKEN = 'a'.repeat(64);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  vi.clearAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('caretakerVisitService', () => {
  it('turns a 404 into the inactive-link error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(caretakerVisitService.getView(TOKEN)).rejects.toBeInstanceOf(
      CaretakerLinkInactiveError
    );
  });

  it('turns a 410 into the inactive-link error too', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 410 }));
    await expect(caretakerVisitService.addNote(TOKEN, 'hi')).rejects.toBeInstanceOf(
      CaretakerLinkInactiveError
    );
  });

  it('surfaces other failures as ordinary errors, not as an expired link', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    await expect(caretakerVisitService.getView(TOKEN)).rejects.not.toBeInstanceOf(
      CaretakerLinkInactiveError
    );
  });

  it('sends the due date with a completion so a retry cannot skip a cycle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ visitRecorded: true }));
    globalThis.fetch = fetchMock;
    await caretakerVisitService.completeTask(TOKEN, 't1', '2026-09-03T00:00:00.000Z');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/caretaker/${TOKEN}/tasks/t1/complete`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      expectedNextDue: '2026-09-03T00:00:00.000Z',
    });
  });

  it('adds a photo as presign → upload → confirm, in that order', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ uploadUrl: 'https://upload.test/put', imageUrl: 'https://cdn.test/a.png' })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse({ imageUrl: 'https://cdn.test/a.png', visitRecorded: true })
      );
    globalThis.fetch = fetchMock;

    const file = new File(['bytes'], 'leaf.png', { type: 'image/png' });
    const result = await caretakerVisitService.addPhoto(TOKEN, 'p1', file);

    expect(result.visitRecorded).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/caretaker/${TOKEN}/plants/p1/photo`);
    expect(fetchMock.mock.calls[1][0]).toBe('https://upload.test/put');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('PUT');
    expect(fetchMock.mock.calls[2][0]).toBe(`${API}/caretaker/${TOKEN}/plants/p1/photo/confirm`);
  });

  it('never confirms a photo whose upload failed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ uploadUrl: 'https://upload.test/put', imageUrl: 'https://cdn.test/a.png' })
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    globalThis.fetch = fetchMock;

    const file = new File(['bytes'], 'leaf.png', { type: 'image/png' });
    await expect(caretakerVisitService.addPhoto(TOKEN, 'p1', file)).rejects.toThrow(
      /Photo upload failed/
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to jpeg for a file type the server does not presign', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ uploadUrl: 'https://upload.test/put', imageUrl: 'https://cdn.test/a.jpg' })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse({ imageUrl: 'https://cdn.test/a.jpg', visitRecorded: true })
      );
    globalThis.fetch = fetchMock;

    const file = new File(['bytes'], 'leaf.heic', { type: 'image/heic' });
    await caretakerVisitService.addPhoto(TOKEN, 'p1', file);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      contentType: 'image/jpeg',
    });
  });
});
