import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { api } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * Cross-home Today (ADR 0017) acts on rows from homes other than the active
 * one by sending an explicit `X-Household-Id`. The request interceptor must
 * not overwrite that with the active-household pin — before this, it did.
 */
describe('X-Household-Id precedence', () => {
  function capturingPlants(sink: { value: string | null }) {
    return http.get(`${API}/plants`, ({ request }) => {
      sink.value = request.headers.get('x-household-id');
      return HttpResponse.json([]);
    });
  }

  it('keeps an explicit per-request X-Household-Id over the active-household pin', async () => {
    useAuthStore.setState({ accessToken: 'access-1', activeHouseholdId: 'hh-active' });
    const sink = { value: null as string | null };
    server.use(capturingPlants(sink));

    await api.get('/plants', { headers: { 'X-Household-Id': 'hh-explicit' } });

    expect(sink.value).toBe('hh-explicit');
  });

  it('still pins the active household when the request sets none', async () => {
    useAuthStore.setState({ accessToken: 'access-1', activeHouseholdId: 'hh-active' });
    const sink = { value: null as string | null };
    server.use(capturingPlants(sink));

    await api.get('/plants');

    expect(sink.value).toBe('hh-active');
  });

  it('sends no pin at all when there is neither an override nor an active household', async () => {
    useAuthStore.setState({ accessToken: 'access-1', activeHouseholdId: null });
    const sink = { value: null as string | null };
    server.use(capturingPlants(sink));

    await api.get('/plants');

    expect(sink.value).toBeNull();
  });
});
