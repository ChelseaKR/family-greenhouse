import { describe, expect, it } from 'vitest';
import {
  announcementFromArgs,
  nextLedgerContents,
  parseCliArgs,
  todayIso,
} from '../../../src/scripts/sendPriceChangeNotice.js';
import type { PriceChangeAnnouncement } from '../../../src/models/priceChangeAnnouncement.js';

const FULL_ARGV = [
  '--id',
  'garden-monthly-2026-11-01',
  '--plan',
  'garden',
  '--interval',
  'month',
  '--old',
  '4.99',
  '--new',
  '5.99',
  '--effective',
  '2026-11-01',
  '--summary',
  'Garden monthly is moving from $4.99 to $5.99 to keep pace with vendor cost.',
];

describe('todayIso', () => {
  it('formats a Date as YYYY-MM-DD in UTC', () => {
    expect(todayIso(new Date('2026-11-01T23:59:00Z'))).toBe('2026-11-01');
  });
});

describe('parseCliArgs', () => {
  it('parses a fully specified command line', () => {
    const args = parseCliArgs(FULL_ARGV);
    expect(args).toMatchObject({
      id: 'garden-monthly-2026-11-01',
      plan: 'garden',
      interval: 'month',
      old: 4.99,
      new: 5.99,
      effective: '2026-11-01',
      confirm: false,
    });
  });

  it('defaults --confirm to false, and reads it when passed', () => {
    expect(parseCliArgs(FULL_ARGV).confirm).toBe(false);
    expect(parseCliArgs([...FULL_ARGV, '--confirm']).confirm).toBe(true);
  });

  it.each(['id', 'plan', 'interval', 'old', 'new', 'effective', 'summary'])(
    'fails without --%s',
    (missing) => {
      const flag = `--${missing}`;
      const at = FULL_ARGV.indexOf(flag);
      const withoutIt = [...FULL_ARGV.slice(0, at), ...FULL_ARGV.slice(at + 2)];
      expect(() => parseCliArgs(withoutIt)).toThrow(/missing required argument/);
    }
  );

  it('rejects a non-numeric --old or --new', () => {
    const at = FULL_ARGV.indexOf('--old');
    const withBadOld = [...FULL_ARGV.slice(0, at + 1), 'a-lot', ...FULL_ARGV.slice(at + 2)];
    expect(() => parseCliArgs(withBadOld)).toThrow(/--old must be a number/);
  });
});

describe('announcementFromArgs', () => {
  it('builds the announcement from parsed args', () => {
    const announcement = announcementFromArgs(parseCliArgs(FULL_ARGV));
    expect(announcement).toEqual({
      id: 'garden-monthly-2026-11-01',
      planId: 'garden',
      interval: 'month',
      summary: 'Garden monthly is moving from $4.99 to $5.99 to keep pace with vendor cost.',
      oldPriceUsd: 4.99,
      newPriceUsd: 5.99,
      effectiveOn: '2026-11-01',
    });
  });

  it('refuses an unknown plan', () => {
    const args = parseCliArgs(FULL_ARGV);
    expect(() => announcementFromArgs({ ...args, plan: 'bogus' })).toThrow(/--plan must be one of/);
  });

  it('refuses an interval that is neither month nor year', () => {
    const args = parseCliArgs(FULL_ARGV);
    expect(() => announcementFromArgs({ ...args, interval: 'lifetime' })).toThrow(
      /--interval must be "month" or "year"/
    );
  });
});

describe('nextLedgerContents', () => {
  const announcement: PriceChangeAnnouncement = announcementFromArgs(parseCliArgs(FULL_ARGV));

  it('appends a new entry to an empty ledger', () => {
    const next = nextLedgerContents({ notices: [] }, announcement, '2026-10-18');
    expect(next.notices).toEqual([
      {
        id: announcement.id,
        summary: announcement.summary,
        emailedOn: '2026-10-18',
        effectiveOn: announcement.effectiveOn,
        sites: [],
      },
    ]);
  });

  it('preserves existing entries and other top-level fields', () => {
    const current = {
      $comment: 'kept',
      notices: [
        {
          id: 'other-notice',
          summary: 'x'.repeat(20),
          emailedOn: '2026-01-01',
          effectiveOn: '2026-01-15',
          sites: [],
        },
      ],
    };
    const next = nextLedgerContents(current, announcement, '2026-10-18');
    expect(next.$comment).toBe('kept');
    expect(next.notices).toHaveLength(2);
    expect(next.notices[0]).toEqual(current.notices[0]);
  });

  it('updates an existing entry with the same id in place, rather than duplicating it', () => {
    const current = {
      notices: [
        {
          id: announcement.id,
          summary: 'stale summary',
          emailedOn: '2026-10-01',
          effectiveOn: '2026-10-15',
          sites: [],
        },
      ],
    };
    const next = nextLedgerContents(current, announcement, '2026-10-18');
    expect(next.notices).toHaveLength(1);
    expect(next.notices[0]).toEqual({
      id: announcement.id,
      summary: announcement.summary,
      emailedOn: '2026-10-18',
      effectiveOn: announcement.effectiveOn,
      sites: [],
    });
  });
});
