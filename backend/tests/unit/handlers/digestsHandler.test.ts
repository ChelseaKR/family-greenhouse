/**
 * The digests Lambda's EventBridge dispatch. Three constant inputs select
 * three routines; the household-trash purge (#670) rides this function so
 * that shipping it added a schedule rather than a Lambda.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/digest.js', () => ({
  runWeeklyDigests: vi.fn(async () => ({
    households: 1,
    attempted: 1,
    sent: 1,
    failed: 0,
    truncated: false,
  })),
  runYearRecaps: vi.fn(async () => ({
    households: 1,
    attempted: 1,
    sent: 0,
    failed: 0,
    truncated: false,
    year: 2025,
  })),
}));
vi.mock('../../../src/services/trashService.js', () => ({
  runTrashPurge: vi.fn(async () => ({
    households: 2,
    attempted: 2,
    failed: 0,
    truncated: false,
    purged: { plants: 1, tasks: 0, photos: 3, completions: 9, otherRows: 1, s3Objects: 3 },
  })),
}));

const context = { getRemainingTimeInMillis: () => 30_000 };

describe('digests handler dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the trash purge for { job: "trashPurge" } and nothing else', async () => {
    const { handler } = await import('../../../src/handlers/digests/handler.js');
    const digest = await import('../../../src/services/digest.js');
    const trash = await import('../../../src/services/trashService.js');

    const summary = await handler({ job: 'trashPurge' }, context);

    expect(trash.runTrashPurge).toHaveBeenCalledTimes(1);
    const [now, options] = vi.mocked(trash.runTrashPurge).mock.calls[0];
    expect(now).toBeInstanceOf(Date);
    // The deadline tracks the Lambda's own countdown (scheduledFanOut).
    expect(options?.deadlineAt).toBeGreaterThan(Date.now());
    expect(summary).toMatchObject({ purged: { plants: 1 } });
    expect(digest.runWeeklyDigests).not.toHaveBeenCalled();
    expect(digest.runYearRecaps).not.toHaveBeenCalled();
  });

  it('still routes the recap and defaults everything else to the weekly digest', async () => {
    const { handler } = await import('../../../src/handlers/digests/handler.js');
    const digest = await import('../../../src/services/digest.js');
    const trash = await import('../../../src/services/trashService.js');

    await handler({ job: 'yearRecap', year: 2025 }, context);
    await handler({ job: 'weekly' }, context);
    await handler(null, context);

    expect(digest.runYearRecaps).toHaveBeenCalledTimes(1);
    expect(digest.runWeeklyDigests).toHaveBeenCalledTimes(2);
    expect(trash.runTrashPurge).not.toHaveBeenCalled();
  });
});
