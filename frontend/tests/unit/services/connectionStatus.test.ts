import { afterEach, describe, expect, it } from 'vitest';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import { createConnectionStore, isNoAnswer } from '@/services/connectionStatus';

function noAnswer(): AxiosError {
  return new AxiosError('Network Error', 'ERR_NETWORK');
}

function answered(status: number): AxiosError {
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: 'x',
    data: {},
    headers: {},
    config: { headers: new AxiosHeaders() },
  });
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('isNoAnswer', () => {
  it('is true only when no response arrived', () => {
    expect(isNoAnswer(noAnswer())).toBe(true);
    expect(isNoAnswer(answered(500))).toBe(false);
    expect(isNoAnswer(new Error('bug in our code'))).toBe(false);
  });
});

describe('connection store', () => {
  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('starts from the newest data already in the cache', () => {
    const queryClient = client();
    queryClient.setQueryData(['plants', 'hh'], []);
    const store = createConnectionStore(queryClient);
    expect(store.getState().online).toBe(true);
    expect(store.getState().reachable).toBe(true);
    expect(store.getState().lastSyncedAt).toBeGreaterThan(0);
  });

  it('marks the API unreachable when a read gets no answer, and reachable again on the next one', async () => {
    const queryClient = client();
    const store = createConnectionStore(queryClient);

    await queryClient
      .fetchQuery({ queryKey: ['tasks'], queryFn: () => Promise.reject(noAnswer()) })
      .catch(() => undefined);
    expect(store.getState().reachable).toBe(false);
    expect(store.getState().lastSyncedAt).toBeNull();

    await queryClient.fetchQuery({ queryKey: ['tasks'], queryFn: () => Promise.resolve([]) });
    expect(store.getState().reachable).toBe(true);
    expect(store.getState().lastSyncedAt).toBeGreaterThan(0);
  });

  it('counts an error status as an answer: the server is there', async () => {
    const queryClient = client();
    const store = createConnectionStore(queryClient);
    await queryClient
      .fetchQuery({ queryKey: ['a'], queryFn: () => Promise.reject(noAnswer()) })
      .catch(() => undefined);
    await queryClient
      .fetchQuery({ queryKey: ['b'], queryFn: () => Promise.reject(answered(500)) })
      .catch(() => undefined);
    expect(store.getState().reachable).toBe(true);
  });

  it('follows the online manager and tells its subscribers', () => {
    const store = createConnectionStore(client());
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);

    onlineManager.setOnline(false);
    expect(store.getState().online).toBe(false);
    onlineManager.setOnline(true);
    expect(store.getState().online).toBe(true);
    expect(calls).toBe(2);

    unsubscribe();
    onlineManager.setOnline(false);
    expect(calls).toBe(2);
  });
});
