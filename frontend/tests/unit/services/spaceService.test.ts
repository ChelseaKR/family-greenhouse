import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { spaceService } from '@/services/spaceService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

const space = {
  id: 'sp-1',
  householdId: 'hh-1',
  name: 'Sunroom',
  environment: 'indoor' as const,
  rainExposure: null,
  lightLevel: 'bright' as const,
  petAccess: false,
  defaultCaregiverId: null,
  createdAt: '',
  createdBy: 'u1',
};

describe('spaceService', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'access-1' });
  });

  it('lists the household spaces', async () => {
    server.use(http.get(`${API}/spaces`, () => HttpResponse.json([space])));

    await expect(spaceService.getSpaces()).resolves.toHaveLength(1);
  });

  it('creates a space with its placement attributes', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/spaces`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(space);
      })
    );

    await spaceService.createSpace({
      name: 'Sunroom',
      environment: 'indoor',
      lightLevel: 'bright',
      petAccess: false,
    });

    expect(body).toEqual({
      name: 'Sunroom',
      environment: 'indoor',
      lightLevel: 'bright',
      petAccess: false,
    });
  });

  it('updates only the fields the caller passed', async () => {
    let body: unknown;
    server.use(
      http.put(`${API}/spaces/sp-1`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...space, defaultCaregiverId: 'u2' });
      })
    );

    await expect(
      spaceService.updateSpace('sp-1', { defaultCaregiverId: 'u2' })
    ).resolves.toMatchObject({ defaultCaregiverId: 'u2' });
    expect(body).toEqual({ defaultCaregiverId: 'u2' });
  });

  it('deletes a space by id', async () => {
    let deleted = false;
    server.use(
      http.delete(`${API}/spaces/sp-1`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      })
    );

    await spaceService.deleteSpace('sp-1');

    expect(deleted).toBe(true);
  });
});
