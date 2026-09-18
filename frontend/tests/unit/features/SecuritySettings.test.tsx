import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { axe, toHaveNoViolations } from 'jest-axe';
import { SecuritySettings } from '@/features/settings/SecuritySettings';
import { otpauthUri, groupSecret } from '@/services/securityService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

expect.extend(toHaveNoViolations);
declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
}

const API = 'http://localhost:4000';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function renderSecurity() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SecuritySettings />
    </QueryClientProvider>
  );
}

/** Records what the page sent, so tests assert the wire and not just the UI. */
function securityServer(initiallyEnabled: boolean) {
  let enabled = initiallyEnabled;
  const sent = {
    setup: [] as Array<{ body: unknown; accessToken: string | null }>,
    verify: [] as Array<{ body: unknown; accessToken: string | null }>,
    disable: [] as unknown[],
  };
  server.use(
    http.get(`${API}/auth/mfa`, () => HttpResponse.json({ totp: { enabled } })),
    http.post(`${API}/auth/mfa/totp/setup`, async ({ request }) => {
      const body = (await request.json()) as { password: string };
      sent.setup.push({ body, accessToken: request.headers.get('x-cognito-access-token') });
      if (body.password !== 'Password1234') {
        return HttpResponse.json(
          { message: 'nope', details: { code: 'REAUTH_FAILED' } },
          { status: 400 }
        );
      }
      return HttpResponse.json(
        { secretCode: SECRET },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }),
    http.post(`${API}/auth/mfa/totp/verify`, async ({ request }) => {
      const body = (await request.json()) as { code: string };
      sent.verify.push({ body, accessToken: request.headers.get('x-cognito-access-token') });
      if (body.code !== '123456') {
        return HttpResponse.json(
          { message: 'mismatch', details: { code: 'INVALID_CODE' } },
          { status: 400 }
        );
      }
      enabled = true;
      return HttpResponse.json({ totp: { enabled: true } });
    }),
    http.post(`${API}/auth/mfa/totp/disable`, async ({ request }) => {
      const body = (await request.json()) as { password: string; code: string };
      sent.disable.push(body);
      if (body.password !== 'Password1234' || body.code !== '123456') {
        return HttpResponse.json(
          { message: 'nope', details: { code: 'INVALID_CODE' } },
          { status: 400 }
        );
      }
      enabled = false;
      return HttpResponse.json({ totp: { enabled: false } });
    })
  );
  return sent;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useAuthStore.setState({
    idToken: 'id-1',
    accessToken: 'access-1',
    user: {
      id: 'u1',
      email: 'test@example.com',
      name: 'Test',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
  });
});

describe('SecuritySettings — status', () => {
  it('a failed status read is shown as a failure, never as "off"', async () => {
    server.use(
      http.get(`${API}/auth/mfa`, () => HttpResponse.json({ message: 'boom' }, { status: 500 }))
    );
    renderSecurity();
    expect(await screen.findByText(/couldn.t check whether two-step/i)).toBeInTheDocument();
    expect(screen.queryByText(/two-step verification is off/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /set up an authenticator/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('on: shows the recovery guidance and the turn-off control, not setup', async () => {
    securityServer(true);
    renderSecurity();
    expect(await screen.findByText(/two-step verification is on\./i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /keep a way back in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /turn off two-step/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /set up an authenticator/i })
    ).not.toBeInTheDocument();
  });
});

describe('SecuritySettings — enrolment', () => {
  it('password, then QR + key, then one code; the secret is never stored', async () => {
    const sent = securityServer(false);
    const user = userEvent.setup();
    const { container } = renderSecurity();

    await user.click(await screen.findByRole('button', { name: /set up an authenticator/i }));
    const password = screen.getByLabelText(/current password/i);
    await waitFor(() => expect(password).toHaveFocus());

    // Wrong password first: refused, no secret on screen.
    await user.type(password, 'wrong');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/password isn.t right/i)).toBeInTheDocument();
    expect(screen.queryByTestId('totp-secret')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText(/current password/i));
    await user.type(screen.getByLabelText(/current password/i), 'Password1234');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    const heading = await screen.findByRole('heading', { name: /add family greenhouse to your/i });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByTestId('totp-secret')).toHaveTextContent(groupSecret(SECRET));
    expect(
      await screen.findByRole('img', { name: /qr code for adding family greenhouse/i })
    ).toBeInTheDocument();
    // The access token rides its own header, as Cognito's self-service calls need.
    expect(sent.setup.at(-1)?.accessToken).toBe('access-1');

    // Structural a11y on the busiest step: labelled inputs, named image, lists.
    expect(
      await axe(container, { runOnly: { type: 'tag', values: WCAG_TAGS } })
    ).toHaveNoViolations();

    // A wrong first code leaves it off and keeps the key on screen.
    await user.type(screen.getByLabelText(/6-digit code from the app/i), '000000');
    await user.click(screen.getByRole('button', { name: /turn on two-step/i }));
    expect(await screen.findByText(/code didn.t match/i)).toBeInTheDocument();
    expect(screen.getByTestId('totp-secret')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/6-digit code from the app/i), '123 456');
    await user.click(screen.getByRole('button', { name: /turn on two-step/i }));

    const done = await screen.findByRole('heading', { name: /two-step verification is on/i });
    await waitFor(() => expect(done).toHaveFocus());
    expect(screen.getByRole('heading', { name: /keep a way back in/i })).toBeInTheDocument();
    expect(screen.queryByTestId('totp-secret')).not.toBeInTheDocument();
    expect(sent.verify.map((v) => v.body)).toEqual([{ code: '000000' }, { code: '123456' }]);

    // Nothing about the factor reached browser storage at any point.
    const stored = [
      ...Object.keys(localStorage).map((k) => localStorage.getItem(k)),
      ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)),
    ].join('\n');
    expect(stored).not.toContain(SECRET);

    await user.click(screen.getByRole('button', { name: /^done$/i }));
    const status = await screen.findByTestId('totp-status');
    expect(status).toHaveTextContent(/two-step verification is on/i);
    await waitFor(() => expect(status).toHaveFocus());
  });

  it('cancel returns focus to the setup button', async () => {
    securityServer(false);
    const user = userEvent.setup();
    renderSecurity();
    await user.click(await screen.findByRole('button', { name: /set up an authenticator/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    const setUp = await screen.findByRole('button', { name: /set up an authenticator/i });
    await waitFor(() => expect(setUp).toHaveFocus());
  });
});

describe('SecuritySettings — turning it off', () => {
  it('needs the password AND a code; both reach the server', async () => {
    const sent = securityServer(true);
    const user = userEvent.setup();
    renderSecurity();

    await user.click(await screen.findByRole('button', { name: /turn off two-step/i }));
    const form = screen.getByRole('form', { name: /turn off two-step/i });
    await waitFor(() => expect(within(form).getByLabelText(/current password/i)).toHaveFocus());

    // Code missing: refused before any request.
    await user.type(within(form).getByLabelText(/current password/i), 'Password1234');
    await user.click(within(form).getByRole('button', { name: /^turn off$/i }));
    expect(await within(form).findByText(/enter the 6 digits/i)).toBeInTheDocument();
    expect(sent.disable).toHaveLength(0);

    await user.type(within(form).getByLabelText(/6-digit code/i), '123456');
    await user.click(within(form).getByRole('button', { name: /^turn off$/i }));

    expect(await screen.findByText(/two-step verification is off\.$/i)).toBeInTheDocument();
    expect(sent.disable).toEqual([{ password: 'Password1234', code: '123456' }]);
    expect(
      await screen.findByRole('button', { name: /set up an authenticator/i })
    ).toBeInTheDocument();
  });
});

describe('otpauthUri', () => {
  it('builds the Key Uri Format authenticator apps read, issuer on both sides', () => {
    const uri = otpauthUri(SECRET, 'a+b@example.com');
    expect(uri.startsWith('otpauth://totp/Family%20Greenhouse:a%2Bb%40example.com?')).toBe(true);
    const params = new URL(uri.replace('otpauth://', 'https://')).searchParams;
    expect(params.get('secret')).toBe(SECRET);
    expect(params.get('issuer')).toBe('Family Greenhouse');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });
});
