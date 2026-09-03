import { describe, expect, it } from 'vitest';
import type { SitterLinkSummary } from '@/services/householdService';
import { groupSitterLinks, sitterLinkState } from './sitterLinkState';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const link = (over: Partial<SitterLinkSummary> = {}): SitterLinkSummary => ({
  id: 'l1',
  householdId: 'hh',
  createdBy: 'u1',
  createdAt: '2026-06-01T00:00:00.000Z',
  startsAt: new Date(NOW - DAY).toISOString(),
  expiresAt: new Date(NOW + DAY).toISOString(),
  status: 'active',
  label: 'Neighbour',
  ...over,
});

describe('sitterLinkState', () => {
  it('is active inside the window', () => {
    expect(sitterLinkState(link(), NOW)).toBe('active');
  });

  it('is expired once the window closes, even while the row still says active', () => {
    // The row survives its own expiry: the DynamoDB TTL keeps a three-day
    // buffer past expiresAt and the sweeper lags behind that. Reading `status`
    // alone told the household a neighbour still had access for most of a week
    // after their trip ended.
    const ended = link({ expiresAt: new Date(NOW - DAY).toISOString(), status: 'active' });

    expect(sitterLinkState(ended, NOW)).toBe('expired');
  });

  it('is scheduled before the window opens', () => {
    const upcoming = link({
      startsAt: new Date(NOW + DAY).toISOString(),
      expiresAt: new Date(NOW + 8 * DAY).toISOString(),
    });

    expect(sitterLinkState(upcoming, NOW)).toBe('scheduled');
  });

  it('reports revocation ahead of the window', () => {
    expect(sitterLinkState(link({ status: 'revoked' }), NOW)).toBe('revoked');
    const revokedAndExpired = link({
      status: 'revoked',
      expiresAt: new Date(NOW - DAY).toISOString(),
    });
    expect(sitterLinkState(revokedAndExpired, NOW)).toBe('revoked');
  });

  it('treats an unreadable window as still live so it stays revocable', () => {
    expect(sitterLinkState(link({ expiresAt: 'not-a-date' }), NOW)).toBe('active');
    expect(sitterLinkState(link({ startsAt: 'not-a-date' }), NOW)).toBe('active');
  });

  it('tolerates a legacy row with no start recorded', () => {
    expect(sitterLinkState(link({ startsAt: '' }), NOW)).toBe('active');
  });
});

describe('groupSitterLinks', () => {
  it('separates links that still work from windows that closed, dropping revoked ones', () => {
    const live = link({ id: 'live' });
    const scheduled = link({
      id: 'scheduled',
      startsAt: new Date(NOW + DAY).toISOString(),
      expiresAt: new Date(NOW + 8 * DAY).toISOString(),
    });
    const ended = link({ id: 'ended', expiresAt: new Date(NOW - DAY).toISOString() });
    const revoked = link({ id: 'revoked', status: 'revoked' });

    const groups = groupSitterLinks([live, scheduled, ended, revoked], NOW);

    expect(groups.current.map((l) => l.id)).toEqual(['live', 'scheduled']);
    expect(groups.ended.map((l) => l.id)).toEqual(['ended']);
  });
});
