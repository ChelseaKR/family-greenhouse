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
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * A stand-in for the checkpoint row, so a test can say "the last run stopped
 * after X" without hand-rolling the DynamoDB shapes each time.
 */
async function mockCheckpointStore(initial: Record<string, string> = {}) {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const store = new Map<string, string>(Object.entries(initial));
  vi.mocked(dynamodb.send).mockImplementation((command: unknown) => {
    const cmd = command as { kind: string; input: Record<string, never> };
    const key = cmd.input.Key ?? cmd.input.Item;
    const pk = (key as unknown as { PK: string }).PK;
    if (cmd.kind === 'Get') {
      const found = store.get(pk);
      return Promise.resolve(found ? { Item: { lastHouseholdId: found } } : {}) as never;
    }
    store.set(pk, (cmd.input.Item as unknown as { lastHouseholdId: string }).lastHouseholdId);
    return Promise.resolve({}) as never;
  });
  return store;
}

const ids = (n: number, prefix = 'h') =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rotateFrom', () => {
  it('starts at the household after the checkpoint and wraps around the end', async () => {
    const { rotateFrom } = await import('../../../src/services/scheduledFanOut.js');
    expect(rotateFrom(['a', 'b', 'c', 'd'], 'b')).toEqual(['c', 'd', 'a', 'b']);
    // Wrapping is what keeps the weekly digest's four Monday runs meaningful:
    // a later run finishes the tail and then comes back to the households an
    // earlier run visited but deferred for quiet hours.
    expect(rotateFrom(['a', 'b', 'c', 'd'], 'd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('starts from the top for an unknown checkpoint, never skipping anyone', async () => {
    const { rotateFrom } = await import('../../../src/services/scheduledFanOut.js');
    // The household the last run stopped after has since been deleted. The
    // safe direction is the beginning of the list: a wrong guess must cost a
    // repeat visit (cheap, deduped) and never a skipped one (unrecoverable).
    expect(rotateFrom(['a', 'b', 'c'], 'zz')).toEqual(['a', 'b', 'c']);
    expect(rotateFrom(['a', 'b', 'c'], null)).toEqual(['a', 'b', 'c']);
  });
});

describe('fanOutHouseholds', () => {
  it('processes households concurrently rather than one at a time', async () => {
    await mockCheckpointStore();
    const { fanOutHouseholds } = await import('../../../src/services/scheduledFanOut.js');

    let inFlight = 0;
    let peak = 0;
    const summary = await fanOutHouseholds(
      'reminders',
      ids(20),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      },
      { concurrency: 5 }
    );

    // The serial loop this replaced had a peak of exactly 1, which is the
    // whole reason a few hundred households ran past a 30-second timeout.
    expect(peak).toBe(5);
    expect(summary).toEqual({ total: 20, attempted: 20, truncated: false });
  });

  it('stops on its deadline instead of running past it, and says that it did', async () => {
    await mockCheckpointStore();
    const { fanOutHouseholds } = await import('../../../src/services/scheduledFanOut.js');

    // A clock the test drives: every batch costs 1s of a 3.5s budget.
    let clockMs = 1_000_000;
    const visited: string[] = [];
    const summary = await fanOutHouseholds(
      'reminders',
      ids(50),
      async (id) => {
        visited.push(id);
      },
      {
        concurrency: 5,
        deadlineAt: clockMs + 3_500,
        clock: () => {
          const at = clockMs;
          clockMs += 1_000;
          return at;
        },
      }
    );

    // Four batches fit in the budget; the fifth deadline check stops the run.
    expect(summary.attempted).toBe(20);
    expect(summary.total).toBe(50);
    // Without this flag the run returns success and the timeout `Errors`
    // alarm that used to catch an over-long run has nothing left to fire on.
    expect(summary.truncated).toBe(true);
    expect(visited).toHaveLength(20);
  });

  it('reminds the tail on the next run — the households the first run could not reach', async () => {
    // This is the defect in #458 stated as a test. The serial loop was killed
    // by the Lambda timeout wherever it happened to be, and EventBridge's
    // retry restarted it at household #1 and died in the same place: the
    // households in the tail were not delayed, they were never reminded, and
    // which ones they were was decided by DynamoDB's item order.
    await mockCheckpointStore();
    const { fanOutHouseholds } = await import('../../../src/services/scheduledFanOut.js');

    const all = ids(20);
    const runOnce = async () => {
      let clockMs = 1_000_000;
      const visited: string[] = [];
      const summary = await fanOutHouseholds(
        'reminders',
        all,
        async (id) => {
          visited.push(id);
        },
        {
          concurrency: 5,
          deadlineAt: clockMs + 1_500,
          clock: () => {
            const at = clockMs;
            clockMs += 1_000;
            return at;
          },
        }
      );
      return { visited, summary };
    };

    const first = await runOnce();
    expect(first.summary.truncated).toBe(true);
    expect(first.visited).toEqual(all.slice(0, 10));

    // The next hour resumes where the last one stopped rather than restarting
    // at the top. The tail is reached; nobody is stranded.
    const second = await runOnce();
    expect(second.visited).toEqual(all.slice(10, 20));
    expect([...first.visited, ...second.visited].sort()).toEqual([...all].sort());
  });

  it('records no checkpoint for an empty household list, so the rotation cannot get stuck', async () => {
    const store = await mockCheckpointStore({ 'SCHEDULED#reminders': 'h05' });
    const { fanOutHouseholds } = await import('../../../src/services/scheduledFanOut.js');

    const summary = await fanOutHouseholds('reminders', [], async () => {});

    expect(summary).toEqual({ total: 0, attempted: 0, truncated: false });
    expect(store.get('SCHEDULED#reminders')).toBe('h05');
  });

  it('runs every household when the checkpoint read fails, rather than failing the run', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockRejectedValue(new Error('ddb down'));
    const { fanOutHouseholds } = await import('../../../src/services/scheduledFanOut.js');

    const visited: string[] = [];
    const summary = await fanOutHouseholds('reminders', ids(3), async (id) => {
      visited.push(id);
    });

    // Losing the rotation to a blip costs fairness for one run. Throwing here
    // would cost the whole run — the trade the wrong way round.
    expect(visited).toEqual(['h01', 'h02', 'h03']);
    expect(summary.truncated).toBe(false);
  });

  it('re-throws a handler failure instead of losing it', async () => {
    await mockCheckpointStore();
    const { fanOutHouseholds } = await import('../../../src/services/scheduledFanOut.js');

    // Each caller counts its own failures into the `failed` field its metric
    // filter reads, so this helper must not quietly absorb one.
    await expect(
      fanOutHouseholds('reminders', ['h01'], async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });
});

describe('deadlineFrom', () => {
  it('derives the budget from the Lambda countdown, leaving room to wind down', async () => {
    const { deadlineFrom } = await import('../../../src/services/scheduledFanOut.js');
    // 30s function, 28s left: 3s is reserved for the summary line and the
    // checkpoint write that follow the loop.
    expect(deadlineFrom({ getRemainingTimeInMillis: () => 28_000 }, 1, 1_000)).toBe(26_000);
  });

  it('splits one invocation between the two passes that ride the same schedule', async () => {
    const { deadlineFrom } = await import('../../../src/services/scheduledFanOut.js');
    // The reminder handler runs the fan-out and then the household-email pass
    // inside one 30-second Lambda. Before the split, the first pass could take
    // the whole invocation and the second never ran at all.
    expect(deadlineFrom({ getRemainingTimeInMillis: () => 28_000 }, 0.5, 1_000)).toBe(13_500);
  });

  it('falls back to a budget under the configured timeout with no context', async () => {
    const { deadlineFrom } = await import('../../../src/services/scheduledFanOut.js');
    // Local runs, the admin HTTP route and tests have no Lambda context.
    expect(deadlineFrom(undefined, 1, 0)).toBe(22_000);
  });
});
