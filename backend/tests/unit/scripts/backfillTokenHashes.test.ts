/**
 * The operator CLI for the #450 backfill. The backfill itself is tested in
 * tests/unit/services/tokenHashBackfill.test.ts; this pins the parts an
 * operator relies on: dry run unless told otherwise, surfaces named exactly,
 * and an exit status that does not read a partial run as a finished one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/tokenHashBackfill.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/tokenHashBackfill.js')>();
  return { ...actual, backfillSurface: vi.fn() };
});
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

async function load() {
  const cli = await import('../../../src/scripts/backfillTokenHashes.js');
  const backfill = await import('../../../src/services/tokenHashBackfill.js');
  return { cli, backfill };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('parseCliArgs', () => {
  it('defaults to every surface, as a dry run', async () => {
    const { cli, backfill } = await load();
    expect(cli.parseCliArgs([])).toEqual({
      surfaces: backfill.BACKFILL_SURFACE_NAMES,
      confirm: false,
      limit: null,
    });
  });

  it('takes --limit as a batch size, and refuses anything that is not a positive whole number', async () => {
    const { cli } = await load();
    expect(cli.parseCliArgs(['--limit', '25']).limit).toBe(25);
    for (const bad of ['0', '-3', '2.5', 'ten', '', '1e3']) {
      expect(() => cli.parseCliArgs([`--limit=${bad}`])).toThrow(
        /--limit must be a positive whole number/
      );
    }
    // parseArgs refuses a bare `-3` itself, with its own readable message.
    expect(() => cli.parseCliArgs(['--limit', '-3'])).toThrow();
    expect(() => cli.parseCliArgs(['--limit'])).toThrow();
  });

  it('takes --surface repeated or comma-separated, de-duplicated, and --confirm', async () => {
    const { cli } = await load();
    expect(
      cli.parseCliArgs(['--surface', 'plantTag,kioskLink', '--surface', 'plantTag', '--confirm'])
    ).toEqual({ surfaces: ['plantTag', 'kioskLink'], confirm: true, limit: null });
  });

  it('refuses an unknown surface rather than silently backfilling nothing', async () => {
    const { cli } = await load();
    expect(() => cli.parseCliArgs(['--surface', 'apiKey'])).toThrow(/Unknown --surface "apiKey"/);
    expect(() => cli.parseCliArgs(['--apply'])).toThrow();
  });
});

describe('main', () => {
  const report = (overrides = {}) => ({
    surface: 'plantTag' as const,
    legacy: 3,
    rekeyed: 0,
    raced: 0,
    skipped: [],
    limit: null,
    deferred: 0,
    ...overrides,
  });

  it('dry-runs by default: apply=false, exit 0, and says nothing was written', async () => {
    const { cli, backfill } = await load();
    vi.mocked(backfill.backfillSurface).mockResolvedValue(report());
    expect(await cli.main(['--surface', 'plantTag'])).toBe(0);
    expect(backfill.backfillSurface).toHaveBeenCalledWith(backfill.LEGACY_SURFACES.plantTag, {
      apply: false,
    });
    expect(vi.mocked(console.info).mock.calls.flat().join('\n')).toMatch(/Nothing was written/);
  });

  it('writes only with --confirm', async () => {
    const { cli, backfill } = await load();
    vi.mocked(backfill.backfillSurface).mockResolvedValue(report({ rekeyed: 3 }));
    expect(await cli.main(['--surface', 'plantTag', '--confirm'])).toBe(0);
    expect(backfill.backfillSurface).toHaveBeenCalledWith(backfill.LEGACY_SURFACES.plantTag, {
      apply: true,
    });
  });

  it('passes --limit through to every surface, and still dry-runs unless confirmed', async () => {
    const { cli, backfill } = await load();
    vi.mocked(backfill.backfillSurface).mockResolvedValue(report({ limit: 10, deferred: 4 }));
    expect(await cli.main(['--surface', 'plantTag', '--limit', '10'])).toBe(0);
    expect(backfill.backfillSurface).toHaveBeenCalledWith(backfill.LEGACY_SURFACES.plantTag, {
      apply: false,
      limit: 10,
    });
    const out = vi.mocked(console.info).mock.calls.flat().join('\n');
    expect(out).toMatch(/Batch size 10: 4 left for the next run/);
    expect(out).toMatch(/Nothing was written/);
  });

  it('exits 2 when any row raced, so a wrapper cannot read "some moved" as "done"', async () => {
    const { cli, backfill } = await load();
    vi.mocked(backfill.backfillSurface).mockResolvedValue(report({ rekeyed: 2, raced: 1 }));
    expect(await cli.main(['--confirm'])).toBe(2);
  });

  it('exits 1 on bad arguments without touching the table', async () => {
    const { cli, backfill } = await load();
    expect(await cli.main(['--surface', 'nope'])).toBe(1);
    expect(backfill.backfillSurface).not.toHaveBeenCalled();
  });
});

describe('formatReport', () => {
  it('lists skipped rows by reference and reason', async () => {
    const { cli } = await load();
    const text = cli.formatReport(
      {
        surface: 'kioskLink',
        legacy: 1,
        rekeyed: 1,
        raced: 0,
        skipped: [{ ref: 'id=k2 household=hh-1', reason: 'already hashed' }],
        limit: null,
        deferred: 0,
      },
      true
    );
    expect(text).toBe(
      'kioskLink: 1 legacy row(s); 1 re-keyed, 0 raced (re-run to pick up).\n' +
        '  skipped id=k2 household=hh-1: already hashed'
    );
  });
});

describe('formatReport with a batch size', () => {
  it('says how many rows are left for the next run, in a dry run and in a real one', async () => {
    const { cli } = await load();
    const base = {
      surface: 'plantTag' as const,
      legacy: 9,
      rekeyed: 0,
      raced: 0,
      skipped: [],
      limit: 5,
      deferred: 4,
    };
    expect(cli.formatReport(base, false)).toBe(
      'plantTag: 9 legacy row(s) would be re-keyed. Batch size 5: 4 left for the next run.'
    );
    expect(cli.formatReport({ ...base, rekeyed: 5 }, true)).toBe(
      'plantTag: 9 legacy row(s); 5 re-keyed, 0 raced (re-run to pick up). Batch size 5: 4 left for the next run.'
    );
  });
});
