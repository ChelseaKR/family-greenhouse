import '@testing-library/jest-dom';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { server } from './msw/server';
// Initialize i18next so components rendered in tests resolve real strings
// (e.g. zod validation messages built from `t(...)`) instead of raw keys.
import '@/i18n';

// Testing Library's async utilities (`findBy*`, `waitFor`) keep their own
// timeout, separate from vitest's `testTimeout`, and it defaults to 1s. On a
// contended machine that is not long enough for a React render plus its
// effects, and the failure reads as a missing element rather than as a slow
// one: "Unable to find role=button and name Use", with the element arriving
// moments later.
//
// Raising vitest's `testTimeout` alone does not help these, because the query
// gives up long before the test does. Measured on a 10-core laptop at load
// average 130, raising only `testTimeout` took one run from 37 failures to
// 12, and all 12 survivors were this: `findBy*` expiring at 1s.
//
// Nothing here asserts how QUICKLY an element appears, so a longer ceiling
// cannot make a broken test pass — an element that never renders still fails
// the test, just later. What it stops is a busy machine failing correct code.
configure({ asyncUtilTimeout: 5_000 });

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  writable: true,
});
Object.defineProperty(globalThis, 'sessionStorage', {
  value: new MemoryStorage(),
  writable: true,
});

beforeEach(async () => {
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
  const { useAuthStore } = await import('@/store/authStore');
  useAuthStore.setState({
    user: null,
    accessToken: null,
    refreshToken: null,
    isAuthenticated: false,
    isLoading: false,
  });
});

afterEach(() => {
  cleanup();
});

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock IntersectionObserver
class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}

Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: MockIntersectionObserver,
});

// Mock ResizeObserver
class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: MockResizeObserver,
});

// Mock scrollTo
window.scrollTo = vi.fn();
