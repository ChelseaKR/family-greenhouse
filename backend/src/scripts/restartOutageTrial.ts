#!/usr/bin/env -S npx tsx
/**
 * Operator CLI that restarts one household's no-card Garden trial for 14 days,
 * for a household whose trial ended during the 2026-09-04 to 2026-11-19 email
 * outage and whose admin replied to the outage notice asking for it
 * (`services/outageTrialRestart.ts` carries the rules; ADR 0027's 2026-11-19
 * amendment is the decision). Like `sendEmailOutageNotice.ts`, it lives under
 * `src/` so `tsc` and `eslint` cover it, and it is never bundled into a Lambda.
 *
 * Dry run by default: reads only (DynamoDB GetItem and Query), writes nothing,
 * and prints counts and dates only, never an address, a name or an id.
 * `--confirm` writes the two trial dates and the once-only marker.
 *
 * Usage (`npm run trial:restart-outage --workspace backend --`):
 *
 *   tsx src/scripts/restartOutageTrial.ts <householdId>              # dry run
 *   tsx src/scripts/restartOutageTrial.ts <householdId> --confirm    # write
 *
 * Environment: see docs/runbooks.md § _Restart an outage household's trial_.
 */
import { parseArgs } from 'node:util';
import {
  REFUSAL_TEXT,
  RESTART_ID,
  planOutageTrialRestart,
  restartOutageTrial,
} from '../services/outageTrialRestart.js';

export interface CliArgs {
  householdId: string;
  confirm: boolean;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { confirm: { type: 'boolean', default: false } },
  });
  if (positionals.length !== 1 || !positionals[0]?.trim()) {
    throw new Error('Pass exactly one household id.');
  }
  return { householdId: positionals[0].trim(), confirm: values.confirm === true };
}

export interface RunDeps {
  now: Date;
  print: (line: string) => void;
}

/** The whole run, minus process wiring. Returns the exit code. */
export async function run(argv: readonly string[], deps: RunDeps): Promise<number> {
  const { now, print } = deps;
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    print((err as Error).message);
    return 1;
  }

  print(`No-card trial restart (${RESTART_ID}): ${args.confirm ? 'WRITING' : 'dry run'}`);
  const plan = await planOutageTrialRestart(args.householdId, now);
  if (!plan.ok) {
    print(`Refused: ${REFUSAL_TEXT[plan.reason]} Nothing was written.`);
    return 1;
  }

  print(
    `Old trial: ${plan.oldTrial.startedAt} to ${plan.oldTrial.endedAt}, ended during the outage.`
  );
  print(`New trial: starts ${plan.startedAt}, ends ${plan.endsAt} (the two trial dates written).`);
  print(
    `Trial emails: day 10 due from ${plan.day10From}, day 14 from ${plan.endsAt} ` +
      `until ${plan.day14Until}; ${plan.trialEmailMarkers} earlier trial-email markers.`
  );
  print(`Admins: ${plan.admins}, ${plan.adminsReachable} with email and trial notices on.`);

  if (!args.confirm) {
    print('Dry run only: nothing was written. Pass --confirm to start the trial.');
    return 0;
  }

  const result = await restartOutageTrial(args.householdId, plan, now);
  if (result.status === 'restarted') {
    print(`Restarted: the trial runs from ${result.startedAt} to ${result.endsAt}.`);
    return 0;
  }
  if (result.status === 'already_restarted') {
    print(`Refused: ${REFUSAL_TEXT.already_restarted} Nothing was written.`);
    return 1;
  }
  print(
    'Refused: the household row changed after it was read (its trial end, plan, gift, ' +
      'Stripe or App Store fields). Nothing was written. Run the dry run again.'
  );
  return 1;
}

// Only run when executed directly, never on import, so the tests can import
// the functions above without touching AWS.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2), { now: new Date(), print: (line) => console.info(line) })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error((err as Error).message);
      process.exitCode = 1;
    });
}
