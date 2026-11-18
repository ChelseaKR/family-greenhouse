import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClientProvider, useQuery, type QueryClient } from '@tanstack/react-query';
import { createAppQueryClient } from '@/services/queryClient';
import { useAuthStore, type User } from '@/store/authStore';

const alice: User = {
  id: 'user-alice',
  email: 'alice@example.com',
  name: 'Alice',
  householdId: 'hh-alice',
  householdRole: 'admin',
};
const bob: User = { ...alice, id: 'user-bob', email: 'bob@example.com', householdId: 'hh-bob' };

function signIn(user: User) {
  useAuthStore.setState({ user, isAuthenticated: true });
}

function cachedKeys(client: QueryClient) {
  return client
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey[0]);
}

describe('createAppQueryClient', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      activeHouseholdId: null,
      idToken: null,
      accessToken: null,
      refreshToken: null,
    });
  });

  it("drops the account's reads when it signs out, so the next person cannot see them", () => {
    signIn(alice);
    const client = createAppQueryClient();
    client.setQueryData(['me', 'households'], [{ householdId: 'hh-alice', name: "Alice's home" }]);
    client.setQueryData(['plants', 'hh-alice'], [{ id: 'p1', notes: 'private' }]);

    useAuthStore.getState().logout();

    expect(client.getQueryData(['me', 'households'])).toBeUndefined();
    expect(client.getQueryData(['plants', 'hh-alice'])).toBeUndefined();
  });

  it('drops them when only this tab loses its session', () => {
    signIn(alice);
    const client = createAppQueryClient();
    client.setQueryData(['plants', 'hh-alice'], [{ id: 'p1' }]);

    useAuthStore.getState().clearLocalSession();

    expect(client.getQueryData(['plants', 'hh-alice'])).toBeUndefined();
  });

  it('drops them when another account replaces this one with no sign-out between', () => {
    signIn(alice);
    const client = createAppQueryClient();
    client.setQueryData(['me', 'households'], [{ householdId: 'hh-alice' }]);

    signIn(bob);

    expect(client.getQueryData(['me', 'households'])).toBeUndefined();
  });

  it('does not let a request still in flight at sign-out repopulate the cache', async () => {
    signIn(alice);
    const client = createAppQueryClient();
    let answer: (rows: string[]) => void = () => undefined;
    const fetching = client.fetchQuery({
      queryKey: ['plants', 'hh-alice'],
      queryFn: () =>
        new Promise<string[]>((resolve) => {
          answer = resolve;
        }),
    });

    useAuthStore.getState().logout();
    answer(['late answer']);
    await fetching.catch(() => undefined);

    expect(client.getQueryData(['plants', 'hh-alice'])).toBeUndefined();
  });

  it('keeps the cache when the same account is written again, as a session check does', () => {
    signIn(alice);
    const client = createAppQueryClient();
    client.setQueryData(['plants', 'hh-alice'], [{ id: 'p1' }]);

    signIn({ ...alice, name: 'Alice K', householdRole: 'member' });
    useAuthStore.setState({ idToken: 'refreshed' });

    expect(client.getQueryData(['plants', 'hh-alice'])).toEqual([{ id: 'p1' }]);
  });

  it('keeps public reads when someone signs in, because no account owned them', () => {
    const client = createAppQueryClient();
    client.setQueryData(['plans'], [{ id: 'garden' }]);

    signIn(alice);

    expect(cachedKeys(client)).toEqual(['plans']);
  });

  it('asks the server nothing as a signed-in query is torn down by sign-out', async () => {
    signIn(alice);
    const client = createAppQueryClient();
    const listHouseholds = vi.fn(async () => ['home']);

    function Switcher() {
      const enabled = useAuthStore((state) => !!state.user);
      const { data } = useQuery({
        queryKey: ['me', 'households'],
        queryFn: listHouseholds,
        enabled,
      });
      return <p>{data?.join(',') ?? 'no homes'}</p>;
    }

    render(
      <QueryClientProvider client={client}>
        <Switcher />
      </QueryClientProvider>
    );
    expect(await screen.findByText('home')).toBeInTheDocument();
    expect(listHouseholds).toHaveBeenCalledTimes(1);

    act(() => useAuthStore.getState().logout());

    expect(await screen.findByText('no homes')).toBeInTheDocument();
    expect(listHouseholds).toHaveBeenCalledTimes(1);
  });

  it("keeps the app's query defaults", () => {
    const { staleTime, retry, refetchOnWindowFocus } =
      createAppQueryClient().getDefaultOptions().queries!;
    expect({ staleTime, retry, refetchOnWindowFocus }).toEqual({
      staleTime: 300_000,
      retry: 1,
      refetchOnWindowFocus: false,
    });
  });
});
