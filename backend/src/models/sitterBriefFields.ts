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
 * A plant's care words, preferring a structured care rule ("we bottom-water
 * this one") over free-text notes. `careRule` is read defensively: it is not
 * on every deployment's Plant row yet, and a brief must work either way.
 */
export function resolveCareNote(plant: { notes?: string | null; careRule?: string | null }): {
  careNote: string | null;
  careNoteSource: 'rule' | 'notes' | null;
} {
  const rule = plant.careRule?.trim();
  if (rule) return { careNote: rule, careNoteSource: 'rule' };
  const notes = plant.notes?.trim();
  if (notes) return { careNote: notes, careNoteSource: 'notes' };
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
