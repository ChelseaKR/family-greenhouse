/**
 * Perenual-backed species lookups. The safety-relevant distinction is between
 * "the provider says no toxicity data" and "we could not check" — an outage
 * must never render as a confirmed answer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { speciesService } from '@/services/speciesService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

const detail = {
  id: 42,
  commonName: 'Pothos',
  scientificName: 'Epipremnum aureum',
  thumbnailUrl: null,
  family: 'Araceae',
  cycle: 'Perennial',
  watering: 'average' as const,
  sunlight: ['part shade'],
  hardinessZone: '10-12',
  indoor: true,
  edible: false,
  poisonousToPets: true,
  defaultImageUrl: null,
};

describe('speciesService', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'access-1' });
  });

  it('search forwards the query and returns the provider source', async () => {
    let receivedUrl = '';
    server.use(
      http.get(`${API}/species/search`, ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({ source: 'perenual', results: [detail] });
      })
    );

    const response = await speciesService.search('pothos');

    expect(receivedUrl).toContain('q=pothos');
    expect(response.source).toBe('perenual');
    expect(response.results).toHaveLength(1);
  });

  it('search distinguishes a disabled integration from a transient outage', async () => {
    server.use(
      http.get(`${API}/species/search`, () =>
        HttpResponse.json({ source: 'disabled', results: [] })
      )
    );
    await expect(speciesService.search('pothos')).resolves.toMatchObject({ source: 'disabled' });

    server.use(
      http.get(`${API}/species/search`, () =>
        HttpResponse.json({ source: 'unavailable', results: [] })
      )
    );
    await expect(speciesService.search('pothos')).resolves.toMatchObject({ source: 'unavailable' });
  });

  it('detail unwraps the result and returns null when nothing was found', async () => {
    server.use(
      http.get(`${API}/species/42`, () => HttpResponse.json({ status: 'found', result: detail }))
    );
    await expect(speciesService.detail(42)).resolves.toMatchObject({ poisonousToPets: true });

    server.use(
      http.get(`${API}/species/42`, () => HttpResponse.json({ status: 'not_found', result: null }))
    );
    await expect(speciesService.detail(42)).resolves.toBeNull();
  });

  it('detailLookup preserves "could not check" for the pet-safety surface', async () => {
    server.use(
      http.get(`${API}/species/42`, () =>
        HttpResponse.json({ status: 'unavailable', reason: 'budget_exhausted', result: null })
      )
    );

    await expect(speciesService.detailLookup(42)).resolves.toEqual({
      status: 'unavailable',
      reason: 'budget_exhausted',
      result: null,
    });
  });

  it('careSuggestions and careGuide unwrap a null result rather than throwing', async () => {
    server.use(
      http.get(`${API}/species/42/care-suggestions`, () => HttpResponse.json({ result: null })),
      http.get(`${API}/species/42/guide`, () =>
        HttpResponse.json({
          result: {
            commonName: 'Pothos',
            scientificName: 'Epipremnum aureum',
            family: 'Araceae',
            cycle: 'Perennial',
            hardinessZone: '10-12',
            indoor: true,
            poisonousToPets: true,
            sunlight: ['part shade'],
            sections: [{ type: 'watering', description: 'Water when the top inch is dry.' }],
          },
        })
      )
    );

    await expect(speciesService.careSuggestions(42)).resolves.toBeNull();
    await expect(speciesService.careGuide(42)).resolves.toMatchObject({
      sections: [{ type: 'watering' }],
    });
  });
});
