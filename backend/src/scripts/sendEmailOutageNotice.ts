#!/usr/bin/env -S npx tsx
/**
 * Operator CLI for the one-time email-outage service note
 * (`services/emailOutageNotice.ts` carries the contract and the approved
 * text). Run by hand, once, before the weekly digest at 2026-11-23 00:00 UTC.
 * Like `sendPriceChangeNotice.ts`, it lives under `src/` so `tsc` and `eslint`
 * cover it, and it is never bundled into a Lambda.
 *
 * Dry run by default: reads only (DynamoDB Scan/Query/GetItem and Cognito
 * AdminGetUser), writes nothing, sends nothing, and prints counts only, never
 * an address, a name or an id. `--confirm` sends: it writes one marker per
 * recipient and hands each email to SES.
 *
 * Refuses to run at or after the cutoff unless `--late` is passed: the note
 * exists to explain the digest, and after the digest it reads differently.
 *
 * Usage (`npm run notify:email-outage --workspace backend --`):
 *
 *   tsx src/scripts/sendEmailOutageNotice.ts                 # dry run
 *   tsx src/scripts/sendEmailOutageNotice.ts --confirm       # send
 *   tsx src/scripts/sendEmailOutageNotice.ts --allowlist ids.txt
 *
 * `--allowlist` takes a file of household ids, one per line (`#` comments and
 * blank lines ignored), and replaces the Cognito creator check. Environment:
 * see docs/runbooks.md § _Send the email-outage notice_.
 */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import {
  NOTICE_ID,
  SEND_CUTOFF,
  planEmailOutageNotice,
  previewSuppression,
  sendEmailOutageNotice,
} from '../services/emailOutageNotice.js';

export interface CliArgs {
  confirm: boolean;
  late: boolean;
  allowlist: string | null;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      confirm: { type: 'boolean', default: false },
      late: { type: 'boolean', default: false },
      allowlist: { type: 'string' },
    },
  });
  return {
    confirm: values.confirm === true,
    late: values.late === true,
    allowlist: typeof values.allowlist === 'string' ? values.allowlist : null,
  };
}

/** Null when the run may go ahead; otherwise the reason it may not. */
export function cutoffRefusal(now: Date, late: boolean): string | null {
  if (late || now.getTime() < Date.parse(SEND_CUTOFF)) return null;
  return (
    `It is past ${SEND_CUTOFF}, when the weekly digest goes out. This note was approved to ` +
    'land before it. Pass --late to run anyway.'
  );
}

/** Null when the environment can send real, correctly linked mail. */
export function sendEnvironmentProblem(env: NodeJS.ProcessEnv): string | null {
  if (!env.SES_FROM_EMAIL?.trim()) return 'SES_FROM_EMAIL is not set, so nothing would be sent.';
  if (!env.FRONTEND_URL?.trim().startsWith('https://')) {
    return 'FRONTEND_URL is not an https URL, so the Settings links would be wrong.';
  }
  return null;
}

export function parseAllowlist(contents: string): Set<string> {
  return new Set(
    contents
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean)
  );
}

export interface RunDeps {
  now: Date;
  env: NodeJS.ProcessEnv;
  print: (line: string) => void;
  readFile: (path: string) => string;
}

/** The whole run, minus process wiring. Returns the exit code. */
export async function run(argv: readonly string[], deps: RunDeps): Promise<number> {
  const { now, env, print } = deps;
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    print((err as Error).message);
    return 1;
  }

  const refusal = cutoffRefusal(now, args.late);
  if (refusal) {
    print(refusal);
    return 1;
  }

  const envProblem = sendEnvironmentProblem(env);
  if (args.confirm && envProblem) {
    print(`Not sending: ${envProblem}`);
    return 1;
  }

  const allowlist = args.allowlist ? parseAllowlist(deps.readFile(args.allowlist)) : undefined;
  const plan = await planEmailOutageNotice({ now, allowlist });

  print(`Email outage notice (${NOTICE_ID}): ${args.confirm ? 'SENDING' : 'dry run'}`);
  print(
    `Households: ${plan.householdsScanned} scanned, ` +
      (allowlist
        ? `${plan.householdsNotAllowlisted} not on the allowlist, `
        : `${plan.householdsExcludedAsTest} left out as test households (creator not in Cognito), `) +
      `${plan.householdsWithEndedTrial} with a trial that ended during the outage.`
  );

  if (!args.confirm) {
    const preview = await previewSuppression(plan.recipients);
    const withTrial = preview.sendable.filter((r) => r.trial).length;
    print(
      `Recipients: ${preview.sendable.length} would be emailed, ` +
        `${withTrial} of them with the trial paragraph.`
    );
    print(
      `Skipped: ${plan.skipped.emailOff} email turned off, ` +
        `${plan.skipped.alreadySent} already sent, ` +
        `${plan.skipped.noAddress} no address, ` +
        `${preview.suppressed} suppressed, ` +
        `${preview.suppressionUnknown} suppression status unknown.`
    );
    if (envProblem) print(`Note: --confirm would refuse to run here: ${envProblem}`);
    print('Dry run only: nothing was emailed and nothing was written. Pass --confirm to send.');
    return 0;
  }

  const summary = await sendEmailOutageNotice(plan.recipients, { now });
  print(
    `Sent: ${summary.sent}, ${summary.sentWithTrialParagraph} of them with the trial paragraph.`
  );
  print(
    `Skipped: ${plan.skipped.emailOff} email turned off, ` +
      `${plan.skipped.alreadySent + summary.alreadySent} already sent, ` +
      `${plan.skipped.noAddress} no address, ` +
      `${summary.suppressed} suppressed, ` +
      `${summary.suppressionUnknown} suppression status unknown.`
  );
  const unsent = summary.notConfigured + summary.failed;
  if (unsent > 0) {
    print(
      `Not sent: ${summary.failed} failed, ${summary.notConfigured} not configured. ` +
        'Their markers were released; re-running sends only to them.'
    );
    return 1;
  }
  return 0;
}

// Only run when executed directly, never on import, so the tests can import
// the functions above without touching AWS.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2), {
    now: new Date(),
    env: process.env,
    print: (line) => console.info(line),
    readFile: (path) => readFileSync(path, 'utf8'),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error((err as Error).message);
      process.exitCode = 1;
    });
}
