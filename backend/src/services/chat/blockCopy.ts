/**
 * The two messages that replace a blocked AI answer, in every language the
 * product ships.
 *
 * ## Why this file exists
 *
 * Both messages were hardcoded English string constants. `SYSTEM_PROMPT`
 * contains no language instruction, so the model answers a Spanish question in
 * Spanish — and then the guard replaced that answer with English. A Spanish
 * speaker had a Spanish conversation right up to the one moment the system
 * decided the answer was too risky to give, and at that moment it switched
 * language.
 *
 * `PET_SAFETY_BLOCK_MESSAGE` is the sharp case. It is the product's
 * highest-consequence sentence, ADR 0011 exists for it, and it fires precisely
 * when someone may be asking because an animal has already eaten something. It
 * carries the action — the `/pet-safe` checker and a phone number. Delivering
 * that in a language the reader may not read is the failure the guard was built
 * to prevent, arriving one layer later.
 *
 * The detector at `groundingGuard.ts` was already bilingual (accent folding,
 * Spanish safety phrasing). The work stopped one line short of the reply.
 *
 * ## Where the language comes from, and why
 *
 * From the user's message for THIS turn, not from a stored preference.
 *
 * Three options were available: the stored `emailLocale` preference, an
 * `Accept-Language` header (the chat routes send none), or the language of the
 * question. The question wins here for three reasons:
 *
 *   1. This string REPLACES an answer the model was about to write in the
 *      language of the question. Matching the question is what keeps the turn
 *      coherent; matching a stored preference could still switch languages
 *      mid-conversation for a bilingual user who set the preference to English
 *      and then asked in Spanish — the exact defect, with a different cause.
 *   2. `emailLocale` is named, and exposed in Settings, as an EMAIL setting.
 *      Reusing it to decide what language a chat reply is in makes a
 *      preference mean something the user was never told it meant.
 *   3. It costs nothing. A preference read is a DynamoDB point read on a path
 *      that has just failed a safety check; this is pure string work.
 *
 * The trade-off, stated plainly: detection is a heuristic and can be wrong.
 * It is deliberately conservative — a short English question can never be
 * misread as Spanish, because English is the default and Spanish requires
 * positive evidence. A Spanish question written entirely without accents,
 * inverted punctuation or common Spanish function words would fall back to
 * English, which is the same behaviour as before this file existed.
 */

export type ChatLocale = 'en' | 'es';

export const DEFAULT_CHAT_LOCALE: ChatLocale = 'en';

/**
 * Replaces an answer whose quantitative claims could not be checked against
 * retrieved care knowledge (ADR 0009).
 */
export const GROUNDING_BLOCK_COPY: Record<ChatLocale, string> = {
  en: "I couldn't verify every quantitative detail in that answer against the care knowledge I retrieved. Please rephrase the question or check a trusted horticultural source before acting.",
  es: 'No pude verificar todos los datos numéricos de esa respuesta con la información de cuidados que consulté. Reformula la pregunta o consulta una fuente hortícola de confianza antes de actuar.',
};

/**
 * Replaces an answer that asserted a plant is safe for pets without a
 * non-toxic verdict from the curated table behind it (ADR 0011). A
 * refusal-with-pointer rather than a bare refusal: the verified checker is
 * one click away, and the acute case needs a phone number, not a chat.
 *
 * The ASPCA number is US-only. That is a scoping decision inherited from the
 * English original, not a translation choice — a reader outside the US gets a
 * number they cannot call, in either language. Worth revisiting when the
 * product has non-US users; not something to change silently here.
 */
export const PET_SAFETY_BLOCK_COPY: Record<ChatLocale, string> = {
  en: "I can't confirm that plant is safe for pets: this answer didn't come from our verified pet-toxicity table, so I've held it back. Please use the pet-safety checker at /pet-safe (grounded in the ASPCA toxic and non-toxic plant list) or ask your vet. If an animal has already eaten or chewed a plant, or is showing symptoms, contact your vet or the ASPCA Animal Poison Control Center (888-426-4435) right away.",
  es: 'No puedo confirmar que esa planta sea segura para las mascotas: esta respuesta no salió de nuestra tabla verificada de toxicidad, así que la he retenido. Usa el verificador de seguridad para mascotas en /pet-safe (basado en la lista de plantas tóxicas y no tóxicas de la ASPCA) o consulta a tu veterinario. Si un animal ya se comió o mordió una planta, o presenta síntomas, contacta a tu veterinario o al Centro de Control de Envenenamiento Animal de la ASPCA (888-426-4435) ahora mismo.',
};

/**
 * Replaces an answer that counted the user's own collection, or spoke for all
 * of it, when only part of it reached the answering service (#549, ADR 0026).
 *
 * A refusal-with-pointer, like the pet-safety message and for the same reason:
 * the complete count exists and is one tap away, in the plant list the user
 * already has. It also names the one thing that puts a plant back into these
 * answers — matching it to a species — because the larger of the two
 * reductions is the canonical-species privacy filter, not the cap.
 *
 * Neither reduction is quantified in the copy. The numbers differ per turn and
 * live in the `coverage` block persisted beside this message; a static string
 * that guessed at them would be the same defect one layer out.
 */
export const HOUSEHOLD_COVERAGE_BLOCK_COPY: Record<ChatLocale, string> = {
  en: "I can't give you that number for your collection: only part of it reached this answer, so any total would have been counted from a subset without saying so. Your plant list has the complete count. I can only include a plant here once it's been matched to a species, so identifying the ones that haven't been is what brings them into answers like this.",
  es: 'No puedo darte ese número sobre tu colección: solo una parte llegó a esta respuesta, así que cualquier total se habría contado sobre un subconjunto sin decirlo. Tu lista de plantas tiene el recuento completo. Aquí solo puedo incluir una planta cuando está asociada a una especie, así que identificar las que faltan es lo que las incorpora a respuestas como esta.',
};

/** Accent-fold and lowercase, so the word list below stays ASCII. */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Punctuation and letters that appear in Spanish and effectively never in
 * English. One of these is enough on its own.
 */
const SPANISH_MARKS = /[¿¡ñ]/i;

/**
 * Spanish function and domain words, folded. Chosen to have no English
 * homograph — `son`, `como`, `casa` and `no` are deliberately absent because
 * they appear in ordinary English sentences and would produce false Spanish.
 */
const SPANISH_WORDS =
  /\b(el|la|los|las|un|una|unos|unas|mi|mis|tu|tus|sus|es|esta|estan|que|para|por|con|pero|muy|donde|cuando|tengo|puedo|quiero|debo|planta|plantas|maceta|hoja|hojas|gato|gatos|gata|perro|perros|perra|mascota|mascotas|seguro|segura|seguros|seguras|toxico|toxica|toxicos|toxicas|venenosa|venenoso|comio|mordio|regar|riego|veterinario|jardin|semana|dias)\b/g;

/**
 * How many distinct Spanish function words a message needs before we call it
 * Spanish. Two, not one: a single "la" or "es" can appear in an English
 * message about a plant with a Spanish name.
 */
const SPANISH_WORD_THRESHOLD = 2;

/**
 * The language to answer this turn in. English unless there is positive
 * evidence of Spanish, so a misdetection can only ever reproduce the old
 * behaviour, never introduce a new one.
 */
export function detectChatLocale(message: string): ChatLocale {
  if (SPANISH_MARKS.test(message)) return 'es';
  const folded = fold(message);
  const hits = new Set(folded.match(SPANISH_WORDS) ?? []);
  return hits.size >= SPANISH_WORD_THRESHOLD ? 'es' : DEFAULT_CHAT_LOCALE;
}

export function groundingBlockMessage(locale: ChatLocale): string {
  return GROUNDING_BLOCK_COPY[locale];
}

export function petSafetyBlockMessage(locale: ChatLocale): string {
  return PET_SAFETY_BLOCK_COPY[locale];
}

export function householdCoverageBlockMessage(locale: ChatLocale): string {
  return HOUSEHOLD_COVERAGE_BLOCK_COPY[locale];
}
