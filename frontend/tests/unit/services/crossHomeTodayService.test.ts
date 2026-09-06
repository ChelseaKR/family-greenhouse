import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  crossHomeTodayService,
  endOfLocalDay,
  isPlanLocked,
} from '@/services/crossHomeTodayService';
import { removeRow, patchRow } from '@/features/today/crossHomeMutations';
import type { CrossHomeToday } from '@/services/crossHomeTodayService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

describe('endOfLocalDay', () => {
  it('is the last millisecond of the given local calendar day', () => {
    const noon = new Date(2026, 8, 3, 12, 0, 0, 0);
    const end = new Date(endOfLocalDay(noon));
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(8);
    expect(end.getDate()).toBe(3);
    expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([
      23, 59, 59, 999,
    ]);
  });
});

describe('isPlanLocked', () => {
  function axiosErrorWithStatus(status: number): AxiosError {
    const config = { headers: new AxiosHeaders() };
    return new AxiosError('nope', 'ERR_BAD_REQUEST', config, null, {
      status,
      statusText: '',
      headers: {},
      config,
      data: {},
    });
  }

  it('is true only for a 402', () => {
    expect(isPlanLocked(axiosErrorWithStatus(402))).toBe(true);
    expect(isPlanLocked(axiosErrorWithStatus(403))).toBe(false);
    expect(isPlanLocked(axiosErrorWithStatus(500))).toBe(false);
    expect(isPlanLocked(new Error('network'))).toBe(false);
    expect(isPlanLocked(undefined)).toBe(false);
  });
});

describe('crossHomeTodayService', () => {
  it('sends the caller’s cutoff as `until`', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    let until: string | null = null;
    server.use(
      http.get(`${API}/me/today`, ({ request }) => {
        until = new URL(request.url).searchParams.get('until');
        return HttpResponse.json({ generatedAt: '', cutoff: '', households: [] });
      })
    );
    const result = await crossHomeTodayService.get('2026-09-03T23:59:59.999Z');
    expect(until).toBe('2026-09-03T23:59:59.999Z');
    expect(result.households).toEqual([]);
  });

  it('unclaims in the row’s own household, overriding the active-household pin', async () => {
    useAuthStore.setState({ accessToken: 'access-1', activeHouseholdId: 'hh-active' });
    let household: string | null = null;
    server.use(
      http.post(`${API}/tasks/t1/unclaim`, ({ request }) => {
        household = request.headers.get('x-household-id');
        return HttpResponse.json({ id: 't1', type: 'water' });
      })
    );
    await crossHomeTodayService.unclaimTask('hh-other', 't1');
    expect(household).toBe('hh-other');
  });
});

describe('cache patches', () => {
  const today: CrossHomeToday = {
    generatedAt: '',
    cutoff: '',
    households: [
      {
        householdId: 'hh-a',
        name: 'A',
        role: 'admin',
        status: 'ok',
        tasks: [
          {
            id: 't1',
            householdId: 'hh-a',
            householdName: 'A',
            plantId: 'p1',
            plantName: 'Fern',
            type: 'water',
            frequency: 7,
            lastCompleted: null,
            nextDue: '2026-09-03T12:00:00.000Z',
            assignedTo: null,
            assignedToName: null,
            notes: null,
            createdBy: 'u1',
            createdAt: '',
          },
        ],
      },
      { householdId: 'hh-b', name: null, role: 'member', status: 'unavailable' },
    ],
  };

  it('removeRow drops only the completed row and leaves unavailable homes alone', () => {
    const next = removeRow(today, 'hh-a', 't1');
    expect(next.households[0]).toMatchObject({ status: 'ok', tasks: [] });
    expect(next.households[1]).toEqual(today.households[1]);
    // A different home with the same task id is not touched.
    expect(removeRow(today, 'hh-b', 't1')).toEqual(today);
  });

  it('patchRow applies the server’s task and keeps the home label', () => {
    const next = patchRow(today, 'hh-a', {
      id: 't1',
      plantId: 'p1',
      plantName: 'Fern',
      type: 'water',
      frequency: 7,
      lastCompleted: null,
      nextDue: '2026-09-03T12:00:00.000Z',
      assignedTo: 'u1',
      assignedToName: 'Me',
      notes: null,
      createdBy: 'u1',
      createdAt: '',
    });
    const group = next.households[0];
    if (group.status !== 'ok') throw new Error('expected ok');
    expect(group.tasks[0]).toMatchObject({
      assignedTo: 'u1',
      assignedToName: 'Me',
      householdId: 'hh-a',
      householdName: 'A',
    });
  });
});
