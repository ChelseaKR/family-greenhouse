/**
 * The price-change notice gate (#710), as pure functions so the test that
 * enforces it can also prove, on every run, that it fails.
 *
 * ## The promise
 *
 * `legal.terms.priceChanges.body`: a new price applies to new subscriptions; a
 * running subscription keeps the price it started at; and if one ever has to
 * move, the household's admins are emailed at least 14 days before the new
 * price takes effect, "and the price does not move until that has been done".
 *
 * ## Where a running subscription's charge can actually change
 *
 * Not in the price catalog. `models/plans.ts` and the `stripe_price_id_*`
 * tfvars decide what a NEW checkout is charged; a running subscription holds
 * its own Stripe price, and Stripe does not allow a price's amount to be
 * edited. The Terms say a new price for new subscriptions needs no notice, so a
 * gate that demanded one there would block a change the Terms allow and invite
 * a notice record for an email nobody needed to send.
 *
 * What CAN change it is a Stripe call that edits a running subscription or the
 * invoice it renews on. Those are listed below. Every one of them must be
 * covered by a dated notice in `docs/price-change-notices.json`, or the gate
 * fails. Today none exists in `backend/src`, and the ledger is empty.
 *
 * ## What it cannot see
 *
 * It is a denylist over source text, so a call spelled a way nobody listed
 * (bracket access, a wrapper in a dependency) would pass; each pattern carries
 * a sample it must match and a near miss it must not, so a pattern that has
 * silently stopped matching fails rather than passing. `emailedOn` is an
 * attestation: no test can see an inbox. And no repository gate can see the
 * Stripe Dashboard, where a person can migrate subscriptions with no code
 * change at all.
 */

export const MIN_NOTICE_DAYS = 14;

export interface RepricingSurface {
  /** The name a notice's `sites[].surface` uses. */
  surface: string;
  /** Global, so a file with two calls counts as two. */
  pattern: RegExp;
  /** A call this pattern MUST match: proves it still sees what it names. */
  sample: string;
  /** A neighbouring call it must NOT match: proves it is not matching everything. */
  nearMiss: string;
}

export const REPRICING_SURFACES: readonly RepricingSurface[] = [
  {
    surface: 'subscriptions.update',
    pattern: /\bsubscriptions\s*\.\s*update\s*\(/g,
    sample: 'await stripe.subscriptions.update(subscriptionId, { items })',
    nearMiss: 'await stripe.subscriptions.cancel(subscriptionId, {})',
  },
  {
    surface: 'subscriptions.migrate',
    pattern: /\bsubscriptions\s*\.\s*migrate\s*\(/g,
    sample: 'await stripe.subscriptions.migrate(subscriptionId, params)',
    nearMiss: 'await stripe.subscriptions.retrieve(subscriptionId)',
  },
  {
    surface: 'subscriptionItems',
    pattern: /\bsubscriptionItems\s*\./g,
    sample: 'await stripe.subscriptionItems.create({ subscription, price })',
    nearMiss: 'const subscriptionItemsSeen = 0',
  },
  {
    surface: 'subscriptionSchedules',
    pattern: /\bsubscriptionSchedules\s*\./g,
    sample: 'await stripe.subscriptionSchedules.create({ from_subscription: subscriptionId })',
    nearMiss: 'const subscriptionSchedulesEnabled = false',
  },
  {
    surface: 'invoiceItems',
    pattern: /\binvoiceItems\s*\./g,
    sample: 'await stripe.invoiceItems.create({ customer, amount: 500, currency })',
    nearMiss: 'const invoiceItemsSeen = 0',
  },
  {
    surface: 'invoices.update',
    pattern: /\binvoices\s*\.\s*(?:update|addLines|updateLines|removeLines)\s*\(/g,
    sample: 'await stripe.invoices.addLines(invoiceId, { lines })',
    nearMiss: 'await stripe.invoices.retrieve(invoiceId)',
  },
  {
    surface: 'deleteDiscount',
    pattern: /\b(?:subscriptions|customers)\s*\.\s*deleteDiscount\s*\(/g,
    sample: 'await stripe.subscriptions.deleteDiscount(subscriptionId)',
    nearMiss: 'await stripe.coupons.list()',
  },
  {
    surface: 'customers.createBalanceTransaction',
    pattern: /\bcustomers\s*\.\s*createBalanceTransaction\s*\(/g,
    sample: 'await stripe.customers.createBalanceTransaction(customer, { amount: 500, currency })',
    nearMiss: 'await stripe.customers.listBalanceTransactions(customer)',
  },
  {
    surface: 'rawRequest',
    pattern: /\brawRequest\s*\(/g,
    sample: "await stripe.rawRequest('POST', '/v1/subscriptions/sub_1', { items })",
    nearMiss: 'const request = buildRequest(input)',
  },
];

/** How many times `pattern` occurs in `text`, without sharing `lastIndex` state. */
export function countMatches(pattern: RegExp, text: string): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (text.match(new RegExp(pattern.source, flags)) ?? []).length;
}

/** file (relative to backend/src) -> surface -> number of calls. */
export type RepricingHits = Map<string, Map<string, number>>;

export function scanForRepricing(sources: ReadonlyArray<readonly [string, string]>): RepricingHits {
  const hits: RepricingHits = new Map();
  for (const [file, text] of sources) {
    for (const { surface, pattern } of REPRICING_SURFACES) {
      const count = countMatches(pattern, text);
      if (count === 0) continue;
      const bySurface = hits.get(file) ?? new Map<string, number>();
      bySurface.set(surface, count);
      hits.set(file, bySurface);
    }
  }
  return hits;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
/** Joins a file and a surface into one map key. Neither can contain it. */
const SEP = ' | ';

/**
 * Whole days since 1970-01-01 for a real calendar date, else null. Built with
 * `Date.UTC` and checked by round trip, so "2026-02-30" is rejected and no
 * runner time zone can move a date by one.
 */
export function dayNumber(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return ms / DAY_MS;
}

interface NoticeSite {
  file?: unknown;
  surface?: unknown;
  count?: unknown;
}

interface NoticeRecord {
  id?: unknown;
  summary?: unknown;
  emailedOn?: unknown;
  effectiveOn?: unknown;
  retired?: unknown;
  sites?: unknown;
}

/**
 * Every reason the ledger does not cover the code. Empty means the gate passes.
 *
 * `today` is a `YYYY-MM-DD` date. The only rule that reads it can turn red to
 * green as time passes and never green to red, so this cannot become a
 * calendar bomb on `main`: a covered call is refused only BEFORE its notice's
 * effective date.
 */
export function evaluatePriceChangeNotices(input: {
  hits: RepricingHits;
  ledger: unknown;
  today: string;
}): string[] {
  const failures: string[] = [];
  const today = dayNumber(input.today);
  if (today === null) return [`today is not a calendar date: ${String(input.today)}`];

  const notices = (input.ledger as { notices?: unknown } | null)?.notices;
  if (!Array.isArray(notices)) return ['the notice ledger has no `notices` array'];

  const surfaces = new Set(REPRICING_SURFACES.map((s) => s.surface));
  const claimed = new Map<string, number>();
  const coveredBy = new Map<
    string,
    Array<{ id: string; effective: number | null; effectiveOn: string }>
  >();
  const ids = new Set<string>();

  (notices as NoticeRecord[]).forEach((raw, index) => {
    const fallback = `notices[${index}]`;
    const id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id : fallback;
    if (id === fallback) failures.push(`${id}: needs an id`);
    else if (ids.has(id)) failures.push(`${id}: duplicate id`);
    else ids.add(id);

    if (typeof raw?.summary !== 'string' || raw.summary.trim().length < 20) {
      failures.push(`${id}: needs a summary saying what changes and for whom`);
    }

    const emailed = dayNumber(raw?.emailedOn);
    const effective = dayNumber(raw?.effectiveOn);
    if (emailed === null) failures.push(`${id}: emailedOn must be a real YYYY-MM-DD date`);
    if (effective === null) failures.push(`${id}: effectiveOn must be a real YYYY-MM-DD date`);
    if (emailed !== null && emailed > today) {
      failures.push(
        `${id}: emailedOn ${String(raw.emailedOn)} is in the future; record a notice after the email has gone out, not before`
      );
    }
    if (emailed !== null && effective !== null && effective - emailed < MIN_NOTICE_DAYS) {
      failures.push(
        `${id}: effectiveOn is ${effective - emailed} days after emailedOn; the Terms promise at least ${MIN_NOTICE_DAYS}`
      );
    }

    if (!Array.isArray(raw?.sites)) {
      failures.push(
        `${id}: needs a sites array (empty while the email is out and no code exists yet)`
      );
      return;
    }
    if (raw.retired === true) return;

    for (const site of raw.sites as NoticeSite[]) {
      const surface = site?.surface;
      if (typeof surface !== 'string' || !surfaces.has(surface)) {
        failures.push(`${id}: unknown surface ${String(surface)}`);
        continue;
      }
      if (typeof site.file !== 'string' || !site.file) {
        failures.push(`${id}: a site needs the file, relative to backend/src`);
        continue;
      }
      if (typeof site.count !== 'number' || !Number.isInteger(site.count) || site.count < 1) {
        failures.push(`${id}: ${site.file} ${surface} needs a positive whole-number count`);
        continue;
      }
      const key = `${site.file}${SEP}${surface}`;
      claimed.set(key, (claimed.get(key) ?? 0) + site.count);
      coveredBy.set(key, [
        ...(coveredBy.get(key) ?? []),
        { id, effective, effectiveOn: String(raw.effectiveOn) },
      ]);
    }
  });

  const keys = new Set(claimed.keys());
  for (const [file, bySurface] of input.hits) {
    for (const surface of bySurface.keys()) keys.add(`${file}${SEP}${surface}`);
  }

  for (const key of [...keys].sort()) {
    const [file, surface] = key.split(SEP);
    const found = input.hits.get(file)?.get(surface) ?? 0;
    const covered = claimed.get(key) ?? 0;
    if (found > covered) {
      failures.push(
        `backend/src/${file}: ${found} call(s) to ${surface}, ${covered} covered by a dated notice. ` +
          'This call can change what a running subscription is charged. Send the email first, then ' +
          'record it in docs/price-change-notices.json with a sites entry for this call.'
      );
    } else if (found < covered) {
      failures.push(
        `backend/src/${file}: notices claim ${covered} call(s) to ${surface}, ${found} found. If the ` +
          'change is finished and its code is gone, set "retired": true on the notice; otherwise ' +
          'correct the count.'
      );
    }
    if (found === 0) continue;
    for (const notice of coveredBy.get(key) ?? []) {
      if (notice.effective !== null && notice.effective > today) {
        failures.push(
          `${notice.id}: covers ${surface} in backend/src/${file} but takes effect ${notice.effectiveOn}; ` +
            'the code may not land before the date its notice gave'
        );
      }
    }
  }

  return failures;
}
