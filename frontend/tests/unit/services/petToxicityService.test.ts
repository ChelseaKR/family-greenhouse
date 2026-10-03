import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { normalizeToxicityMatch, petToxicityService } from '@/services/petToxicityService';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

describe('petToxicityService', () => {
  it('opts in to unknown verdicts on every lookup', async () => {
    let requested = '';
    server.use(
      http.get(`${API}/species/toxicity`, ({ request }) => {
        requested = request.url;
        return HttpResponse.json({ query: 'zz', results: [] });
      })
    );
    await petToxicityService.lookup('zz plant');
    const url = new URL(requested);
    expect(url.searchParams.get('q')).toBe('zz plant');
    expect(url.searchParams.get('unknown')).toBe('1');
  });

  it('turns any verdict it does not know into unknown and drops an uncited note', async () => {
    server.use(
      http.get(`${API}/species/toxicity`, () =>
        HttpResponse.json({
          query: 'x',
          results: [
            {
              slug: 'a',
              commonName: 'A',
              scientificName: 'A a',
              cats: 'safe',
              dogs: 'non-toxic',
              note: 'n',
            },
            {
              slug: 'b',
              commonName: 'B',
              scientificName: 'B b',
              cats: 'toxic',
              dogs: 'toxic',
              note: 'cited',
            },
            { slug: 'c', commonName: 'C', scientificName: 'C c', note: 'no verdicts at all' },
            'not an object',
          ],
        })
      )
    );
    const results = await petToxicityService.lookup('fixture');
    expect(results).toEqual([
      {
        slug: 'a',
        commonName: 'A',
        scientificName: 'A a',
        cats: 'unknown',
        dogs: 'non-toxic',
        note: null,
      },
      {
        slug: 'b',
        commonName: 'B',
        scientificName: 'B b',
        cats: 'toxic',
        dogs: 'toxic',
        note: 'cited',
      },
      {
        slug: 'c',
        commonName: 'C',
        scientificName: 'C c',
        cats: 'unknown',
        dogs: 'unknown',
        note: null,
      },
    ]);
  });

  it('rejects a row with no identity rather than guessing one', () => {
    expect(normalizeToxicityMatch({ cats: 'toxic', dogs: 'toxic' })).toBeNull();
    expect(normalizeToxicityMatch(null)).toBeNull();
  });
});
