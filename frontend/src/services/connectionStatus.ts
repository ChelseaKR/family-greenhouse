import { onlineManager, type QueryClient } from '@tanstack/react-query';
import axios from 'axios';

/**
 * Is what's on screen current, and can a change be saved right now?
 *
 * Nothing answered either question before. Offline, a page that had already
 * loaded kept showing its data exactly as if it were live, and TanStack Query
 * paused every refetch silently, so a task list from this morning read as
 * the list now. A mutation made offline was paused too, with its optimistic
 * update already on screen, so "done" looked saved when it wasn't. And a
 * phone with a network that can't reach the API (a captive portal, a dead
 * zone, the API itself down) looked online to the browser while every read
 * failed.
 *
 * Three facts, from two sources:
 *  - `online`: what the OS/browser reports (TanStack's onlineManager, which
 *    also decides when paused queries and mutations resume).
 *  - `reachable`: whether the last API call got any answer at all. A request
 *    that fails with no response (axios error without `response`) means the
 *    server was not reached; any response, even an error status, means it was.
 *  - `lastSyncedAt`: when a read last succeeded, so the notice can say how
 *    old the screen is rather than only that it might be.
 */
export interface ConnectionState {
  online: boolean;
  reachable: boolean;
  lastSyncedAt: number | null;
}

/** A request that got no answer at all: offline, DNS, dropped, timed out. */
export function isNoAnswer(error: unknown): boolean {
  return axios.isAxiosError(error) && !error.response;
}

export interface ConnectionStore {
  getState: () => ConnectionState;
  subscribe: (listener: () => void) => () => void;
}

function newestData(queryClient: QueryClient): number | null {
  const times = queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.state.dataUpdatedAt)
    .filter((time) => time > 0);
  return times.length ? Math.max(...times) : null;
}

export function createConnectionStore(queryClient: QueryClient): ConnectionStore {
  let state: ConnectionState = {
    online: onlineManager.isOnline(),
    reachable: true,
    lastSyncedAt: newestData(queryClient),
  };
  const listeners = new Set<() => void>();

  const set = (patch: Partial<ConnectionState>) => {
    const next = { ...state, ...patch };
    if (
      next.online === state.online &&
      next.reachable === state.reachable &&
      next.lastSyncedAt === state.lastSyncedAt
    ) {
      return;
    }
    state = next;
    listeners.forEach((listener) => listener());
  };

  const answered = (at: number) =>
    set({ reachable: true, lastSyncedAt: Math.max(state.lastSyncedAt ?? 0, at) || null });

  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    if (event.action.type === 'success') answered(event.query.state.dataUpdatedAt);
    else if (event.action.type === 'error') {
      if (isNoAnswer(event.action.error)) set({ reachable: false });
      // An error status is still an answer: the server is there.
      else set({ reachable: true });
    }
  });
  queryClient.getMutationCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    if (event.action.type === 'success') set({ reachable: true });
    else if (event.action.type === 'error') set({ reachable: !isNoAnswer(event.action.error) });
  });
  onlineManager.subscribe((online) => set({ online }));

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const stores = new WeakMap<QueryClient, ConnectionStore>();

/** One store per QueryClient, created on first use and kept for its lifetime. */
export function connectionStoreFor(queryClient: QueryClient): ConnectionStore {
  let store = stores.get(queryClient);
  if (!store) {
    store = createConnectionStore(queryClient);
    stores.set(queryClient, store);
  }
  return store;
}
