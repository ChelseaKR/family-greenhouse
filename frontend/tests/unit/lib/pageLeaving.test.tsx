import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  isAbandonedChunkLoad,
  isChunkLoadError,
  isPageLeaving,
  resetPageLeavingForTests,
  watchPageLeaving,
} from '@/lib/pageLeaving';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

const reportFrontendError = vi.hoisted(() => vi.fn());
vi.mock('@/services/frontendTelemetry', () => ({ reportFrontendError }));

/**
 * Safari reports a route's code download cut short by leaving the page as
 * "Importing a module script failed". That is not an app failure: the route
 * boundary must not report it, while a real failed load still is reported.
 */
const SAFARI_ABORT = new TypeError('Importing a module script failed.');

function Throws({ error }: { error: Error }): never {
  throw error;
}

let target: EventTarget & Window;
beforeEach(() => {
  resetPageLeavingForTests();
  reportFrontendError.mockClear();
  target = new EventTarget() as EventTarget & Window;
  watchPageLeaving(target);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(console.error).mockRestore();
});

describe('page leaving', () => {
  it('knows the chunk-load errors of Safari, Chrome and Firefox', () => {
    expect(isChunkLoadError(SAFARI_ABORT)).toBe(true);
    expect(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /a.js'))
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('is leaving from beforeunload or pagehide, and not after a back/forward restore', () => {
    expect(isPageLeaving()).toBe(false);
    target.dispatchEvent(new Event('beforeunload'));
    expect(isPageLeaving()).toBe(true);
    const restored = new Event('pageshow') as Event & { persisted: boolean };
    Object.defineProperty(restored, 'persisted', { value: true });
    target.dispatchEvent(restored);
    expect(isPageLeaving()).toBe(false);
    target.dispatchEvent(new Event('pagehide'));
    expect(isPageLeaving()).toBe(true);
  });

  it('a leave that never happened (a mailto: link) stops counting after a few seconds', () => {
    target.dispatchEvent(new Event('beforeunload'));
    expect(isPageLeaving(Date.now() + 4_000)).toBe(true);
    expect(isPageLeaving(Date.now() + 6_000)).toBe(false);
  });
});

describe('the route boundary', () => {
  it('reports a failed code load while the page is staying', () => {
    render(
      <RouteErrorBoundary>
        <Throws error={SAFARI_ABORT} />
      </RouteErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(reportFrontendError).toHaveBeenCalledWith(SAFARI_ABORT);
    expect(isAbandonedChunkLoad(SAFARI_ABORT)).toBe(false);
  });

  it('reports nothing for a code load the browser cut short because the page is being left', () => {
    target.dispatchEvent(new Event('beforeunload'));
    render(
      <RouteErrorBoundary>
        <Throws error={SAFARI_ABORT} />
      </RouteErrorBoundary>
    );
    expect(reportFrontendError).not.toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.some((args) => args[0] === '[route-boundary]')).toBe(
      false
    );
  });

  it('still reports any other error while the page is being left', () => {
    target.dispatchEvent(new Event('beforeunload'));
    const real = new Error('render failed');
    render(
      <RouteErrorBoundary>
        <Throws error={real} />
      </RouteErrorBoundary>
    );
    expect(reportFrontendError).toHaveBeenCalledWith(real);
  });
});
