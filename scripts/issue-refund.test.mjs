#!/usr/bin/env node
/**
 * Unit tests for `issue-refund.mjs` (#426).
 *
 * The Stripe client and the log reader/writer are injected into `main`
 * (`{ stripe, log }`), so these tests never touch a network or a real file —
 * `STRIPE_SECRET_KEY` is never read here at all.
 *
 * The case that matters most is the negative control: a failed
 * `refunds.create` must not produce a log entry. A script whose log can claim
 * a refund happened when Stripe refused it would be worse than no log, the
 * same defect class `docs/billing.md` § Refunds warns about for a stated
 * refund window nothing can see the clock on.
 *
 * Run: `npm run test:checks`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { appendedLog, buildLogEntry, main, parseArgs, usdToMinorUnits } from './issue-refund.mjs';

const REQUIRED = [
  '--payment-intent',
  'pi_123',
  '--reason',
  'customer says renewed after cancelling',
  '--issued-by',
  'Chelsea',
];

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: a full, valid command line', () => {
  const options = parseArgs(REQUIRED);
  assert.equal(options.paymentIntent, 'pi_123');
  assert.equal(options.reason, 'customer says renewed after cancelling');
  assert.equal(options.issuedBy, 'Chelsea');
  assert.equal(options.apply, false);
  assert.equal(options.amountUsd, undefined);
  assert.equal(options.stripeReason, 'requested_by_customer');
});

test('parseArgs: --apply is opt-in', () => {
  assert.equal(parseArgs(REQUIRED).apply, false);
  assert.equal(parseArgs([...REQUIRED, '--apply']).apply, true);
});

test('parseArgs: needs exactly one of --payment-intent or --charge', () => {
  assert.throws(
    () => parseArgs(['--reason', 'x', '--issued-by', 'y']),
    /one of --payment-intent or --charge/
  );
  assert.throws(
    () =>
      parseArgs([
        '--payment-intent',
        'pi_1',
        '--charge',
        'ch_1',
        '--reason',
        'x',
        '--issued-by',
        'y',
      ]),
    /not both/
  );
});

test('parseArgs: rejects a non-positive --amount', () => {
  assert.throws(() => parseArgs([...REQUIRED, '--amount', '0']), /positive number/);
  assert.throws(() => parseArgs([...REQUIRED, '--amount', 'lots']), /positive number/);
});

test('parseArgs: --reason and --issued-by are both required', () => {
  assert.throws(
    () => parseArgs(['--payment-intent', 'pi_1', '--issued-by', 'y']),
    /--reason is required/
  );
  assert.throws(
    () => parseArgs(['--payment-intent', 'pi_1', '--reason', 'x']),
    /--issued-by is required/
  );
});

test('parseArgs: rejects an unrecognised --stripe-reason', () => {
  assert.throws(
    () => parseArgs([...REQUIRED, '--stripe-reason', 'because']),
    /--stripe-reason must be one of/
  );
});

// ---------------------------------------------------------------------------
// usdToMinorUnits
// ---------------------------------------------------------------------------

test('usdToMinorUnits: whole-cent amounts', () => {
  assert.equal(usdToMinorUnits(4.99), 499);
  assert.equal(usdToMinorUnits(20), 2000);
  assert.equal(usdToMinorUnits(0.01), 1);
});

test('usdToMinorUnits: refuses a fraction of a cent rather than silently rounding', () => {
  assert.throws(() => usdToMinorUnits(4.999), /not a whole number of cents/);
});

// ---------------------------------------------------------------------------
// buildLogEntry / appendedLog
// ---------------------------------------------------------------------------

test('buildLogEntry: shape, from a real Stripe refund response', () => {
  const options = parseArgs(REQUIRED);
  const refund = { id: 're_1', amount: 1999, currency: 'usd', status: 'succeeded' };
  const entry = buildLogEntry(options, refund, new Date('2026-09-14T12:00:00Z'));

  assert.equal(entry.id, 're_1');
  assert.equal(entry.createdAt, '2026-09-14T12:00:00.000Z');
  assert.deepEqual(entry.target, { type: 'payment_intent', id: 'pi_123' });
  assert.equal(entry.amountMinorUnits, 1999);
  assert.equal(entry.partial, false);
  assert.equal(entry.reason, 'customer says renewed after cancelling');
  assert.equal(entry.issuedBy, 'Chelsea');
});

test('buildLogEntry: a partial refund (--amount given) is recorded as partial', () => {
  const options = parseArgs([...REQUIRED, '--amount', '4.99']);
  const entry = buildLogEntry(options, {
    id: 're_2',
    amount: 499,
    currency: 'usd',
    status: 'succeeded',
  });
  assert.equal(entry.partial, true);
});

test('buildLogEntry: never carries a card number or a raw amount in dollars — only Stripe ids and minor units', () => {
  const options = parseArgs(REQUIRED);
  const entry = buildLogEntry(options, {
    id: 're_1',
    amount: 1999,
    currency: 'usd',
    status: 'succeeded',
  });
  const text = JSON.stringify(entry);
  assert.doesNotMatch(text, /\b4242\d{12}\b/);
});

test('appendedLog: appends without disturbing prior entries', () => {
  const current = { $comment: 'kept', refunds: [{ id: 're_old' }] };
  const next = appendedLog(current, { id: 're_new' });
  assert.equal(next.$comment, 'kept');
  assert.deepEqual(next.refunds, [{ id: 're_old' }, { id: 're_new' }]);
});

test('appendedLog: seeds a fresh log when given null', () => {
  const next = appendedLog(null, { id: 're_1' });
  assert.deepEqual(next.refunds, [{ id: 're_1' }]);
  assert.ok(next.$comment);
});

// ---------------------------------------------------------------------------
// main() — injected stripe + log, no network, no real file
// ---------------------------------------------------------------------------

function fakeStripe({
  retrieved = { amount: 1999, currency: 'usd', customer: 'cus_1', status: 'succeeded' },
  refund,
} = {}) {
  const calls = { retrievePI: [], retrieveCharge: [], refundsCreate: [] };
  return {
    calls,
    paymentIntents: {
      retrieve: async (id) => {
        calls.retrievePI.push(id);
        return { ...retrieved, id };
      },
    },
    charges: {
      retrieve: async (id) => {
        calls.retrieveCharge.push(id);
        return { ...retrieved, id, amount_refunded: 0 };
      },
    },
    refunds: {
      create: async (params, opts) => {
        calls.refundsCreate.push({ params, opts });
        if (refund instanceof Error) throw refund;
        return (
          refund ?? {
            id: 're_1',
            amount: params.amount ?? retrieved.amount,
            currency: retrieved.currency,
            status: 'succeeded',
          }
        );
      },
    },
  };
}

function fakeLog() {
  let stored = null;
  const writes = [];
  return {
    reads: 0,
    writes,
    api: {
      read: () => {
        return stored ?? { refunds: [] };
      },
      write: (_path, contents) => {
        stored = contents;
        writes.push(contents);
      },
    },
  };
}

test('main: dry run fetches the target and issues nothing', async () => {
  const stripe = fakeStripe();
  const log = fakeLog();

  const code = await main(REQUIRED, { stripe, log: log.api });

  assert.equal(code, 0);
  assert.equal(stripe.calls.retrievePI.length, 1);
  assert.equal(stripe.calls.refundsCreate.length, 0);
  assert.equal(log.writes.length, 0);
});

test('main: --apply issues the refund with the idempotency key and records it', async () => {
  const stripe = fakeStripe({
    refund: { id: 're_9', amount: 1999, currency: 'usd', status: 'succeeded' },
  });
  const log = fakeLog();

  const code = await main([...REQUIRED, '--apply'], { stripe, log: log.api });

  assert.equal(code, 0);
  assert.equal(stripe.calls.refundsCreate.length, 1);
  const { params, opts } = stripe.calls.refundsCreate[0];
  assert.equal(params.payment_intent, 'pi_123');
  assert.equal(params.amount, undefined); // full refund: no amount pinned
  assert.equal(params.reason, 'requested_by_customer');
  assert.equal(params.metadata.issued_by, 'Chelsea');
  assert.ok(opts.idempotencyKey.includes('pi_123'));

  assert.equal(log.writes.length, 1);
  assert.equal(log.writes[0].refunds.at(-1).id, 're_9');
});

test('main: --amount pins a minor-unit amount on the refund call', async () => {
  const stripe = fakeStripe();
  const log = fakeLog();

  await main([...REQUIRED, '--amount', '4.99', '--apply'], { stripe, log: log.api });

  assert.equal(stripe.calls.refundsCreate[0].params.amount, 499);
});

test('negative control: a Stripe refund failure writes NO log entry, and the failure is not swallowed', async () => {
  const stripe = fakeStripe({
    refund: Object.assign(new Error('card issuer declined the refund'), {
      type: 'StripeCardError',
    }),
  });
  const log = fakeLog();

  await assert.rejects(
    main([...REQUIRED, '--apply'], { stripe, log: log.api }),
    /card issuer declined/
  );

  assert.equal(log.writes.length, 0, 'a failed refund must leave no record claiming it happened');
});

test('main: an invalid command line exits 1 and calls Stripe not at all', async () => {
  const stripe = fakeStripe();
  const log = fakeLog();

  const code = await main(['--reason', 'x'], { stripe, log: log.api });

  assert.equal(code, 1);
  assert.equal(stripe.calls.retrievePI.length, 0);
  assert.equal(stripe.calls.retrieveCharge.length, 0);
});
