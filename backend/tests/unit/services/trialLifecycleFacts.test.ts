import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import { readTrialFacts } from '../../../src/services/trialLifecycleFacts.js';

type Cmd = {
  kind: 'Query' | 'Get';
  input: {
    IndexName?: string;
    FilterExpression?: string;
    ExpressionAttributeValues?: Record<string, unknown>;
    Select?: string;
  };
};

function route(handlers: {
  plants: (cmd: Cmd) => Promise<unknown>;
  completions: (cmd: Cmd) => Promise<unknown>;
  metadata?: () => Promise<unknown>;
}): void {
  vi.mocked(dynamodb.send).mockImplementation(((command: Cmd) => {
    if (command.kind === 'Get') {
      return handlers.metadata?.() ?? Promise.resolve({ Item: { plantCount: 6, memberCount: 2 } });
    }
    return command.input.IndexName === 'GSI1'
      ? handlers.completions(command)
      : handlers.plants(command);
  }) as never);
}

beforeEach(() => vi.clearAllMocks());

describe('readTrialFacts', () => {
  it('counts plants and completions inside the window and reads the household counters', async () => {
    route({
      plants: async () => ({ Count: 6 }),
      completions: async () => ({ Count: 11 }),
    });
    const facts = await readTrialFacts(
      'hh-1',
      '2026-10-01T10:00:00.000Z',
      '2026-10-11T17:30:00.000Z'
    );
    expect(facts).toEqual({
      plantsAdded: { status: 'ok', value: 6 },
      tasksCompleted: { status: 'ok', value: 11 },
      plantsNow: { status: 'ok', value: 6 },
      membersNow: { status: 'ok', value: 2 },
    });
    const queries = vi.mocked(dynamodb.send).mock.calls.map((c) => (c[0] as unknown as Cmd).input);
    expect(queries.every((q) => q.Select === 'COUNT' || q.Select === undefined)).toBe(true);
    const plantQuery = queries.find((q) => q.FilterExpression?.includes('createdAt'));
    expect(plantQuery?.ExpressionAttributeValues).toMatchObject({
      ':from': '2026-10-01T10:00:00.000Z',
      ':to': '2026-10-11T17:30:00.000Z',
    });
    const completionQuery = queries.find((q) => q.IndexName === 'GSI1');
    expect(completionQuery?.FilterExpression).toContain('duplicateOfCompletionId');
  });

  it('sums across pages', async () => {
    let page = 0;
    route({
      plants: async () => {
        page += 1;
        return page < 3 ? { Count: 4, LastEvaluatedKey: { PK: 'x' } } : { Count: 2 };
      },
      completions: async () => ({ Count: 0 }),
    });
    const facts = await readTrialFacts('hh-1', 'a', 'b');
    expect(facts.plantsAdded).toEqual({ status: 'ok', value: 10 });
    // A real zero is a value we read.
    expect(facts.tasksCompleted).toEqual({ status: 'ok', value: 0 });
  });

  it('reports a failed read as unavailable, never as 0', async () => {
    route({
      plants: async () => {
        throw new Error('throttled');
      },
      completions: async () => ({ Count: 3 }),
      metadata: async () => {
        throw new Error('throttled');
      },
    });
    const facts = await readTrialFacts('hh-1', 'a', 'b');
    expect(facts.plantsAdded).toEqual({ status: 'unavailable' });
    expect(facts.tasksCompleted).toEqual({ status: 'ok', value: 3 });
    expect(facts.plantsNow).toEqual({ status: 'unavailable' });
    expect(facts.membersNow).toEqual({ status: 'unavailable' });
  });

  it('reports an exhausted page budget as unavailable, not as the partial count', async () => {
    route({
      plants: async () => ({ Count: 5, LastEvaluatedKey: { PK: 'more' } }),
      completions: async () => ({ Count: 1 }),
    });
    const facts = await readTrialFacts('hh-1', 'a', 'b');
    expect(facts.plantsAdded).toEqual({ status: 'unavailable' });
  });
});
