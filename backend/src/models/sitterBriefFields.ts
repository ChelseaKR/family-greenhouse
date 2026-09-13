/**
 * The two pure field resolvers behind the handoff brief (ADR 0015): which of
 * the household's own words to show as the care note, and what the curated
 * pet-toxicity table says about a plant.
 *
 * They live in `models/` rather than in `services/sitterBrief.ts` because the
 * dev server (`local-server.ts`) renders the same two fields and must NOT
 * import anything that reaches `utils/dynamodb.ts` — that module calls
 * `requireEnv('TABLE_NAME')` at import time and throws, taking the whole mock
 * server down before it can answer /health. `sitterBrief` pulls in
 * plantService / spaceService / taskService, so importing these two functions
 * from there dragged the DynamoDB client in with them.
 *
 * They belong here anyway: both are pure functions over a plain plant object
 * and the curated table, with no data access of their own.
 * `services/sitterBrief.ts` re-exports them, so its own callers are unchanged.
 */
import { lookupToxicity, type PetToxicityMatch } from './petToxicity.js';

/**
 * The one field of a plant's care words a sitter link may carry: `careRule`,
 * the short house rule written to be handed to whoever does the task.
 *
 * It used to fall back to `plant.notes` when no rule was set (ADR 0015 (d)),
 * which made the brief return the long-form private note word for word — and
 * the published privacy policy says, in as many words, that a sitter link does
 * not expose plant private notes (#709). A published promise outranks a
 * fallback, so the fallback is gone: no rule means no care note, and the brief
 * renders that absence as an absence exactly as it always has.
 *
 * ADR 0015 kept the fallback only "until [careRule] lands". It has: the House
 * rule field is on the plant form, in `createPlantSchema` / `updatePlantSchema`
 * and on `Plant`. This is that ADR's own exit condition, taken.
 *
 * `careRule` is still read defensively — it is not on every legacy Plant row —
 * and `careNoteSource` still names the field the text came from, so the page
 * attributes it rather than implying the household wrote something it did not.
 */
export function resolveCareNote(plant: { careRule?: string | null }): {
  careNote: string | null;
  careNoteSource: 'rule' | null;
} {
  const rule = plant.careRule?.trim();
  if (rule) return { careNote: rule, careNoteSource: 'rule' };
  return { careNote: null, careNoteSource: null };
}

/**
 * Look the plant up in the curated pet-toxicity table. The species field is
 * tried first (it is the botanical name the table indexes); the display name
 * is a fallback for the many plants recorded as just "Monstera". We return
 * the matched entry's own names as `matchedOn` so the brief can show WHAT it
 * matched — a reader can see for themselves whether the match is right,
 * instead of trusting a verdict attached to a nickname.
 */
export function resolvePetSafety(plant: {
  name: string;
  species?: string | null;
}): (PetToxicityMatch & { matchedOn: string }) | null {
  for (const query of [plant.species, plant.name]) {
    if (!query) continue;
    const [match] = lookupToxicity(query, 1);
    if (match) return { ...match, matchedOn: query };
  }
  return null;
}
