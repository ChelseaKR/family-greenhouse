import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PullToRefresh } from '@/components/PullToRefresh';
import PullToRefreshGesture, { PULL_THRESHOLD_PX } from '@/components/PullToRefreshGesture';

function renderPull(component: 'wrapper' | 'gesture' = 'gesture') {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={queryClient}>
      {component === 'wrapper' ? <PullToRefresh /> : <PullToRefreshGesture />}
    </QueryClientProvider>
  );
  return invalidate;
}

function touch(type: string, y: number, target: EventTarget = document.body) {
  const event = new Event(type, { bubbles: true }) as Event & {
    touches: Array<{ clientY: number }>;
  };
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** A pull whose finger travel, after the 0.5 resistance, lands at `pulled`. */
function pull(pulled: number, target: EventTarget = document.body) {
  touch('touchstart', 100, target);
  touch('touchmove', 100 + pulled * 2, target);
  touch('touchend', 0, target);
}

describe('PullToRefresh', () => {
  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    document.body.innerHTML = '';
  });

  it('attaches nothing on the website', () => {
    const invalidate = renderPull('wrapper');
    pull(PULL_THRESHOLD_PX + 10);
    expect(invalidate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pull-to-refresh-indicator')).not.toBeInTheDocument();
  });

  describe('inside the native shells', () => {
    beforeEach(() => {
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
      };
    });

    it('loads the gesture inside the shells', async () => {
      renderPull('wrapper');
      expect(await screen.findByTestId('pull-to-refresh-indicator')).toBeInTheDocument();
    });

    it('refetches what is on screen after a full pull from the top, and says so', async () => {
      const invalidate = renderPull();
      pull(PULL_THRESHOLD_PX + 10);
      expect(invalidate).toHaveBeenCalledWith({ refetchType: 'active' });
      expect(await screen.findByRole('status')).toHaveTextContent('Updated');
    });

    it('does nothing for a short pull', () => {
      const invalidate = renderPull();
      pull(PULL_THRESHOLD_PX - 10);
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('ignores a drag that starts in a field or under an open dialog', () => {
      const invalidate = renderPull();
      const input = document.createElement('textarea');
      document.body.appendChild(input);
      pull(PULL_THRESHOLD_PX + 10, input);

      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      document.body.appendChild(dialog);
      pull(PULL_THRESHOLD_PX + 10);

      expect(invalidate).not.toHaveBeenCalled();
    });

    it('ignores a pull when the page is scrolled down', () => {
      const invalidate = renderPull();
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
      pull(PULL_THRESHOLD_PX + 10);
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
      expect(invalidate).not.toHaveBeenCalled();
    });
  });
});
