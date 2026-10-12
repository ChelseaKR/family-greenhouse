import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TaskChecklist } from '@/features/tasks/TaskChecklist';

/**
 * Where the app plays its haptics (pr7b): the selection tick on a segment or
 * a tab change, the warning pattern on a destructive confirmation. What each
 * cue plays is tests/unit/services/nativeHaptics.test.ts.
 */
const playHaptic = vi.hoisted(() => vi.fn());
vi.mock('@/services/nativeHaptics', () => ({ playHaptic }));

const native = vi.hoisted(() => ({ listeners: {} as Record<string, (e: unknown) => void> }));
vi.mock('@/services/nativeChrome', () => ({
  NativeChrome: {
    addListener: (name: string, listener: (e: unknown) => void) => {
      native.listeners[name] = listener;
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
    configure: () => Promise.resolve(),
    update: () => Promise.resolve(),
  },
}));

beforeEach(() => {
  playHaptic.mockClear();
});

describe('the warning haptic on a destructive confirmation', () => {
  const dialog = (isOpen: boolean, variant: 'danger' | 'primary' = 'danger') => (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={() => {}}
      onConfirm={() => {}}
      title="Delete Fern?"
      message="It moves to the trash."
      variant={variant}
    />
  );

  it('plays once when a danger confirmation opens, not on re-render', () => {
    const { rerender } = render(dialog(false));
    expect(playHaptic).not.toHaveBeenCalled();
    rerender(dialog(true));
    rerender(dialog(true));
    expect(playHaptic.mock.calls).toEqual([['warning']]);
  });

  it('does not play for a confirmation that destroys nothing', () => {
    render(dialog(true, 'primary'));
    expect(playHaptic).not.toHaveBeenCalled();
  });
});

describe('the selection tick on the Tasks segments', () => {
  it('ticks when the segment changes, not when the current one is tapped again', async () => {
    const user = userEvent.setup();
    const onSegment = vi.fn();
    render(
      <MemoryRouter>
        <TaskChecklist
          segment="today"
          onSegment={onSegment}
          counts={{ today: 1, upcoming: 2 }}
          sections={[]}
          roomTitle={() => ''}
          householdEmpty={false}
          filtered={false}
          onClearFilters={() => {}}
          nextUp={null}
          taskName={() => 'Water'}
          roomOf={() => null}
          whoOf={() => ({ text: '', aria: '', open: true, you: false })}
          pending={new Set()}
          onCheck={() => {}}
          onMenu={() => {}}
          registerCheck={() => {}}
          extraFor={() => null}
          swipeActionsFor={() => []}
        />
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: /^Today/ }));
    expect(playHaptic).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^Upcoming/ }));
    expect(playHaptic.mock.calls).toEqual([['selection']]);
    expect(onSegment).toHaveBeenCalledWith('upcoming');
  });
});

describe('the selection tick on a native tab change', () => {
  it('ticks for a new tab, not for a tap on the tab already showing', async () => {
    const { default: NativeFrameBridge } = await import('@/components/NativeFrameBridge');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/plants']}>
          <NativeFrameBridge />
        </MemoryRouter>
      </QueryClientProvider>
    );
    await vi.waitFor(() => expect(native.listeners.tabSelect).toBeTypeOf('function'));
    act(() => native.listeners.tabSelect({ tab: 'plants', path: '/plants', reselect: true }));
    expect(playHaptic).not.toHaveBeenCalled();
    act(() => native.listeners.tabSelect({ tab: 'tasks', path: '/tasks', reselect: false }));
    expect(playHaptic.mock.calls).toEqual([['selection']]);
  });
});
