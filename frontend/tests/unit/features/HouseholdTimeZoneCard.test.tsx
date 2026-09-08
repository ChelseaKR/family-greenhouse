/**
 * ADR 0025 phase 2 — the household timezone card.
 *
 * The assertions worth having here are not "the form submits". They are the
 * three the ADR's cutover depends on:
 *
 *   1. Unset and `'UTC'` are different states, and clearing produces the first
 *      rather than the second. Phase 4's guarantee — a household with no zone
 *      set keeps today's behaviour byte for byte — is exactly this distinction,
 *      and it is one line away from being collapsed by a convenience default.
 *   2. The browser's zone is offered and never written. A background write
 *      would move a household into the *chosen* state with nobody choosing.
 *   3. The card says nothing reads the zone yet. Phase 2 changes no answer, and
 *      copy that implied otherwise would be a false claim about live data.
 */
import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HouseholdTimeZoneCard } from '@/features/household/HouseholdTimeZoneCard';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderCard(timezone?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HouseholdTimeZoneCard householdId="hh-1" household={{ timezone }} />
    </QueryClientProvider>
  );
}

/** Pin the browser's reported zone for one test body. */
function withBrowserZone(zone: string | undefined, run: () => Promise<void>) {
  const real = Intl.DateTimeFormat;
  const stub = ((...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
    const instance = new real(...args);
    const originalResolved = instance.resolvedOptions.bind(instance);
    instance.resolvedOptions = () => ({
      ...originalResolved(),
      // `undefined` models a runtime that cannot name its zone; the helper
      // must answer null rather than guessing one.
      timeZone: zone as string,
    });
    return instance;
  }) as unknown as typeof Intl.DateTimeFormat;
  Object.assign(stub, real);
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(stub);
  return run().finally(() => vi.mocked(Intl.DateTimeFormat).mockRestore());
}

describe('HouseholdTimeZoneCard', () => {
  it('says no zone is set rather than showing a default nobody chose', () => {
    renderCard(undefined);
    expect(screen.getByText('No zone is set for this household yet.')).toBeInTheDocument();
    // An unset household has nothing to clear, so the destructive action is
    // absent rather than a no-op.
    expect(screen.queryByRole('button', { name: 'Clear time zone' })).not.toBeInTheDocument();
  });

  it('tells the reader that nothing consults the zone yet', () => {
    renderCard('America/New_York');
    expect(screen.getByText(/Nothing reads this yet\./, { exact: false })).toBeInTheDocument();
  });

  it('offers the browser zone as a suggestion and writes nothing on its own', async () => {
    let calls = 0;
    server.use(
      http.put(`${API}/households/hh-1/timezone`, () => {
        calls += 1;
        return HttpResponse.json({ timezone: 'Europe/Madrid' });
      })
    );
    await withBrowserZone('Europe/Madrid', async () => {
      renderCard(undefined);
      const input = screen.getByLabelText('IANA time zone');
      expect((input as HTMLInputElement).value).toBe('Europe/Madrid');
      expect(
        screen.getByText('This browser reports Europe/Madrid. Nothing is saved until you choose.')
      ).toBeInTheDocument();
      // The suggestion is seeded and NOT persisted: the household is still in
      // the "never set" state until the button is pressed.
      expect(screen.getByText('No zone is set for this household yet.')).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(0);
    });
  });

  it('says so when the browser cannot name its own zone, rather than suggesting UTC', async () => {
    await withBrowserZone(undefined, async () => {
      renderCard(undefined);
      expect(
        screen.getByText('This browser cannot report its own zone, so there is nothing to suggest.')
      ).toBeInTheDocument();
      expect((screen.getByLabelText('IANA time zone') as HTMLInputElement).value).toBe('');
    });
  });

  it('saves a zone the admin typed', async () => {
    let sent: unknown = null;
    server.use(
      http.put(`${API}/households/hh-1/timezone`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ timezone: 'Asia/Tokyo' });
      })
    );
    renderCard(undefined);
    const input = screen.getByLabelText('IANA time zone');
    await userEvent.clear(input);
    await userEvent.type(input, 'Asia/Tokyo');
    await userEvent.click(screen.getByRole('button', { name: 'Save time zone' }));
    await waitFor(() => expect(sent).toEqual({ timezone: 'Asia/Tokyo' }));
    expect(await screen.findByText('Time zone saved.')).toBeInTheDocument();
  });

  it('clears to unset, not to UTC — the distinction the cutover rests on', async () => {
    let sent: unknown = null;
    server.use(
      http.put(`${API}/households/hh-1/timezone`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ timezone: '' });
      })
    );
    renderCard('America/Los_Angeles');
    expect(screen.getByText('America/Los_Angeles')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear time zone' }));
    await waitFor(() => expect(sent).toEqual({ timezone: '' }));
    // The assertion that matters: the cleared body is the empty string, never
    // 'UTC'. A household that chose UTC and one that never chose are different
    // rows, and phase 4 branches on which.
    expect(sent).not.toEqual({ timezone: 'UTC' });
    expect(
      await screen.findByText(/back to having no zone set, which is not the same as choosing UTC/)
    ).toBeInTheDocument();
  });

  it('refuses a name that is not a zone, and says which shape is wanted', async () => {
    let calls = 0;
    server.use(
      http.put(`${API}/households/hh-1/timezone`, () => {
        calls += 1;
        return HttpResponse.json({ timezone: 'x' });
      })
    );
    renderCard(undefined);
    const input = screen.getByLabelText('IANA time zone');
    await userEvent.clear(input);
    await userEvent.type(input, 'Pacific Standard Time');
    expect(await screen.findByText(/not a time zone name this app recognises/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save time zone' })).toBeDisabled();
    expect(calls).toBe(0);
  });

  it('accepts a link name the canonical list omits, so it is never stricter than the server', async () => {
    let sent: unknown = null;
    server.use(
      http.put(`${API}/households/hh-1/timezone`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ timezone: 'US/Pacific' });
      })
    );
    renderCard(undefined);
    const input = screen.getByLabelText('IANA time zone');
    await userEvent.clear(input);
    // `Intl.supportedValuesOf('timeZone')` does not list the legacy link
    // names, and the backend accepts them. A client stricter than the server
    // refuses input the API would take.
    await userEvent.type(input, 'US/Pacific');
    expect(screen.queryByText(/not a time zone name/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save time zone' }));
    await waitFor(() => expect(sent).toEqual({ timezone: 'US/Pacific' }));
  });

  it('will not re-save the zone that is already stored', () => {
    renderCard('Europe/Lisbon');
    expect(screen.getByRole('button', { name: 'Save time zone' })).toBeDisabled();
  });

  it('surfaces a refused write rather than reporting a save that did not happen', async () => {
    server.use(
      http.put(`${API}/households/hh-1/timezone`, () =>
        HttpResponse.json({ error: 'Access denied' }, { status: 403 })
      )
    );
    renderCard(undefined);
    const input = screen.getByLabelText('IANA time zone');
    await userEvent.clear(input);
    await userEvent.type(input, 'Asia/Tokyo');
    await userEvent.click(screen.getByRole('button', { name: 'Save time zone' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Time zone saved.')).not.toBeInTheDocument();
  });
});
