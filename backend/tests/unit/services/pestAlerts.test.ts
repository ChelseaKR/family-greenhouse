import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/plantService.js', () => ({
  getPlants: vi.fn(),
}));
vi.mock('../../../src/services/enrichment.js', () => ({
  listPestsForSpeciesCached: vi.fn(),
}));

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function pest(description: string | null) {
  return {
    id: 42,
    commonName: 'Spider mites',
    scientificName: null,
    description,
    hostScientificNames: [],
  };
}

describe('pestActiveThisMonth', () => {
  it('month matrix: a capitalized month name activates exactly that month', async () => {
    const { pestActiveThisMonth } = await import('../../../src/services/pestAlerts.js');
    for (const mentioned of MONTHS) {
      const capitalized = mentioned[0].toUpperCase() + mentioned.slice(1);
      const p = pest(`Populations peak in ${capitalized} in temperate regions.`);
      for (const current of MONTHS) {
        expect(pestActiveThisMonth(p, current), `${mentioned} vs ${current}`).toBe(
          current === mentioned
        );
      }
    }
  });

  it('does NOT treat the verb "may" as the month May', async () => {
    const { pestActiveThisMonth } = await import('../../../src/services/pestAlerts.js');
    const p = pest('Aphids may appear on new growth and may cause leaf curl.');
    // No capitalized month name → "no month data" → always relevant,
    // not May-only as the old lowercase includes() check concluded.
    for (const current of MONTHS) {
      expect(pestActiveThisMonth(p, current)).toBe(true);
    }
  });

  it('matches whole words only (no "Maybe" → May)', async () => {
    const { pestActiveThisMonth } = await import('../../../src/services/pestAlerts.js');
    const p = pest('Maybe found on Junegrass; treat with Octoberfest-brand soap.');
    // None of the embedded fragments count as month mentions.
    for (const current of MONTHS) {
      expect(pestActiveThisMonth(p, current)).toBe(true);
    }
  });

  it('handles multi-month seasons', async () => {
    const { pestActiveThisMonth } = await import('../../../src/services/pestAlerts.js');
    const p = pest('Most active during May and June.');
    expect(pestActiveThisMonth(p, 'may')).toBe(true);
    expect(pestActiveThisMonth(p, 'june')).toBe(true);
    expect(pestActiveThisMonth(p, 'july')).toBe(false);
  });

  it('treats a missing/empty description as always relevant', async () => {
    const { pestActiveThisMonth } = await import('../../../src/services/pestAlerts.js');
    expect(pestActiveThisMonth(pest(null), 'march')).toBe(true);
    expect(pestActiveThisMonth(pest(''), 'march')).toBe(true);
  });
});

describe('evaluatePestAlerts', () => {
  beforeEach(() => vi.clearAllMocks());

  const plant = {
    id: 'p1',
    name: 'Monstera',
    species: 'Monstera deliciosa',
    perenualSpeciesId: 7,
  };

  it('returns alerts with pestId and does NOT write the suppression marker itself', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const plants = await import('../../../src/services/plantService.js');
    const enrichment = await import('../../../src/services/enrichment.js');
    const { evaluatePestAlerts } = await import('../../../src/services/pestAlerts.js');

    vi.mocked(plants.getPlants).mockResolvedValue([plant] as never);
    vi.mocked(enrichment.listPestsForSpeciesCached).mockResolvedValue({
      ok: true,
      pests: [pest(null)],
    } as never);
    // lastAlertedAt read → no previous alert.
    vi.mocked(dynamodb.send).mockResolvedValue({ Item: undefined } as never);

    const result = await evaluatePestAlerts('hh', new Date('2026-06-01T00:00:00Z'));
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({ plantId: 'p1', pestId: 42, pestName: 'Spider mites' });
    expect(result.dataUnavailable).toBe(false);

    // Only Get commands — the 90-day marker write moved to the caller
    // (after successful delivery) via markAlerted().
    const kinds = vi.mocked(dynamodb.send).mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).not.toContain('Put');
  });

  it('suppresses pests alerted within the last quarter', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const plants = await import('../../../src/services/plantService.js');
    const enrichment = await import('../../../src/services/enrichment.js');
    const { evaluatePestAlerts } = await import('../../../src/services/pestAlerts.js');

    const now = new Date('2026-06-01T00:00:00Z');
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(plants.getPlants).mockResolvedValue([plant] as never);
    vi.mocked(enrichment.listPestsForSpeciesCached).mockResolvedValue({
      ok: true,
      pests: [pest(null)],
    } as never);
    vi.mocked(dynamodb.send).mockResolvedValue({ Item: { alertedAt: tenDaysAgo } } as never);

    const result = await evaluatePestAlerts('hh', now);
    expect(result.alerts).toHaveLength(0);
  });

  it('does NOT treat "no pest data available" the same as "confirmed no pests" (the Cinnamomum-cassia-shaped bug)', async () => {
    const plants = await import('../../../src/services/plantService.js');
    const enrichment = await import('../../../src/services/enrichment.js');
    const { evaluatePestAlerts } = await import('../../../src/services/pestAlerts.js');

    vi.mocked(plants.getPlants).mockResolvedValue([plant] as never);
    // Perenual's daily budget is exhausted — this is NOT the same as "we
    // checked and there are no pests," and must be flagged so the caller
    // knows not to treat today as fully evaluated.
    vi.mocked(enrichment.listPestsForSpeciesCached).mockResolvedValue({
      ok: false,
      reason: 'budget_exhausted',
    } as never);

    const result = await evaluatePestAlerts('hh', new Date('2026-06-01T00:00:00Z'));
    expect(result.alerts).toHaveLength(0);
    expect(result.dataUnavailable).toBe(true);
  });

  it('does NOT flag dataUnavailable when Perenual is simply unconfigured (permanent, not worth a same-day retry)', async () => {
    const plants = await import('../../../src/services/plantService.js');
    const enrichment = await import('../../../src/services/enrichment.js');
    const { evaluatePestAlerts } = await import('../../../src/services/pestAlerts.js');

    vi.mocked(plants.getPlants).mockResolvedValue([plant] as never);
    vi.mocked(enrichment.listPestsForSpeciesCached).mockResolvedValue({
      ok: false,
      reason: 'unconfigured',
    } as never);

    const result = await evaluatePestAlerts('hh', new Date('2026-06-01T00:00:00Z'));
    expect(result.dataUnavailable).toBe(false);
  });

  it('markAlerted writes a TTL-swept marker row', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { markAlerted } = await import('../../../src/services/pestAlerts.js');
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);

    await markAlerted('p1', 42);
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: { Item: Record<string, unknown> };
    };
    expect(cmd.kind).toBe('Put');
    expect(cmd.input.Item.PK).toBe('PLANT#p1');
    expect(cmd.input.Item.SK).toBe('PEST_ALERT#42');
    expect(typeof cmd.input.Item.ttl).toBe('number');
  });
});
