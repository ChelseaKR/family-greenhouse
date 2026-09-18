import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { SecuritySettings } from '@/features/settings/SecuritySettings';
import { useAuthStore } from '@/store/authStore';
import { bufferToBase64url } from '@/lib/webauthn';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
type WindowWithShims = Window & { PublicKeyCredential?: unknown; Capacitor?: unknown };

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

const CREATION_OPTIONS = {
  challenge: bufferToBase64url(bytes(1, 2, 3)),
  rp: { id: 'familygreenhouse.net', name: 'Family Greenhouse' },
  user: { id: bufferToBase64url(bytes(9)), name: 'test@example.com', displayName: 'Test' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
};

const create = vi.fn();

function installWebAuthn() {
  (window as WindowWithShims).PublicKeyCredential = function PublicKeyCredential() {};
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create, get: vi.fn() },
  });
}

function fakeCredential() {
  return {
    id: 'new-cred',
    rawId: bytes(4),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: bytes(5),
      attestationObject: bytes(6),
      getTransports: () => ['internal'],
    },
  };
}

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

function passkeyServer(opts: { totp?: boolean; available?: boolean } = {}) {
  let passkeys = [
    {
      id: 'cred-1',
      name: 'iCloud Keychain',
      createdAt: '2026-09-18T10:00:00.000Z',
      attachment: 'platform',
    },
  ];
  const sent = {
    start: [] as unknown[],
    finish: [] as unknown[],
    deleted: [] as string[],
    listAccessTokens: [] as Array<string | null>,
    probes: 0,
  };
  server.use(
    http.get(`${API}/auth/mfa`, () => HttpResponse.json({ totp: { enabled: opts.totp ?? false } })),
    http.get(`${API}/auth/passkeys/available`, () => {
      sent.probes += 1;
      return HttpResponse.json({ available: opts.available ?? true });
    }),
    http.get(`${API}/auth/passkeys`, ({ request }) => {
      sent.listAccessTokens.push(request.headers.get('x-cognito-access-token'));
      return HttpResponse.json({ passkeys });
    }),
    http.post(`${API}/auth/passkeys/register/start`, async ({ request }) => {
      const body = (await request.json()) as { password: string; code?: string };
      sent.start.push(body);
      if (body.password !== 'Password1234') {
        return HttpResponse.json(
          { message: 'nope', details: { code: 'REAUTH_FAILED' } },
          { status: 400 }
        );
      }
      return HttpResponse.json({ options: CREATION_OPTIONS });
    }),
    http.post(`${API}/auth/passkeys/register/finish`, async ({ request }) => {
      const body = (await request.json()) as { credential: { id: string } };
      sent.finish.push(body);
      passkeys = [
        ...passkeys,
        { id: body.credential.id, name: 'Chrome', createdAt: null, attachment: 'platform' },
      ];
      return HttpResponse.json({ added: true }, { status: 201 });
    }),
    http.delete(`${API}/auth/passkeys/:id`, ({ params }) => {
      sent.deleted.push(String(params.id));
      passkeys = passkeys.filter((p) => p.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    })
  );
  return sent;
}

beforeEach(() => {
  create.mockReset();
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

afterEach(() => {
  delete (window as WindowWithShims).PublicKeyCredential;
  delete (window as WindowWithShims).Capacitor;
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: undefined });
});

describe('Passkeys card — where it appears', () => {
  it('absent without WebAuthn, and the availability probe is never asked', async () => {
    // Only /auth/mfa is served: an unexpected probe request fails the test
    // (msw's onUnhandledRequest is "error").
    server.use(http.get(`${API}/auth/mfa`, () => HttpResponse.json({ totp: { enabled: false } })));
    renderSecurity();
    expect(await screen.findByText(/two-step verification is off/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^passkeys$/i })).not.toBeInTheDocument();
  });

  it('absent inside the native shell, even with WebAuthn present and passkeys on', async () => {
    installWebAuthn();
    (window as WindowWithShims).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    // The deployment says "on": only the native gate can keep the card away.
    const sent = passkeyServer({ available: true });
    renderSecurity();
    expect(await screen.findByText(/two-step verification is off/i)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('heading', { name: /^passkeys$/i })).not.toBeInTheDocument();
    expect(sent.probes).toBe(0);
  });

  it('absent when the deployment has passkeys off', async () => {
    installWebAuthn();
    const sent = passkeyServer({ available: false });
    renderSecurity();
    expect(await screen.findByText(/two-step verification is off/i)).toBeInTheDocument();
    // The probe really was asked (and answered "off") before absence is judged,
    // so this cannot pass merely because nothing had loaded yet.
    await waitFor(() => expect(sent.probes).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('heading', { name: /^passkeys$/i })).not.toBeInTheDocument();
    expect(sent.listAccessTokens).toHaveLength(0);
  });
});

describe('Passkeys card — list, add, remove', () => {
  it('lists passkeys with the access-token header', async () => {
    installWebAuthn();
    const sent = passkeyServer();
    renderSecurity();
    const list = await screen.findByRole('list', { name: /your passkeys/i });
    expect(within(list).getByText('iCloud Keychain')).toBeInTheDocument();
    expect(sent.listAccessTokens[0]).toBe('access-1');
  });

  it('a failed list read says so; it is never "No passkeys yet"', async () => {
    installWebAuthn();
    passkeyServer();
    server.use(
      http.get(`${API}/auth/passkeys`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );
    renderSecurity();
    expect(await screen.findByText(/couldn.t load your passkeys/i)).toBeInTheDocument();
    expect(screen.queryByText(/no passkeys yet/i)).not.toBeInTheDocument();
  });

  it('adds: password first, then the browser ceremony, then the attestation JSON', async () => {
    installWebAuthn();
    create.mockResolvedValue(fakeCredential());
    const sent = passkeyServer();
    const user = userEvent.setup();
    renderSecurity();

    await user.click(await screen.findByRole('button', { name: /add a passkey/i }));
    const password = screen.getByLabelText(/current password/i);
    await waitFor(() => expect(password).toHaveFocus());
    // No code field when no authenticator app is on.
    expect(screen.queryByLabelText(/6-digit code/i)).not.toBeInTheDocument();
    await user.type(password, 'Password1234');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText(/passkey added/i)).toBeInTheDocument();
    expect(sent.start).toEqual([{ password: 'Password1234' }]);
    // The browser got byte-typed options…
    const publicKey = create.mock.calls[0][0].publicKey as PublicKeyCredentialCreationOptions;
    expect(Array.from(new Uint8Array(publicKey.challenge as ArrayBuffer))).toEqual([1, 2, 3]);
    // …and Cognito gets base64url JSON back.
    expect(sent.finish).toEqual([
      {
        credential: {
          id: 'new-cred',
          rawId: bufferToBase64url(bytes(4)),
          type: 'public-key',
          authenticatorAttachment: 'platform',
          clientExtensionResults: {},
          response: {
            clientDataJSON: bufferToBase64url(bytes(5)),
            attestationObject: bufferToBase64url(bytes(6)),
            transports: ['internal'],
          },
        },
      },
    ]);
  });

  it('with an authenticator app on, adding asks for the code too and sends it', async () => {
    installWebAuthn();
    create.mockResolvedValue(fakeCredential());
    const sent = passkeyServer({ totp: true });
    const user = userEvent.setup();
    renderSecurity();

    await user.click(await screen.findByRole('button', { name: /add a passkey/i }));
    const form = screen.getByRole('form', { name: /add a passkey/i });
    await user.type(within(form).getByLabelText(/current password/i), 'Password1234');
    const submit = within(form).getByRole('button', { name: /^continue$/i });
    expect(submit).toBeDisabled();
    await user.type(within(form).getByLabelText(/6-digit code/i), '123 456');
    await user.click(submit);

    expect(await screen.findByText(/passkey added/i)).toBeInTheDocument();
    expect(sent.start).toEqual([{ password: 'Password1234', code: '123456' }]);
  });

  it('a canceled browser sheet is named as such, and nothing is sent to finish', async () => {
    installWebAuthn();
    create.mockRejectedValue(new DOMException('The operation was canceled', 'NotAllowedError'));
    const sent = passkeyServer();
    const user = userEvent.setup();
    renderSecurity();

    await user.click(await screen.findByRole('button', { name: /add a passkey/i }));
    await user.type(screen.getByLabelText(/current password/i), 'Password1234');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText(/passkey creation was canceled/i)).toBeInTheDocument();
    expect(sent.finish).toHaveLength(0);
  });

  it('removes after confirming, by id', async () => {
    installWebAuthn();
    const sent = passkeyServer();
    const user = userEvent.setup();
    renderSecurity();

    await user.click(
      await screen.findByRole('button', { name: /remove passkey icloud keychain/i })
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /remove passkey/i }));

    expect(await screen.findByText(/passkey removed/i)).toBeInTheDocument();
    expect(sent.deleted).toEqual(['cred-1']);
    expect(await screen.findByText(/no passkeys yet/i)).toBeInTheDocument();
  });
});
