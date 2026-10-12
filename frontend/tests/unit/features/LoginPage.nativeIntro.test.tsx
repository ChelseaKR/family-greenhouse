import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { LoginPage } from '@/features/auth/LoginPage';
import { introStart, noteSignedIn, resetNativeIntroStateForTests } from '@/lib/nativeIntroState';
import type { NativeIntroRequest, NativeIntroResult } from '@/config/nativeIntro';

/**
 * The iOS app's signed-out intro over the sign-in screen (ADR 0035): when it
 * is asked for, from which page, and what the web does with each answer. The
 * plugin is replaced here; the gate is the real `hasNativeIntro()`, with the
 * platform partially mocked as HelpPage.test.tsx does it, so the header check
 * runs for real against whatever plugins the test says the bridge lists.
 */

// What the pretend bridge is: hoisted with the mock, which modules loaded
// at import time already call.
const bridge = vi.hoisted(() => ({
  platform: 'ios' as 'ios' | 'android' | 'web',
  listed: [] as string[],
}));

vi.mock('@/lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform')>();
  return {
    ...actual,
    isNativeApp: vi.fn(() => bridge.platform !== 'web'),
    getNativePlatform: vi.fn(() => bridge.platform),
    hasNativePlugin: vi.fn(
      (name: string, methods: string[] = []) =>
        bridge.platform !== 'web' &&
        bridge.listed.includes(name) &&
        methods.every((m) => ['present', 'dismiss'].includes(m))
    ),
  };
});

type Answer = (result: NativeIntroResult | null) => void;
const presented: Array<{ request: Omit<NativeIntroRequest, 'token'>; answer: Answer }> = [];
const dismissed: string[] = [];

vi.mock('@/services/nativeIntro', () => ({
  presentIntro: vi.fn(
    (request: Omit<NativeIntroRequest, 'token'>, onToken: (token: string) => void) =>
      new Promise<NativeIntroResult | null>((resolve) => {
        onToken(`intro-${presented.length + 1}`);
        presented.push({ request, answer: resolve });
      })
  ),
  dismissIntro: vi.fn((token: string) => {
    dismissed.push(token);
    const shown = presented[Number(token.split('-')[1]) - 1];
    shown?.answer({ choice: null });
  }),
}));

/** A link away from sign-in and back, the way the sign-up screen's "Sign in" does. */
function Register() {
  const navigate = useNavigate();
  return (
    <div>
      <p>Register Page</p>
      <button type="button" onClick={() => navigate('/login')}>
        back to sign in
      </button>
    </div>
  );
}

function renderLogin(entry: string | { pathname: string; state: unknown } = '/login') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<Register />} />
        <Route path="/dashboard" element={<div>Dashboard Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  bridge.platform = 'ios';
  bridge.listed = ['NativeIntro'];
  presented.length = 0;
  dismissed.length = 0;
  resetNativeIntroStateForTests();
});

afterEach(() => {
  resetNativeIntroStateForTests();
});

describe('the intro in the iOS app', () => {
  it('opens on a plain signed-out start, with the whole story the first time', async () => {
    renderLogin();
    await waitFor(() => expect(presented).toHaveLength(1));
    expect(presented[0].request.start).toBe('story');
    expect(presented[0].request.pages.map((p) => p.id)).toEqual([
      'household',
      'claim',
      'away',
      'start',
    ]);
    expect(presented[0].request.create).toBe('Create account');
    // The sign-in form is there underneath, as before.
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('"Create account" opens the existing sign-up screen', async () => {
    renderLogin();
    await waitFor(() => expect(presented).toHaveLength(1));
    await act(async () => presented[0].answer({ choice: 'create' }));
    expect(await screen.findByText('Register Page')).toBeInTheDocument();
    expect(introStart()).toBe('final');
  });

  it('"I already have an account" stays on sign-in, with the email field focused', async () => {
    renderLogin();
    await waitFor(() => expect(presented).toHaveLength(1));
    await act(async () => presented[0].answer({ choice: 'signIn' }));
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toHaveFocus());
    expect(screen.queryByText('Register Page')).not.toBeInTheDocument();
    expect(introStart()).toBe('final');
  });

  it('an answer that is not a door leaves the sign-in screen as it is', async () => {
    renderLogin();
    await waitFor(() => expect(presented).toHaveLength(1));
    await act(async () =>
      presented[0].answer({ choice: 'purchase' } as unknown as NativeIntroResult)
    );
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.queryByText('Register Page')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).not.toHaveFocus();
  });

  it('a failed call is not counted as seen: the next install-fresh start tells the story', async () => {
    renderLogin();
    await waitFor(() => expect(presented).toHaveLength(1));
    await act(async () => presented[0].answer(null));
    expect(introStart()).toBe('story');
  });

  it('once answered, later starts open on the last page only', async () => {
    renderLogin();
    await waitFor(() => expect(presented).toHaveLength(1));
    await act(async () => presented[0].answer({ choice: 'signIn' }));

    // Signed in, then signed out: a new stretch.
    act(() => noteSignedIn());
    renderLogin();
    await waitFor(() => expect(presented).toHaveLength(2));
    expect(presented[1].request.start).toBe('final');
  });

  it('after a sign-in on this install (an upgrade from 0.41), sign-out shows only the last page', async () => {
    noteSignedIn();
    renderLogin();
    await waitFor(() => expect(presented).toHaveLength(1));
    expect(presented[0].request.start).toBe('final');
  });

  it('shows once per signed-out stretch: to sign-up and back does not bring it up again', async () => {
    renderLogin();
    await waitFor(() => expect(presented).toHaveLength(1));
    await act(async () => presented[0].answer({ choice: 'create' }));
    await screen.findByText('Register Page');
    act(() => screen.getByRole('button', { name: 'back to sign in' }).click());
    await screen.findByRole('button', { name: /^sign in$/i });
    // Give a second request every chance to happen.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(presented).toHaveLength(1);
  });

  it('goes away, unanswered, when the sign-in screen goes away first', async () => {
    const { unmount } = renderLogin();
    await waitFor(() => expect(presented).toHaveLength(1));
    unmount();
    await waitFor(() => expect(dismissed).toEqual(['intro-1']));
    // Not counted as seen, and the stretch's intro is free again.
    expect(introStart()).toBe('story');
    renderLogin();
    await waitFor(() => expect(presented).toHaveLength(2));
  });

  it('does not stand in front of someone who already chose to sign in', async () => {
    renderLogin('/login?redirect=/join/code-1');
    renderLogin({ pathname: '/login', state: { email: 'a@b.co', justConfirmed: true } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(presented).toHaveLength(0);
  });

  it('shows after a sign-out or a link that needs an account, and sign-up keeps where it was going', async () => {
    // What ProtectedRoute does to a signed-out visit to an app screen, and
    // what a sign-out can leave behind: the saved location in state.
    renderLogin({ pathname: '/login', state: { from: { pathname: '/plants/p1' } } });
    await waitFor(() => expect(presented).toHaveLength(1));
    await act(async () => presented[0].answer({ choice: 'create' }));
    expect(await screen.findByText('Register Page')).toBeInTheDocument();
  });

  it('offers only the sign-in door when registration is paused', async () => {
    vi.resetModules();
    vi.doMock('@/config/commercialStatus', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/config/commercialStatus')>()),
      PUBLIC_REGISTRATION_AVAILABLE: false,
    }));
    const { LoginPage: PausedLogin } = await import('@/features/auth/LoginPage');
    const state = await import('@/lib/nativeIntroState');
    state.resetNativeIntroStateForTests();
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<PausedLogin />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(presented).toHaveLength(1));
    expect(presented[0].request).not.toHaveProperty('create');
    vi.doUnmock('@/config/commercialStatus');
  });
});

describe('everywhere else, the sign-in screen exactly as before', () => {
  it.each([
    ['the website', 'web' as const, ['NativeIntro']],
    ['Android', 'android' as const, ['NativeIntro']],
    ['an iOS build without the plugin', 'ios' as const, []],
    ['an iOS build listing other plugins only', 'ios' as const, ['NativeChrome', 'SecureStorage']],
  ])('%s: no intro is asked for', async (_name, where, plugins) => {
    bridge.platform = where;
    bridge.listed = plugins;
    renderLogin();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign up free/i })).toHaveAttribute(
      'href',
      '/register'
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(presented).toHaveLength(0);
  });
});
