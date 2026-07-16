import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

describe('plantService', () => {
  it('getPlants returns the array', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(
      http.get(`${API}/plants`, () =>
        HttpResponse.json([
          {
            id: 'p1',
            householdId: 'hh',
            name: 'Pothos',
            species: null,
            location: null,
            imageUrl: null,
            notes: null,
            createdAt: '',
            createdBy: '',
            updatedAt: '',
          },
        ])
      )
    );
    const plants = await plantService.getPlants();
    expect(plants).toHaveLength(1);
  });

  it('getPlant unwraps PlantWithTasks', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(
      http.get(`${API}/plants/p1`, () =>
        HttpResponse.json({
          id: 'p1',
          householdId: 'hh',
          name: 'Pothos',
          species: null,
          location: null,
          imageUrl: null,
          notes: null,
          createdAt: '',
          createdBy: '',
          updatedAt: '',
          upcomingTasks: [],
          recentCompletions: [],
        })
      )
    );
    const plant = await plantService.getPlant('p1');
    expect(plant.upcomingTasks).toEqual([]);
    expect(plant.recentCompletions).toEqual([]);
  });

  it('createPlant POSTs the payload', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    let received: unknown;
    server.use(
      http.post(`${API}/plants`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json(
          {
            id: 'p2',
            householdId: 'hh',
            name: 'Pothos',
            species: null,
            location: null,
            imageUrl: null,
            notes: null,
            createdAt: '',
            createdBy: '',
            updatedAt: '',
          },
          { status: 201 }
        );
      })
    );
    const plant = await plantService.createPlant({ name: 'Pothos' });
    expect(plant.id).toBe('p2');
    expect(received).toEqual({ name: 'Pothos' });
  });

  it('deletePlant resolves on 204', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(http.delete(`${API}/plants/p1`, () => new HttpResponse(null, { status: 204 })));
    await expect(plantService.deletePlant('p1')).resolves.toBeUndefined();
  });

  it('moves a batch of plants to a space', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    let received: unknown;
    server.use(
      http.post(`${API}/plants/move`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json([{ id: 'p1', name: 'Pothos', spaceId: 'space-1' }]);
      })
    );

    const plants = await plantService.movePlants({ plantIds: ['p1'], spaceId: 'space-1' });

    expect(received).toEqual({ plantIds: ['p1'], spaceId: 'space-1' });
    expect(plants[0].spaceId).toBe('space-1');
  });

  it('archives a plant through the lifecycle endpoint', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    let received: unknown;
    server.use(
      http.put(`${API}/plants/p1`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({ id: 'p1', name: 'Pothos', status: 'archived' });
      })
    );

    const plant = await plantService.setPlantStatus('p1', 'archived');

    expect(received).toEqual({ status: 'archived' });
    expect(plant.status).toBe('archived');
  });
});
