/**
 * The token-scoped plumbing every caretaker route shares.
 *
 * The interesting case is `recordVisitAction` returning FALSE. When a task
 * completes but its line on the visit record cannot be written, the caller
 * reports that to the caretaker instead of a plain success — because the
 * record is what the household hands to whoever is paying, and a silent gap in
 * it is this repo's named defect: absence rendered as a value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/caretakerService.js', () => ({
  getActiveCaretaker: vi.fn(),
  recordCaretakerAction: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function load() {
  const svc = await import('../../../src/services/caretakerService.js');
  const shared = await import('../../../src/handlers/caretakers/shared.js');
  const { logger } = await import('../../../src/utils/logger.js');
  return { svc, shared, logger };
}

const SEAT = { id: 'seat-1', householdId: 'hh-1', name: 'Dana' };
const NOTE = { kind: 'note' as const, entry: { text: 'Watered.', at: '2026-09-03T09:00:00.000Z' } };

describe('lookaheadDays', () => {
  it('shows at most a fortnight even on a long engagement', async () => {
    const { shared } = await load();
    const now = new Date('2026-09-03T00:00:00.000Z');
    expect(shared.lookaheadDays('2027-03-03T00:00:00.000Z', now)).toBe(14);
  });

  it('shortens to what is left of the engagement', async () => {
    const { shared } = await load();
    const now = new Date('2026-09-03T00:00:00.000Z');
    expect(shared.lookaheadDays('2026-09-06T00:00:00.000Z', now)).toBe(3);
  });

  it('never drops below a day, so a seat in its final hours still shows work', async () => {
    const { shared } = await load();
    const now = new Date('2026-09-03T00:00:00.000Z');
    expect(shared.lookaheadDays('2026-09-03T02:00:00.000Z', now)).toBe(1);
    expect(shared.lookaheadDays('2026-09-02T00:00:00.000Z', now)).toBe(1);
  });

  it('falls back to a day for an unparseable expiry', async () => {
    const { shared } = await load();
    expect(shared.lookaheadDays('nonsense', new Date())).toBe(1);
  });
});

describe('requireActiveCaretaker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws one generic 404 when the token does not resolve', async () => {
    const { svc, shared } = await load();
    vi.mocked(svc.getActiveCaretaker).mockResolvedValue(null);
    await expect(
      shared.requireActiveCaretaker({ pathParameters: { token: 'x' } } as never)
    ).rejects.toMatchObject({ statusCode: 404, message: shared.INACTIVE_MESSAGE });
  });

  it('passes the seat through when it resolves', async () => {
    const { svc, shared } = await load();
    vi.mocked(svc.getActiveCaretaker).mockResolvedValue({ ...SEAT } as never);
    await expect(
      shared.requireActiveCaretaker({ pathParameters: { token: 'x' } } as never)
    ).resolves.toMatchObject({ name: 'Dana' });
  });
});

describe('recordVisitAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports true when the visit line was written', async () => {
    const { svc, shared } = await load();
    vi.mocked(svc.recordCaretakerAction).mockResolvedValue('visit-1');
    expect(await shared.recordVisitAction(SEAT, NOTE)).toBe(true);
  });

  it('reports false — and logs — rather than swallowing a failed write', async () => {
    const { svc, shared, logger } = await load();
    vi.mocked(svc.recordCaretakerAction).mockRejectedValue(new Error('DynamoDB unavailable'));
    expect(await shared.recordVisitAction(SEAT, NOTE)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ caretakerId: 'seat-1', kind: 'note' }),
      'caretaker.visit_record_failed'
    );
  });
});
