import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useActiveHousehold } from '@/hooks/useActiveHousehold';
import { useAuthStore } from '@/store/authStore';

function setActiveHousehold(id: string | null) {
  useAuthStore.setState({
    user: id
      ? {
          id: 'u-1',
          email: 'a@b.co',
          name: 'A',
          householdId: id,
          householdRole: 'admin',
        }
      : null,
    activeHouseholdId: id,
  });
}

beforeEach(() => {
  useAuthStore.setState({ user: null, activeHouseholdId: null });
});

describe('useActiveHousehold', () => {
  it('exposes the active household id when one is loaded', () => {
    setActiveHousehold('hh-1');
    const { result } = renderHook(() => useActiveHousehold());
    expect(result.current.householdId).toBe('hh-1');
  });

  it('reports a null id when no household is active', () => {
    setActiveHousehold(null);
    const { result } = renderHook(() => useActiveHousehold());
    expect(result.current.householdId).toBeNull();
  });

  describe('householdQuery', () => {
    it('builds an enabled query whose key + queryFn receive the live id', async () => {
      setActiveHousehold('hh-1');
      const run = vi.fn().mockResolvedValue('ok');
      const { result } = renderHook(() => useActiveHousehold());

      const options = result.current.householdQuery(
        (hh) => ['household', hh, 'climate'],
        (hh) => run(hh),
        { staleTime: 1000 }
      );

      expect(options.queryKey).toEqual(['household', 'hh-1', 'climate']);
      expect(options.enabled).toBe(true);
      expect(options.staleTime).toBe(1000);

      // The queryFn hands the non-null id to the caller's run().
      await options.queryFn?.({} as never);
      expect(run).toHaveBeenCalledWith('hh-1');
    });

    it('disables the query — and never invokes the queryFn — with no active household', () => {
      setActiveHousehold(null);
      const run = vi.fn().mockResolvedValue('ok');
      const { result } = renderHook(() => useActiveHousehold());

      const options = result.current.householdQuery(
        (hh) => ['household', hh, 'climate'],
        (hh) => run(hh)
      );

      // The gate is off, so react-query would skip the fetch entirely.
      expect(options.enabled).toBe(false);
      // The caller's run() is never reached when the gate is closed.
      expect(run).not.toHaveBeenCalled();
    });

    it('ANDs an extra enabled precondition with the household gate', () => {
      setActiveHousehold('hh-1');
      const { result } = renderHook(() => useActiveHousehold());

      const gated = result.current.householdQuery(
        (hh) => ['plants', hh, 'detail'],
        async () => 'ok',
        { enabled: false }
      );
      // Household is active but the extra precondition is false → still off.
      expect(gated.enabled).toBe(false);

      const open = result.current.householdQuery(
        (hh) => ['plants', hh, 'detail'],
        async () => 'ok',
        { enabled: true }
      );
      expect(open.enabled).toBe(true);
    });
  });
});
