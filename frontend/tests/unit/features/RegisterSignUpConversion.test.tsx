import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { RegisterPage } from '@/features/auth/RegisterPage';
import { initGoogleAnalytics } from '@/services/googleAnalytics';
import { server } from '../../msw/server';

/**
 * The GA4 `sign_up` event, wired end to end: the real register form, the real
 * GA module, the real `dataLayer`. RegisterPage.test.tsx mocks
 * `trackGoogleConversion`, and googleAnalytics.test.ts calls it directly, so
 * until this file nothing proved that a completed sign-up reaches the
 * dataLayer gtag.js reads.
 *
 * Why it was checked (2026-10-23): GA4 showed 0 `sign_up` in 28 days while
 * Cognito had new accounts. The code path is not broken. GA4 has no
 * `/confirm-email` page view in that window either, so those accounts were
 * created where GA does not run by design: the native app, a browser
 * sending Global Privacy Control or Do Not Track (the post-deploy smoke
 * declares GPC), or a blocked gtag.js. The last test here pins that
 * exclusion, so a zero in GA4 is read as "no web sign-ups GA could see",
 * not "no sign-ups".
 */
const API = 'http://localhost:4000';
const ID = 'G-L2JN3PQ75P';

function events(name: string): unknown[][] {
  return (window.dataLayer ?? [])
    .map((entry) => Array.from(entry as ArrayLike<unknown>))
    .filter((command) => command[0] === 'event' && command[1] === name);
}

function setGpc(value: unknown) {
  Object.defineProperty(globalThis.navigator, 'globalPrivacyControl', {
    value,
    configurable: true,
  });
}

/** Fill and submit the form; returns how many signup requests the API saw. */
async function signUp(signupStatus: number): Promise<() => number> {
  let requests = 0;
  server.use(
    http.post(`${API}/auth/signup`, () => {
      requests += 1;
      return HttpResponse.json({ message: 'ok' }, { status: signupStatus });
    })
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/register']}>
      <RegisterPage />
    </MemoryRouter>
  );
  await user.type(screen.getByLabelText(/full name/i), 'Ada Lovelace');
  await user.type(screen.getByLabelText(/email address/i), 'ada@example.com');
  await user.type(screen.getByLabelText(/^password\s*\*?$/i), 'Password1234');
  await user.click(screen.getByRole('button', { name: /create account/i }));
  return () => requests;
}

describe('GA4 sign_up from the register form', () => {
  beforeAll(() => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', ID);
    setGpc(undefined);
    localStorage.clear();
    // Positive control: GA really loads in this harness, or every assertion
    // below would pass against an empty dataLayer.
    expect(initGoogleAnalytics()).toBe(true);
  });
  afterEach(() => {
    setGpc(undefined);
    window.dataLayer?.splice(0);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    delete window.dataLayer;
  });

  it('pushes one sign_up, with nothing from the form, once the API accepts the account', async () => {
    await signUp(201);
    await waitFor(() => expect(events('sign_up')).toHaveLength(1));
    const [[, , params]] = events('sign_up');
    expect(params).toEqual({ method: 'email', page_location: expect.any(String) });
    expect(JSON.stringify(window.dataLayer)).not.toContain('ada@example.com');
    expect(JSON.stringify(window.dataLayer)).not.toContain('Lovelace');
  });

  it('pushes nothing when the API refuses the account', async () => {
    await signUp(400);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(events('sign_up')).toHaveLength(0);
  });

  it('pushes nothing under Global Privacy Control, which is why GA4 can undercount sign-ups', async () => {
    setGpc(true);
    // The sabotage applied: the signal is really set.
    expect((navigator as Navigator & { globalPrivacyControl?: unknown }).globalPrivacyControl).toBe(
      true
    );
    const requests = await signUp(201);
    // The account was really created; only the GA event is withheld.
    await waitFor(() => expect(requests()).toBe(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled()
    );
    expect(events('sign_up')).toHaveLength(0);
  });
});
