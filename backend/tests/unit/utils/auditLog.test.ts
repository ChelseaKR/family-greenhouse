import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn() },
}));

import { audit } from '../../../src/utils/auditLog.js';
import type { AuditEvent } from '../../../src/utils/auditLog.js';
import { logger } from '../../../src/utils/logger.js';

describe('audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes one structured info log tagged audit:true, with the event as both field and message', () => {
    audit('apikey.created', {
      actorId: 'user-1',
      actorEmail: 'a@b.com',
      householdId: 'hh-1',
      targetId: 'key-9',
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      {
        audit: true,
        event: 'apikey.created',
        actorId: 'user-1',
        actorEmail: 'a@b.com',
        householdId: 'hh-1',
        targetId: 'key-9',
      },
      'apikey.created'
    );
  });

  it('defaults fields to empty — a bare event still produces a well-formed record', () => {
    audit('auth.login.failure');
    expect(logger.info).toHaveBeenCalledWith(
      { audit: true, event: 'auth.login.failure' },
      'auth.login.failure'
    );
  });

  it('passes metadata and ip through untouched', () => {
    audit('rate_limit.tripped', {
      ip: '203.0.113.9',
      metadata: { key: '/auth/login|203.0.113.9' },
    });
    const [fields] = vi.mocked(logger.info).mock.calls[0] as [Record<string, unknown>];
    expect(fields.ip).toBe('203.0.113.9');
    expect(fields.metadata).toEqual({ key: '/auth/login|203.0.113.9' });
  });

  it('covers the full event taxonomy without throwing (type-level list stays exhaustive)', () => {
    const events: AuditEvent[] = [
      'auth.login.success',
      'auth.login.failure',
      'auth.signup',
      'auth.password_reset_requested',
      'auth.password_reset_completed',
      'auth.password_changed',
      'auth.profile_updated',
      'auth.account_deleted',
      'household.created',
      'household.member_added',
      'household.member_removed',
      'household.role_changed',
      'billing.subscription_changed',
      'apikey.created',
      'apikey.revoked',
      'plant.deleted',
      'rate_limit.tripped',
      'chat.message_sent',
      'chat.tools_called',
    ];
    for (const event of events) {
      expect(() => audit(event)).not.toThrow();
    }
    expect(logger.info).toHaveBeenCalledTimes(events.length);
  });

  it('returns void synchronously (fire-and-forget contract for callers)', () => {
    expect(audit('plant.deleted', { actorId: 'u1' })).toBeUndefined();
  });
});
