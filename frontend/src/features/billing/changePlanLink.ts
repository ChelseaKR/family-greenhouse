/**
 * Where an upgrade prompt sends an admin: the "Change plan" card on Settings →
 * Plan status, not the top of that page.
 *
 * Every "Keep Garden", "Change plan" and "See plans" link used to open
 * `/settings/billing` at the top, where the plan choice sat below the usage
 * meters, the identification pack and the gift card. On a phone that was
 * several screens of scrolling past things the person had not come for. The
 * page now renders the card right under Plan status and scrolls to it when
 * the fragment is present (`BillingSettings`).
 *
 * Kept in its own module so the prompts that link here do not pull the
 * billing page into their bundle.
 */
export const CHANGE_PLAN_ID = 'change-plan';
export const CHANGE_PLAN_ROUTE = `/settings/billing#${CHANGE_PLAN_ID}`;
