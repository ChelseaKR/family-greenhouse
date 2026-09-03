import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server';
import { householdService } from '@/services/householdService';
import { useAuthStore } from '@/store/authStore';

const API = 'http://localhost:4000';

describe('householdService.getCoverage', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      isAuthenticated: true,
    } as never);
  });

  it('reads the coverage report for the household', async () => {
    let seenPath = '';
    server.use(
      http.get(`${API}/households/hh-1/analytics/coverage`, ({ request }) => {
        seenPath = new URL(request.url).pathname;
        return HttpResponse.json({
          members: [{ userId: 'u1', name: 'Priya' }],
          memberCount: 1,
          plantCount: 0,
          plants: [],
          soleCaregiverPlants: [],
          uncaredPlantCount: 0,
          awayRisks: [],
          generatedAt: '2026-09-03T00:00:00.000Z',
        });
      })
    );
    const report = await householdService.getCoverage('hh-1');
    expect(seenPath).toBe('/households/hh-1/analytics/coverage');
    expect(report.memberCount).toBe(1);
    expect(report.members).toEqual([{ userId: 'u1', name: 'Priya' }]);
  });

  it('rejects on a 402 so the caller can render the locked state', async () => {
    server.use(
      http.get(`${API}/households/hh-1/analytics/coverage`, () =>
        HttpResponse.json({ message: 'Garden plan and up' }, { status: 402 })
      )
    );
    await expect(householdService.getCoverage('hh-1')).rejects.toMatchObject({
      response: { status: 402 },
    });
  });
});
