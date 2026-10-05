import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AddTaskModal } from '@/features/plants/AddTaskModal';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * Add care task in the iOS app: a native form sheet (pr7e). The web dialog
 * does not render; the sheet's answer decides. Only a submit writes; Cancel,
 * a swipe down, or anything that is not exactly a submit closes without one.
 */
const native = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  hasNativeFormSheet: () => native.on,
}));
const sheet = vi.hoisted(() => ({
  present: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('@/services/nativeFormSheet', () => ({
  presentFormSheet: (request: unknown, onToken: (token: string) => void) => {
    onToken('sheet-1');
    return sheet.present(request);
  },
  dismissFormSheet: sheet.dismiss,
}));

const playHaptic = vi.hoisted(() => vi.fn());
vi.mock('@/services/nativeHaptics', () => ({ playHaptic }));

const API = 'http://localhost:4000';
let posts: unknown[] = [];

function renderModal(onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <AddTaskModal plantId="p1" isOpen onClose={onClose} />
    </QueryClientProvider>
  );
  return { onClose, ...utils };
}

beforeEach(() => {
  native.on = true;
  sheet.present.mockReset();
  sheet.dismiss.mockReset();
  playHaptic.mockReset();
  posts = [];
  useAuthStore.setState({
    accessToken: 'a',
    user: { id: 'u1', email: 'u@example.com', name: 'Me', householdId: 'hh-1' } as never,
  });
  server.use(
    http.post(`${API}/tasks`, async ({ request }) => {
      posts.push(await request.json());
      return HttpResponse.json({ id: 't9' });
    })
  );
});

describe('Add care task as a native form sheet', () => {
  it('opens the sheet with the form’s defaults, and no web dialog', async () => {
    sheet.present.mockReturnValue(new Promise(() => {}));
    renderModal();
    await waitFor(() => expect(sheet.present).toHaveBeenCalledTimes(1));
    expect(sheet.present.mock.calls[0][0]).toMatchObject({
      title: 'Add care task',
      submit: 'Add',
      fields: expect.arrayContaining([
        expect.objectContaining({ id: 'type', value: 'water' }),
        expect.objectContaining({ id: 'frequency', value: 7 }),
      ]),
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a submit saves exactly what the sheet sent, then closes', async () => {
    sheet.present.mockResolvedValue({
      values: { type: 'custom', customType: 'Rotate', frequency: 3, notes: 'Quarter turn' },
    });
    const { onClose } = renderModal();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // (The service adds the first due date itself, as on the web form.)
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      plantId: 'p1',
      type: 'custom',
      customType: 'Rotate',
      frequency: 3,
      notes: 'Quarter turn',
    });
    // The saved add plays the success haptic, as the web form's does (#944).
    expect(playHaptic.mock.calls).toEqual([['added']]);
  });

  it('Cancel or a swipe down (no values) closes, and writes nothing', async () => {
    sheet.present.mockResolvedValue({ values: null });
    const { onClose } = renderModal();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts).toEqual([]);
    expect(playHaptic).not.toHaveBeenCalled();
  });

  it('values this form never sends close it, and write nothing', async () => {
    sheet.present.mockResolvedValue({ values: { type: 'water', frequency: '7' } });
    const { onClose } = renderModal();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(posts).toEqual([]);
  });

  it('a refused save opens the sheet again with what was entered and why', async () => {
    server.use(
      http.post(`${API}/tasks`, async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({ message: 'Plan limit reached' }, { status: 403 });
      })
    );
    // Any answer past the two scripted ones is "no values": an extra sheet
    // closes rather than looping on a server that always refuses.
    sheet.present
      .mockResolvedValue({ values: null })
      .mockResolvedValueOnce({ values: { type: 'prune', frequency: 30, notes: '' } })
      .mockResolvedValueOnce({ values: null });
    const { onClose } = renderModal();
    await waitFor(() => expect(sheet.present).toHaveBeenCalledTimes(2));
    expect(sheet.present.mock.calls[1][0]).toMatchObject({
      message: 'Plan limit reached',
      fields: expect.arrayContaining([
        expect.objectContaining({ id: 'type', value: 'prune' }),
        expect.objectContaining({ id: 'frequency', value: 30 }),
      ]),
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(posts).toHaveLength(1);
  });

  it('closing it from the web (the page goes away) closes the native sheet too', async () => {
    sheet.present.mockReturnValue(new Promise(() => {}));
    const { unmount } = renderModal();
    await waitFor(() => expect(sheet.present).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(sheet.dismiss).toHaveBeenCalledWith('sheet-1'));
  });

  it('an app without form sheets, or the website, keeps the web dialog', async () => {
    native.on = false;
    renderModal();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(sheet.present).not.toHaveBeenCalled();
  });
});
