/**
 * Per-household monthly token budget for the Bedrock care assistant — the
 * NUMBERS behind the gate in `persistence.reserveBudget`.
 *
 * The gate itself (reserve an estimate before the model call through a
 * conditional DynamoDB ADD on two counters, reconcile to actual usage when
 * the turn finishes) lives in `persistence.ts` / `index.ts` and is untouched
 * by tiering: this module only decides WHICH cap flows into that condition.
 *
 * The cap is tier-aware in the same shape as `leafHealthBudget` /
 * `identifyBudget`, and like leaf-health the numbers are configuration:
 *
 *   CHAT_BUDGET_INPUT_TOKENS               flat cap, every tier (default 250000)
 *   CHAT_BUDGET_OUTPUT_TOKENS              flat cap, every tier (default 50000)
 *   CHAT_BUDGET_INPUT_TOKENS_SEEDLING      per-tier override
 *   CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING     per-tier override
 *   CHAT_BUDGET_INPUT_TOKENS_GARDEN        per-tier override
 *   CHAT_BUDGET_OUTPUT_TOKENS_GARDEN       per-tier override
 *   CHAT_BUDGET_INPUT_TOKENS_GREENHOUSE    per-tier override
 *   CHAT_BUDGET_OUTPUT_TOKENS_GREENHOUSE   per-tier override
 *
 * A per-tier value that is unset (or unparseable) inherits the flat cap for
 * that counter, so with nothing configured every tier gets 250k / 50k —
 * exactly the pre-tiering behaviour, from the very same `BUDGET_CONFIG`
 * object. Setting any per-tier value makes the guard tier-aware
 * (`tierAware()`); until then `budgetConfigForPlan` / `resolveBudgetConfig`
 * return the flat constant without consulting the plan at all.
 *
 * UNLIKE leaf-health, 0 is NOT "unlimited" here: the flat cap has always read
 * `0` as a zero budget (every reservation fails its condition → 429 on every
 * turn), and the per-tier values keep that meaning for consistency. The
 * Terraform validation refuses "0" for all eight variables; to lift a cap,
 * raise it.
 */
import { PLAN_ORDER, type PlanId } from '../../models/plans.js';
import type { BudgetConfig } from './types.js';

export const DEFAULT_INPUT_TOKENS_PER_MONTH = 250000;
export const DEFAULT_OUTPUT_TOKENS_PER_MONTH = 50000;

// `||` (not `??`) — the Terraform variable defaults to "" to signal "use code
// default", and `??` only treats null/undefined as missing. With `??`, an
// empty-string env var becomes `Number("") = 0` and every chat request 429s.
//
// Built once at cold start (as it always has been) and exported as the one
// flat config object: the handler's `GET /chat/budget` and the turn's
// remaining-budget arithmetic read the same numbers the gate enforces.
export const BUDGET_CONFIG: BudgetConfig = {
  maxInputTokensPerMonth: Number(
    process.env.CHAT_BUDGET_INPUT_TOKENS || String(DEFAULT_INPUT_TOKENS_PER_MONTH)
  ),
  maxOutputTokensPerMonth: Number(
    process.env.CHAT_BUDGET_OUTPUT_TOKENS || String(DEFAULT_OUTPUT_TOKENS_PER_MONTH)
  ),
};

/**
 * Environment variables carrying each tier's overrides, one per counter.
 * Exported so the tests and the Terraform wiring can be checked against one
 * source of names.
 */
export const CHAT_BUDGET_ENV: Readonly<Record<PlanId, { input: string; output: string }>> = {
  seedling: {
    input: 'CHAT_BUDGET_INPUT_TOKENS_SEEDLING',
    output: 'CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING',
  },
  garden: {
    input: 'CHAT_BUDGET_INPUT_TOKENS_GARDEN',
    output: 'CHAT_BUDGET_OUTPUT_TOKENS_GARDEN',
  },
  greenhouse: {
    input: 'CHAT_BUDGET_INPUT_TOKENS_GREENHOUSE',
    output: 'CHAT_BUDGET_OUTPUT_TOKENS_GREENHOUSE',
  },
};

/**
 * `undefined` when the variable is unset, empty, or unparseable — the caller
 * picks the fallback. Any finite number comes back as-is, INCLUDING 0, which
 * is a zero budget (see module docs), not "unlimited". Terraform passes "" for
 * "use the default", which is why the empty string counts as unset.
 */
function parseTokens(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Monthly budget for one tier: its own overrides where set, else the flat
 * cap, counter by counter. Same name as identifyBudget / leafHealthBudget's
 * `allowanceForPlan` so the three guards read the same way.
 */
export function allowanceForPlan(planId: PlanId): BudgetConfig {
  const env = CHAT_BUDGET_ENV[planId];
  return {
    maxInputTokensPerMonth:
      parseTokens(process.env[env.input]) ?? BUDGET_CONFIG.maxInputTokensPerMonth,
    maxOutputTokensPerMonth:
      parseTokens(process.env[env.output]) ?? BUDGET_CONFIG.maxOutputTokensPerMonth,
  };
}

/** Every tier's resolved budget. For observability and tests; not on the hot path. */
export function allowances(): Record<PlanId, BudgetConfig> {
  return {
    seedling: allowanceForPlan('seedling'),
    garden: allowanceForPlan('garden'),
    greenhouse: allowanceForPlan('greenhouse'),
  };
}

/**
 * True once at least one per-tier override (either counter, any tier) is
 * configured. Until then every tier resolves to the flat `BUDGET_CONFIG`
 * and callers skip the plan lookup entirely, so a deploy that adds these
 * variables (all blank) changes nothing — not the cap, and not the number of
 * DynamoDB reads per turn or per budget read.
 */
export function tierAware(): boolean {
  return PLAN_ORDER.some(
    (id) =>
      parseTokens(process.env[CHAT_BUDGET_ENV[id].input]) !== undefined ||
      parseTokens(process.env[CHAT_BUDGET_ENV[id].output]) !== undefined
  );
}

/**
 * The budget to enforce for a household whose plan is already known — the
 * turn has it in hand from the Garden-and-up gate, so tiering costs the turn
 * no extra read. Returns the very same `BUDGET_CONFIG` object until a
 * per-tier value exists.
 */
export function budgetConfigForPlan(planId: PlanId): BudgetConfig {
  if (!tierAware()) return BUDGET_CONFIG;
  return allowanceForPlan(planId);
}

/**
 * The budget to report/enforce for a household whose plan is NOT yet known.
 * `lookupPlanId` is only invoked when per-tier caps are configured; its
 * failure propagates, because a cap we could not determine is not one we
 * should report or spend against (the handler maps it to a 503, the same
 * fail-closed shape as leafHealthBudget.resolveMonthlyCap).
 */
export async function resolveBudgetConfig(
  lookupPlanId: () => Promise<PlanId>
): Promise<BudgetConfig> {
  if (!tierAware()) return BUDGET_CONFIG;
  return allowanceForPlan(await lookupPlanId());
}
