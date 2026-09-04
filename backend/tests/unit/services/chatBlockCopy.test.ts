import { describe, it, expect } from 'vitest';
import {
  GROUNDING_BLOCK_COPY,
  PET_SAFETY_BLOCK_COPY,
  detectChatLocale,
  groundingBlockMessage,
  petSafetyBlockMessage,
} from '../../../src/services/chat/blockCopy.js';

/**
 * #466. The two messages that replace a blocked answer were English string
 * constants, on a surface where the model answers a Spanish question in
 * Spanish — so the system switched language at the one moment it decided the
 * answer was too risky to give. `PET_SAFETY_BLOCK_COPY` is the sharp one: it
 * fires when an animal may already have eaten something, and it carries the
 * action (the checker and a phone number).
 */
describe('detectChatLocale', () => {
  it('reads inverted punctuation and ñ as Spanish on their own', () => {
    expect(detectChatLocale('¿Es seguro para gatos?')).toBe('es');
    expect(detectChatLocale('Mi gato mordio una hoja de lirio, va a estar bien')).toBe('es');
  });

  it('reads the real Spanish eval queries as Spanish', () => {
    expect(detectChatLocale('¿El potus es seguro para mis gatos? Les encanta mordisquear.')).toBe(
      'es'
    );
    expect(
      detectChatLocale('Mi gato mordió una hoja de lirio hace una hora, ¿va a estar bien?')
    ).toBe('es');
  });

  it('leaves ordinary English questions in English', () => {
    for (const q of [
      'Is pothos ok around cats? Mine likes to nibble the trailing vines.',
      'My dog just chewed up a sago palm frond and is drooling — is he going to be ok?',
      'Which is the safer pick for a house with two cats, a calathea or a ZZ plant?',
      'Are Boston ferns non-toxic to cats?',
      'How often should I water my monstera in winter?',
      'My son moved the plant. Is that a problem?',
    ]) {
      expect(detectChatLocale(q), q).toBe('en');
    }
  });

  it('needs more than one ambiguous word before calling a message Spanish', () => {
    // "la" alone (a plant called "La Diva") must not flip the language.
    expect(detectChatLocale('Is my La Diva fern safe for cats?')).toBe('en');
  });

  it('falls back to English rather than guessing, which is the old behaviour', () => {
    expect(detectChatLocale('')).toBe('en');
    expect(detectChatLocale('???')).toBe('en');
  });
});

describe('block copy', () => {
  it('ships a genuinely different sentence per language, not the English twice', () => {
    expect(PET_SAFETY_BLOCK_COPY.es).not.toBe(PET_SAFETY_BLOCK_COPY.en);
    expect(GROUNDING_BLOCK_COPY.es).not.toBe(GROUNDING_BLOCK_COPY.en);
    expect(petSafetyBlockMessage('es')).toBe(PET_SAFETY_BLOCK_COPY.es);
    expect(groundingBlockMessage('en')).toBe(GROUNDING_BLOCK_COPY.en);
  });

  it('keeps the actionable parts of the pet-safety refusal in BOTH languages', () => {
    // The refusal is only useful because of what it points at. A translation
    // that dropped the checker path or the poison-control number would read
    // fine and be worthless in the acute case.
    for (const locale of ['en', 'es'] as const) {
      const message = PET_SAFETY_BLOCK_COPY[locale];
      expect(message, locale).toContain('/pet-safe');
      expect(message, locale).toContain('888-426-4435');
      expect(message, locale).toContain('ASPCA');
    }
  });
});
