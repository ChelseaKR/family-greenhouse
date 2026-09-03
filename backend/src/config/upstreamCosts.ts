/**
 * Per-call prices of the metered upstream providers — for COST ACCOUNTING ONLY.
 *
 * Nothing in this module gates a request. Allowances and caps live in
 * `services/identifyBudget.ts`, `services/leafHealthBudget.ts` and
 * `services/chat/index.ts`. This exists so the `costUsd` a paid call logs is
 * derived from a number that is written down, dated, and overridable per
 * environment — the same shape as `BEDROCK_INPUT_USD_PER_MTOK` /
 * `BEDROCK_OUTPUT_USD_PER_MTOK` in `services/chat/bedrock.ts`, which carry the
 * Bedrock side of the same ledger.
 *
 * Plant.id (kindwise.com) is prepaid, pay-as-you-go credits — not a
 * subscription. "The cost of each identification call is one credit." At our
 * volume that is Tier A: €0.05 per credit, 1,000-credit (€50) minimum. Prices
 * are EUR only, so the USD figure carries an exchange-rate assumption:
 *
 *   €0.05 × 1.17 USD/EUR = $0.0585 per identification
 *
 * 1.17 is deliberately ~1% above the ECB reference rate of 2026-09-01
 * (1.1590), to absorb the card-conversion spread on a EUR invoice paid in USD,
 * so the accounted cost stays a ceiling rather than a list price. Sources, the
 * credit rules, and the per-plan arithmetic are in
 * `docs/adr/0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md` and
 * `evals/UNIT-ECONOMICS.md`. Re-derive when the tier or the rate moves — the
 * env override exists for exactly that.
 */

/** Tier A list price in EUR per credit, from kindwise.com/pricing on 2026-09-02. */
export const PLANT_ID_EUR_PER_CREDIT_LIST = 0.05;

/** USD per EUR assumed when converting the list price. Dated and justified above. */
export const PLANT_ID_USD_PER_EUR_ASSUMED = 1.17;

/**
 * What the env override falls back to: list price × assumed rate, written as a
 * literal so a logged `costUsd` is `0.0585` and not `0.058500000000000004`.
 * A unit test holds it to the product so neither input can drift alone.
 */
export const PLANT_ID_USD_PER_CREDIT_DEFAULT = 0.0585;

/** One identification call consumes one credit (kindwise.com pricing page and FAQ). */
export const PLANT_ID_CREDITS_PER_IDENTIFICATION = 1;

/**
 * Parse an env override for a per-unit cost. Anything that is not a finite,
 * non-negative number falls back to the default: a NaN here would poison every
 * logged `costUsd`, which is the one place this number is read.
 */
export function parseUsdPerUnit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * USD accounted per Plant.id credit. Override with `PLANT_ID_USD_PER_CREDIT`.
 * The variable is read here but is NOT yet plumbed through Terraform — until a
 * `plant_id_usd_per_credit` variable is added beside the Bedrock ones in
 * `infrastructure/modules/api`, the default is what runs in every environment.
 */
export const PLANT_ID_USD_PER_CREDIT = parseUsdPerUnit(
  process.env.PLANT_ID_USD_PER_CREDIT,
  PLANT_ID_USD_PER_CREDIT_DEFAULT
);
