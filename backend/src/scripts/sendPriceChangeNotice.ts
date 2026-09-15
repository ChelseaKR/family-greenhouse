#!/usr/bin/env -S npx tsx
/**
 * Operator CLI for the 14-day price-change notice (#710).
 * `docs/billing.md` § _Price changes_ and `services/priceChangeNotices.ts`
 * carry the full contract; this file is the entrypoint an operator runs by
 * hand when a plan price is actually about to move. Nothing calls it
 * automatically. It lives under `src/` (not `backend/scripts/`, which is
 * plain-Node static-analysis tooling only) so `tsc --noEmit` and `eslint`
 * actually cover it — `tsconfig.json`'s `include` covers everything under
 * `src/`. It is not a
 * Lambda handler: `esbuild.config.js` only bundles files named `handler.ts`
 * under `src/handlers`, so this is never shipped to production, matching
 * `src/local-server.ts`, the one other directly-executed file under `src/`.
 *
 * Dry run by default: prints the announcement's problems (if any) and how
 * many households would be notified, and sends nothing. Pass `--confirm` to
 * actually send — this reaches real inboxes through SES (or dry-runs inside
 * `emailNotifier` if `SES_FROM_EMAIL` is unset) and writes real DynamoDB
 * markers, so it needs the same ambient AWS credentials as
 * `scripts/sweep-test-fixtures.mjs` (`AWS_PROFILE` locally, the OIDC role in
 * CI) plus `TABLE_NAME` pointed at the right environment.
 *
 * Usage (`npm run notify:price-change --workspace backend --`):
 *
 *   tsx src/scripts/sendPriceChangeNotice.ts \
 *     --id garden-monthly-2026-11-01 \
 *     --plan garden --interval month \
 *     --old 4.99 --new 5.99 \
 *     --effective 2026-11-01 \
 *     --summary "Garden monthly is moving from $4.99 to $5.99; see ADR NNNN."
 *
 *   # add --confirm to actually send; omit it to see the dry run first
 *
 * On a successful send, appends an entry to `docs/price-change-notices.json`
 * with `emailedOn` set to today and an empty `sites: []` — exactly the shape
 * `priceChangeNoticeGate.ts` already treats as passing ("an email that is out
 * while the code is not written yet"). When the PR that actually moves the
 * running-subscription price ships, add that PR's `sites` entries to THIS
 * notice by its `--id` rather than creating a new one; see
 * `docs/billing.md` § _Price changes_.
 */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validatePriceChangeAnnouncement,
  type PriceChangeAnnouncement,
} from '../models/priceChangeAnnouncement.js';
import { affectedHouseholdIds, sendPriceChangeNotice } from '../services/priceChangeNotices.js';
import { isPlanId } from '../models/plans.js';

const LEDGER_PATH = fileURLToPath(
  new URL('../../../docs/price-change-notices.json', import.meta.url)
);

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface CliArgs {
  id: string;
  plan: string;
  interval: string;
  old: number;
  new: number;
  effective: string;
  summary: string;
  confirm: boolean;
}

/** Pure parse: throws a plain, readable Error on anything wrong rather than
 *  printing usage and calling `process.exit` — so this half is unit-testable
 *  without spawning a process. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      id: { type: 'string' },
      plan: { type: 'string' },
      interval: { type: 'string' },
      old: { type: 'string' },
      new: { type: 'string' },
      effective: { type: 'string' },
      summary: { type: 'string' },
      confirm: { type: 'boolean', default: false },
    },
  });

  const required = ['id', 'plan', 'interval', 'old', 'new', 'effective', 'summary'] as const;
  const missing = required.filter((key) => values[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`missing required argument(s): ${missing.map((m) => `--${m}`).join(', ')}`);
  }

  const old = Number(values.old);
  const next = Number(values.new);
  if (!Number.isFinite(old)) throw new Error(`--old must be a number: got ${String(values.old)}`);
  if (!Number.isFinite(next)) throw new Error(`--new must be a number: got ${String(values.new)}`);

  return {
    id: values.id as string,
    plan: values.plan as string,
    interval: values.interval as string,
    old,
    new: next,
    effective: values.effective as string,
    summary: values.summary as string,
    confirm: values.confirm === true,
  };
}

export function announcementFromArgs(args: CliArgs): PriceChangeAnnouncement {
  if (!isPlanId(args.plan)) {
    throw new Error(`--plan must be one of seedling, garden, greenhouse: got ${args.plan}`);
  }
  if (args.interval !== 'month' && args.interval !== 'year') {
    throw new Error(`--interval must be "month" or "year": got ${args.interval}`);
  }
  return {
    id: args.id,
    planId: args.plan,
    interval: args.interval,
    summary: args.summary,
    oldPriceUsd: args.old,
    newPriceUsd: args.new,
    effectiveOn: args.effective,
  };
}

interface LedgerFile {
  $comment?: string;
  notices: Array<Record<string, unknown>>;
}

/** The ledger entry a successful send earns. Pure: takes the ledger's current
 *  contents in and returns the next contents, so it is testable without
 *  touching a real file. Updates an existing entry with this `id` in place
 *  (re-running the same announcement after a partial send must not create a
 *  duplicate); appends a new one otherwise. */
export function nextLedgerContents(
  current: LedgerFile,
  announcement: PriceChangeAnnouncement,
  emailedOn: string
): LedgerFile {
  const entry = {
    id: announcement.id,
    summary: announcement.summary,
    emailedOn,
    effectiveOn: announcement.effectiveOn,
    // Empty on purpose: nothing in backend/src moves a running subscription
    // yet. Add sites here, in the PR that adds that call.
    sites: [] as unknown[],
  };
  const notices = Array.isArray(current.notices) ? current.notices : [];
  const at = notices.findIndex((n) => n.id === announcement.id);
  const nextNotices = at >= 0 ? notices.map((n, i) => (i === at ? entry : n)) : [...notices, entry];
  return { ...current, notices: nextNotices };
}

function readLedger(path: string): LedgerFile {
  return JSON.parse(readFileSync(path, 'utf8')) as LedgerFile;
}

function writeLedger(path: string, contents: LedgerFile): void {
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error('\nSee the usage block at the top of this script.');
    process.exitCode = 1;
    return;
  }

  const announcement = announcementFromArgs(args);
  const today = todayIso();
  const problems = validatePriceChangeAnnouncement(announcement, today);
  if (problems.length > 0) {
    console.error('This announcement is not ready to send:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const affected = await affectedHouseholdIds(announcement.planId);
  console.info(
    `${affected.length} household(s) on plan "${announcement.planId}" with a live Stripe ` +
      'subscription would be notified (every admin on each of them).'
  );

  if (!args.confirm) {
    console.info('\nDry run only — pass --confirm to actually send. Nothing was emailed.');
    return;
  }

  const summary = await sendPriceChangeNotice(announcement, { today });
  console.info('\nSend complete:');
  console.info(JSON.stringify(summary, null, 2));

  const ledger = nextLedgerContents(readLedger(LEDGER_PATH), announcement, today);
  writeLedger(LEDGER_PATH, ledger);
  console.info(
    `\nRecorded in docs/price-change-notices.json (id: "${announcement.id}", emailedOn: ${today}).`
  );
  console.info(
    'Commit that file alongside this run. When the PR that actually moves the running-' +
      'subscription price ships, add its sites[] entries to this same notice — see ' +
      'docs/billing.md § Price changes.'
  );
}

// Only run when executed directly (`tsx src/scripts/sendPriceChangeNotice.ts`),
// never on import — this is what lets the test suite import the pure
// functions above without sending anything or touching AWS.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
