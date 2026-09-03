/**
 * Locales whose legal translations have had both native-speaker and legal
 * review. Every locale renders its own catalog text (a Spanish reader is
 * never handed English Terms), but a locale outside this set gets a notice
 * above the text saying the translation is a draft. Non-English locales also
 * always carry the governing-language line: if the translation and the
 * English text differ, the English text governs.
 *
 * Add a locale here only once both reviews have signed off — see the
 * "Locales and shipping" section of docs/i18n.md. Lives apart from
 * LegalShell so the component module exports only components (react-refresh).
 */
export const REVIEWED_LEGAL_LOCALES: ReadonlySet<string> = new Set(['en']);
