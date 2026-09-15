#!/usr/bin/env node
/**
 * Issue a real Stripe refund, by hand, for a case the operator has already
 * decided on (#426).
 *
 * ## Why this exists, and why it does not contradict `docs/billing.md` § Refunds
 *
 * `legal.terms.refunds.policy` says "nothing in the service issues a refund
 * on its own", and `backend/tests/unit/config/refundPosture.test.ts` fails if
 * any path under `backend/src` — the deployed service — ever acquires a
 * Stripe refund call. That sentence is about the SERVICE acting on its own:
 * nothing automatic, nothing customer-triggered, nothing a request handler
 * can reach. It says nothing about an operator's own tooling, any more than
 * the Stripe Dashboard contradicts it — `docs/billing.md` already names "made
 * by hand in the Stripe dashboard, with the operator's own credentials" as
 * the intended path. This script is that same action, run from a terminal
 * instead of a browser, with the trade made explicit: a paper trail
 * (`docs/refund-log.json`, committed) that a dashboard click does not leave
 * in this repository.
 *
 * Deliberately lives at the repo root, in plain Node, NOT under
 * `backend/src` — `refundPosture.test.ts` only walks `backend/src`, on
 * purpose, so this script is out of its scope by construction rather than by
 * a carve-out inside it. Nothing in `backend/src` calls Stripe's refund API;
 * that remains true with this script in the tree, and remains machine-checked.
 *
 * ## What this still does NOT do
 *
 * It does not decide WHETHER a refund is owed — that is the operator's call,
 * made after the support-mailbox conversation `docs/billing.md` describes as
 * the intake. It does not track a refund WINDOW (issue #426 question 1 is
 * still open) and does not reconcile a refunded pack's identification credits
 * (question 4, also still open) — those remain exactly as manual as
 * `docs/billing.md` § Refunds already says. This is tooling for the "make it
 * happen" step, not a policy engine for the "should it happen" step.
 *
 * ## Safety
 *
 * Dry run by default: fetches and prints the target (amount, currency,
 * customer, already-refunded amount) and what WOULD be refunded, and issues
 * nothing. `--apply` is required to actually call Stripe. An idempotency key
 * derived from the target and amount means re-running the same command
 * (including by accident) cannot double-refund.
 *
 * ## Usage
 *
 *   # dry run — always safe, issues nothing
 *   STRIPE_SECRET_KEY=sk_... node scripts/issue-refund.mjs \
 *     --payment-intent pi_... --reason "customer says renewed after cancelling" \
 *     --issued-by "Chelsea"
 *
 *   # a partial refund, live
 *   STRIPE_SECRET_KEY=sk_... node scripts/issue-refund.mjs \
 *     --charge ch_... --amount 4.99 \
 *     --reason "duplicate charge, confirmed in Stripe dashboard" \
 *     --issued-by "Chelsea" --apply
 *
 * `STRIPE_SECRET_KEY` comes from the ambient environment, same as every other
 * Stripe-touching script in this repo — never pass it on the command line.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import Stripe from 'stripe';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOG_PATH = join(ROOT, 'docs', 'refund-log.json');

const VALID_STRIPE_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    paymentIntent: undefined,
    charge: undefined,
    amountUsd: undefined, // undefined => full refund
    reason: undefined,
    stripeReason: 'requested_by_customer',
    issuedBy: process.env.REFUND_ISSUED_BY,
    apply: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };

    if (arg === '--payment-intent') options.paymentIntent = value();
    else if (arg === '--charge') options.charge = value();
    else if (arg === '--amount') options.amountUsd = Number(value());
    else if (arg === '--reason') options.reason = value();
    else if (arg === '--stripe-reason') options.stripeReason = value();
    else if (arg === '--issued-by') options.issuedBy = value();
    else if (arg === '--apply') options.apply = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.paymentIntent && !options.charge) {
    throw new Error('one of --payment-intent or --charge is required');
  }
  if (options.paymentIntent && options.charge) {
    throw new Error(
      'pass --payment-intent OR --charge, not both — they identify the same money two ways'
    );
  }
  if (
    options.amountUsd !== undefined &&
    (!Number.isFinite(options.amountUsd) || options.amountUsd <= 0)
  ) {
    throw new Error('--amount must be a positive number of dollars, or omit it for a full refund');
  }
  if (!options.reason || !options.reason.trim()) {
    throw new Error(
      '--reason is required — what the customer said or what looked wrong. Written to docs/refund-log.json.'
    );
  }
  if (!VALID_STRIPE_REASONS.includes(options.stripeReason)) {
    throw new Error(`--stripe-reason must be one of ${VALID_STRIPE_REASONS.join(', ')}`);
  }
  if (!options.issuedBy || !options.issuedBy.trim()) {
    throw new Error(
      '--issued-by is required (or set REFUND_ISSUED_BY) — whose decision this was, for the log'
    );
  }
  return options;
}

/** Dollars to the minor-unit integer Stripe's `amount` wants. Refuses to
 *  round a fraction of a cent silently: `4.999` is a caller error, not 500. */
export function usdToMinorUnits(amountUsd) {
  const minorUnits = amountUsd * 100;
  if (Math.abs(minorUnits - Math.round(minorUnits)) > 1e-6) {
    throw new Error(`--amount ${amountUsd} is not a whole number of cents`);
  }
  return Math.round(minorUnits);
}

// ---------------------------------------------------------------------------
// The durable log — committed, so the refund has a record this repository
// keeps even though the action itself happens entirely inside Stripe.
// ---------------------------------------------------------------------------

const LOG_SEED = {
  $comment:
    'Every refund issued through scripts/issue-refund.mjs (#426). No card numbers or ' +
    'customer PII beyond a Stripe object id — those are not secrets, the same ids the ' +
    'Stripe Dashboard shows. Append-only; never edit or remove a past entry.',
  refunds: [],
};

/** Pure: builds the record this run would append. Takes `refund` as returned
 *  by `stripe.refunds.create`, so it is testable against a fixture without a
 *  network call. */
export function buildLogEntry(options, refund, now = new Date()) {
  return {
    id: refund.id,
    createdAt: now.toISOString(),
    target: options.paymentIntent
      ? { type: 'payment_intent', id: options.paymentIntent }
      : { type: 'charge', id: options.charge },
    amountMinorUnits: refund.amount,
    currency: refund.currency,
    partial: options.amountUsd !== undefined,
    reason: options.reason,
    stripeReason: options.stripeReason,
    issuedBy: options.issuedBy,
    status: refund.status,
  };
}

/** Pure: current log contents in, next contents out. */
export function appendedLog(current, entry) {
  const base = current ?? LOG_SEED;
  return { ...base, refunds: [...(base.refunds ?? []), entry] };
}

function readLog(path) {
  if (!existsSync(path)) return LOG_SEED;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeLog(path, contents) {
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is required (ambient environment, never a flag)');
  return new Stripe(key);
}

async function describeTarget(stripe, options) {
  if (options.paymentIntent) {
    const pi = await stripe.paymentIntents.retrieve(options.paymentIntent);
    return {
      amount: pi.amount,
      currency: pi.currency,
      customer: typeof pi.customer === 'string' ? pi.customer : (pi.customer?.id ?? null),
      status: pi.status,
    };
  }
  const charge = await stripe.charges.retrieve(options.charge);
  return {
    amount: charge.amount,
    currency: charge.currency,
    customer: typeof charge.customer === 'string' ? charge.customer : (charge.customer?.id ?? null),
    status: charge.status,
    amountRefunded: charge.amount_refunded,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv, { stripe = null, log = { read: readLog, write: writeLog } } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(
      '\nUsage: node scripts/issue-refund.mjs --payment-intent pi_... --reason "..." ' +
        '--issued-by "name" [--amount 4.99] [--apply]'
    );
    return 1;
  }

  const client = stripe ?? getStripe();
  const target = await describeTarget(client, options);
  console.log('Target:', JSON.stringify(target, null, 2));

  const amountMinorUnits =
    options.amountUsd !== undefined ? usdToMinorUnits(options.amountUsd) : undefined;
  console.log(
    amountMinorUnits === undefined
      ? `Would refund the FULL amount: ${target.amount} ${target.currency}`
      : `Would refund ${amountMinorUnits} ${target.currency} (of ${target.amount} ${target.currency})`
  );

  if (!options.apply) {
    console.log(
      '\nDry run only — pass --apply to actually issue the refund. Nothing was refunded.'
    );
    return 0;
  }

  const idempotencyKey = `issue-refund:${options.paymentIntent ?? options.charge}:${options.amountUsd ?? 'full'}`;
  const refund = await client.refunds.create(
    {
      ...(options.paymentIntent
        ? { payment_intent: options.paymentIntent }
        : { charge: options.charge }),
      ...(amountMinorUnits !== undefined ? { amount: amountMinorUnits } : {}),
      reason: options.stripeReason,
      metadata: {
        operator_reason: options.reason.slice(0, 490),
        issued_by: options.issuedBy,
      },
    },
    { idempotencyKey }
  );

  console.log(
    '\nRefund issued:',
    JSON.stringify(
      { id: refund.id, amount: refund.amount, currency: refund.currency, status: refund.status },
      null,
      2
    )
  );

  const entry = buildLogEntry(options, refund);
  log.write(LOG_PATH, appendedLog(log.read(LOG_PATH), entry));
  console.log(
    '\nRecorded in docs/refund-log.json. Commit that file so the refund has a durable record.'
  );
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
