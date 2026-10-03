/**
 * Plant names as they read mid-sentence. Kept apart from careToxicity.ts so
 * pages that only need the wording (the sitter brief, the plant passport) do
 * not pull the toxicity table into their chunk.
 */

/**
 * A common name as it reads mid-sentence: "pothos", "ZZ plant", "English
 * ivy". `toLowerCase()` alone gave headings like "how often to water a zz
 * plant" and "a english ivy".
 */
export function sentenceName(commonName: string): string {
  const KEEP_CASE = new Set(['English', 'Chinese', 'Boston', 'Christmas']);
  return commonName
    .split(' ')
    .map((w) => (KEEP_CASE.has(w) || /^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

/** "a pothos", "an aloe vera", "a ZZ plant", "an English ivy". */
export function nameInSentence(commonName: string): string {
  const name = sentenceName(commonName);
  return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
}

/** The same name opening a sentence: "ZZ plant", "Pothos". */
export function sentenceStartName(commonName: string): string {
  const name = sentenceName(commonName);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * ASPCA Animal Poison Control Center, as printed on
 * https://www.aspca.org/pet-care/animal-poison-control (checked 2026-10-02:
 * "(888) 426-4435"). A consultation fee may apply; that is ASPCA's to state.
 */
export const ASPCA_POISON_CONTROL_PHONE = '888-426-4435';
