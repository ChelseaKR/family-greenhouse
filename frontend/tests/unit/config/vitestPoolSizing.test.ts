/**
 * The frontend suite's worker pool has to be sized for the machine it is
 * actually on, not the machine it would have to itself (#596).
 *
 * `availableParallelism()` reports cores, not FREE cores, so the cap in
 * `vitest.config.ts` used to mean "four jsdom workers per gate run" however
 * many gate runs there were. Three concurrent `npm run verify` runs put twelve
 * of them, plus three v8 coverage passes, on a ten-core laptop; the suite went
 * from 58-81s to 987s and failed eight tests on `Test timed out in 15000ms` —
 * on branches that touched no frontend file. `scripts/run-gate.mjs` counts the
 * gates and passes the number down as `GATE_PEERS`; this is the half that
 * reads it.
 *
 * The case that matters most here is the ABSENT one. CI runs one suite on a
 * dedicated runner and must keep the sizing it was tuned for, so no
 * `GATE_PEERS` has to mean exactly the arithmetic that was there before.
 */
import { availableParallelism } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CORES = availableParallelism();

/** The pool the config resolves to for a given `GATE_PEERS`. */
async function maxWorkersWith(peers: string | undefined): Promise<number> {
  vi.resetModules();
  if (peers === undefined) delete process.env.GATE_PEERS;
  else process.env.GATE_PEERS = peers;
  const loaded = (await import('../../../vitest.config')) as {
    default: { test?: { maxWorkers?: number } };
  };
  const workers = loaded.default.test?.maxWorkers;
  if (typeof workers !== 'number') throw new Error('vitest.config.ts stopped setting maxWorkers');
  return workers;
}

const original = process.env.GATE_PEERS;

afterEach(() => {
  if (original === undefined) delete process.env.GATE_PEERS;
  else process.env.GATE_PEERS = original;
});

describe('frontend worker pool sizing', () => {
  const alone = Math.max(1, Math.min(4, Math.floor(CORES / 2)));

  it('is unchanged when nothing says the machine is shared — the CI case', async () => {
    await expect(maxWorkersWith(undefined)).resolves.toBe(alone);
  });

  it('is unchanged for a gate that is the only one on the machine', async () => {
    await expect(maxWorkersWith('1')).resolves.toBe(alone);
  });

  it('divides its share by the gate runs sharing the machine', async () => {
    await expect(maxWorkersWith('4')).resolves.toBe(
      Math.max(1, Math.min(4, Math.floor(CORES / 2 / 4)))
    );
  });

  it('keeps one worker on a crowded machine rather than resolving to none', async () => {
    await expect(maxWorkersWith('64')).resolves.toBe(1);
  });

  it('treats a value it cannot read as "not shared" rather than as zero', async () => {
    // The gate validates GATE_PEERS and refuses a bad one before it runs a
    // step, so nothing should ever arrive here malformed. If something does,
    // the safe answer is the pre-#596 pool, not a division by NaN.
    await expect(maxWorkersWith('')).resolves.toBe(alone);
    await expect(maxWorkersWith('not-a-number')).resolves.toBe(alone);
  });
});
