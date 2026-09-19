#!/usr/bin/env -S npx tsx
/**
 * Operator CLI for the #450 backfill: re-key credential rows still stored under
 * their plaintext token (plant tags, kiosk links, sitter links, caretaker seats,
 * cutting shares) so the table holds only digests.
 * `services/tokenHashBackfill.ts` carries the contract; this is the entrypoint
 * an operator runs by hand, once, after the release that hashes plant tags and
 * shares is deployed. Nothing calls it automatically, and it has NOT been run.
 *
 * It lives under `src/` for the same reason as `sendPriceChangeNotice.ts`: so
 * `tsc --noEmit` and `eslint` cover it. It is never bundled (`esbuild.config.js`
 * only ships `handler.ts` files).
 *
 * ORDER MATTERS: deploy first, backfill second. The deployed read paths resolve
 * both generations, so a re-keyed row keeps working; the code before this
 * release reads plant tags and shares ONLY by the plaintext key, and running
 * the backfill against it would stop every printed label from scanning.
 *
 * Dry run by default: scans, and prints how many legacy rows each surface has
 * and which rows it would skip and why. Pass `--confirm` to write. Each row is
 * moved in its own transaction; a row a live request changed mid-run is left
 * untouched and counted as `raced`, and the whole thing is safe to re-run.
 * It never prints a token.
 *
 * Needs the ambient AWS credentials `scripts/sweep-test-fixtures.mjs` uses
 * (`AWS_PROFILE` locally) plus `TABLE_NAME` for the right environment:
 *
 *   TABLE_NAME=family-greenhouse-staging npm run backfill:token-hashes --workspace backend
 *   TABLE_NAME=family-greenhouse-staging npm run backfill:token-hashes --workspace backend -- --confirm
 *
 *   # one surface at a time, plant tags first if you want to watch them:
 *   ... -- --surface plantTag --confirm
 *
 *   # a batch at a time: re-key at most 25 rows per surface, then re-run for
 *   # the next 25 (a moved row is no longer legacy, so each run is new work):
 *   ... -- --limit 25 --confirm
 *
 * A credential that is still being USED is moved by the request that uses it
 * (`upgradeLegacyRow`), so by the time this runs it mostly finds the rows nobody
 * has touched. Both use the same transaction; if they meet on one row, one wins
 * and this reports the other as `raced`.
 */
import { parseArgs } from 'node:util';
import {
  BACKFILL_SURFACE_NAMES,
  LEGACY_SURFACES,
  backfillSurface,
  type BackfillSurfaceName,
  type SurfaceReport,
} from '../services/tokenHashBackfill.js';

export interface CliArgs {
  surfaces: BackfillSurfaceName[];
  confirm: boolean;
  /** Batch size per surface, or null for every legacy row. */
  limit: number | null;
}

function isSurfaceName(value: string): value is BackfillSurfaceName {
  return (BACKFILL_SURFACE_NAMES as string[]).includes(value);
}

/** Pure parse: throws a readable Error rather than exiting, so it is testable. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      surface: { type: 'string', multiple: true },
      confirm: { type: 'boolean', default: false },
      limit: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const requested = (values.surface ?? []).flatMap((entry) =>
    entry
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  );
  const surfaces: BackfillSurfaceName[] = [];
  for (const name of requested) {
    if (!isSurfaceName(name)) {
      throw new Error(
        `Unknown --surface "${name}". Expected one of: ${BACKFILL_SURFACE_NAMES.join(', ')}.`
      );
    }
    if (!surfaces.includes(name)) surfaces.push(name);
  }
  let limit: number | null = null;
  if (values.limit !== undefined) {
    if (!/^[1-9]\d*$/.test(values.limit)) {
      throw new Error(`--limit must be a positive whole number, got "${values.limit}".`);
    }
    limit = Number(values.limit);
  }
  return {
    surfaces: surfaces.length > 0 ? surfaces : [...BACKFILL_SURFACE_NAMES],
    confirm: values.confirm ?? false,
    limit,
  };
}

/** One surface's result, as the operator reads it. */
export function formatReport(report: SurfaceReport, confirm: boolean): string {
  const batch =
    report.limit === null
      ? ''
      : ` Batch size ${report.limit}: ${report.deferred} left for the next run.`;
  const lines = [
    confirm
      ? `${report.surface}: ${report.legacy} legacy row(s); ${report.rekeyed} re-keyed, ${report.raced} raced (re-run to pick up).${batch}`
      : `${report.surface}: ${report.legacy} legacy row(s) would be re-keyed.${batch}`,
  ];
  for (const skipped of report.skipped) {
    lines.push(`  skipped ${skipped.ref}: ${skipped.reason}`);
  }
  return lines.join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error('\nSee the usage block at the top of this script.');
    return 1;
  }

  let raced = 0;
  for (const name of args.surfaces) {
    const report = await backfillSurface(LEGACY_SURFACES[name], {
      apply: args.confirm,
      ...(args.limit !== null ? { limit: args.limit } : {}),
    });
    raced += report.raced;
    console.info(formatReport(report, args.confirm));
  }

  if (!args.confirm) {
    console.info('\nDry run only — pass --confirm to re-key. Nothing was written.');
    return 0;
  }
  // A raced row is not a failure of the run, but it is not done either: say so
  // in the exit status so a wrapper cannot read "some rows moved" as "finished".
  return raced > 0 ? 2 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
