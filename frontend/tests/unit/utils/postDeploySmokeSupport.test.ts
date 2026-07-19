import { describe, expect, it, vi } from 'vitest';
import {
  buildSmokeEmail,
  householdIdFromCreateResponse,
  householdIdFromMembershipItem,
  runAllCleanupSteps,
} from '../../e2e/post-deploy-smoke-support';

describe('post-deploy smoke support', () => {
  describe('buildSmokeEmail', () => {
    it('builds a unique address from a configured deliverable template', () => {
      expect(buildSmokeEmail('fg-smoke+{tag}@example.com', 'public-a1b2')).toBe(
        'fg-smoke+public-a1b2@example.com'
      );
    });

    it.each([
      [undefined, /is required/i],
      ['fg-smoke@example.com', /exactly one \{tag\}/i],
      ['fg-{tag}-{tag}@example.com', /exactly one \{tag\}/i],
      ['fg@example.{tag}', /before @/i],
    ])('rejects an unsafe template: %s', (template, message) => {
      expect(() => buildSmokeEmail(template, 'public-a1b2')).toThrow(message);
    });
  });

  describe('householdIdFromMembershipItem', () => {
    it('reads and validates the household id from GSI1SK', () => {
      expect(
        householdIdFromMembershipItem({
          SK: { S: 'MEMBER#cognito-sub' },
          GSI1SK: { S: 'HOUSEHOLD#550e8400-e29b-41d4-a716-446655440000' },
        })
      ).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it.each([
      [{ SK: { S: 'HOUSEHOLD#550e8400-e29b-41d4-a716-446655440000' } }],
      [{ GSI1SK: { S: 'HOUSEHOLD#not-a-uuid' } }],
      [{ GSI1SK: { S: 'MEMBER#550e8400-e29b-41d4-a716-446655440000' } }],
    ])('rejects a membership item without a valid GSI1SK: %j', (item) => {
      expect(householdIdFromMembershipItem(item)).toBeNull();
    });
  });

  describe('householdIdFromCreateResponse', () => {
    it('captures the authoritative household id from the create response', () => {
      expect(householdIdFromCreateResponse({ id: '550e8400-e29b-41d4-a716-446655440000' })).toBe(
        '550e8400-e29b-41d4-a716-446655440000'
      );
    });

    it.each([undefined, {}, { id: 'not-a-uuid' }])(
      'rejects a malformed household create response: %j',
      (response) => {
        expect(() => householdIdFromCreateResponse(response)).toThrow(/valid household UUID/i);
      }
    );
  });

  it('attempts every cleanup step before reporting all failures', async () => {
    const attempted: string[] = [];
    const successful = vi.fn(async () => {
      attempted.push('cognito');
    });

    await expect(
      runAllCleanupSteps([
        {
          label: 'DynamoDB lookup',
          run: async () => {
            attempted.push('lookup');
            throw new Error('lookup failed');
          },
        },
        {
          label: 'DynamoDB delete',
          run: async () => {
            attempted.push('delete');
            throw new Error('delete failed');
          },
        },
        { label: 'Cognito delete', run: successful },
      ])
    ).rejects.toThrow(/DynamoDB lookup: lookup failed.*DynamoDB delete: delete failed/i);

    expect(attempted).toEqual(['lookup', 'delete', 'cognito']);
    expect(successful).toHaveBeenCalledOnce();
  });
});
