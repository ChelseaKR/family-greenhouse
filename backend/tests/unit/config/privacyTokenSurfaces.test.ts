import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CARETAKER_PERMISSIONS,
  MAX_CARETAKER_DAYS,
} from '../../../src/services/caretakerService.js';

/**
 * The privacy policy now describes the two account-free surfaces it used to
 * leave out: the wall display and caretaker seats.
 *
 * It had a section for sitter links and nothing at all for the other two ways
 * household data reaches someone with no account — even though a caretaker
 * seat collects a THIRD PARTY'S NAME (typed by the household, kept on every
 * visit record) and a wall display link never expires. A privacy policy that
 * enumerates what is collected and who can see it is only true while the
 * enumeration is complete, so the gap was a false claim by omission.
 *
 * Everything the new sentences assert that the code can settle is pinned
 * here, in both locales, because the sentences contain hand-typed facts —
 * "at most 180 days", "complete tasks, add a note, and add a photo", "It does
 * not expire" — and a hand-typed fact with nothing re-deriving it is true only
 * on the day it was written. Each assertion fails in both directions: the
 * number moving in the code fails, and the sentence being reworded away from
 * the number fails too.
 *
 * Not re-tested here, because it is already gated where it belongs:
 * `tests/integration/kiosk-display.test.ts` pins the kiosk payload's exact key
 * set (no member identity, no notes, no location), and
 * `tests/integration/sitter-privacy.test.ts` does the same for the sitter
 * brief the section above it describes.
 */

const ROOT = new URL('../../../../', import.meta.url);

const privacy = (tag: 'en' | 'es') =>
  (
    JSON.parse(
      readFileSync(new URL(`frontend/src/i18n/locales/${tag}/legal.json`, ROOT), 'utf8')
    ) as {
      legal: { privacy: { collect: Record<string, string>; otherLinks: Record<string, string> } };
    }
  ).legal.privacy;

const kioskSource = readFileSync(new URL('backend/src/services/kioskService.ts', ROOT), 'utf8');

const LOCALES = ['en', 'es'] as const;

describe('privacy policy: caretaker seats', () => {
  it.each(LOCALES)('states the real seat ceiling in %s', (tag) => {
    const { collect, otherLinks } = privacy(tag);
    for (const [key, text] of [
      ['collect.caretaker', collect.caretaker],
      ['otherLinks.body', otherLinks.body],
    ] as const) {
      const days = [...text.matchAll(/(\d+)\s*(?:days|días)/gu)].map((m) => Number(m[1]));
      expect(days, `${tag} legal.privacy.${key} should state the seat ceiling in days`).toContain(
        MAX_CARETAKER_DAYS
      );
      // Both directions: any OTHER day figure in the same sentence would be a
      // second, unpinned claim about how long a seat can run.
      expect(new Set(days), `${tag} legal.privacy.${key} states an unpinned day figure`).toEqual(
        new Set([MAX_CARETAKER_DAYS])
      );
    }
  });

  it('enumerates exactly the permissions a seat actually has', () => {
    // The sentence names three things a caretaker can do. If a fourth
    // permission is ever added, the policy under-discloses and this fails.
    expect(CARETAKER_PERMISSIONS).toEqual(['task.complete', 'photo.add', 'note.add']);

    const phrases: Record<(typeof CARETAKER_PERMISSIONS)[number], Record<'en' | 'es', RegExp>> = {
      'task.complete': { en: /complete tasks/u, es: /completar tareas/u },
      'photo.add': { en: /add a photo/u, es: /añadir una foto/u },
      'note.add': { en: /add a note/u, es: /añadir una nota/u },
    };
    for (const tag of LOCALES) {
      const { body } = privacy(tag).otherLinks;
      for (const permission of CARETAKER_PERMISSIONS) {
        expect(body, `${tag} otherLinks.body should describe ${permission}`).toMatch(
          phrases[permission][tag]
        );
      }
    }
  });

  it('does not promise the name is dropped when the seat expires', () => {
    // The seat row is swept a few days after its window; the VISIT records that
    // carry the same name are not. The policy says exactly that, so it must not
    // also be read as "the name goes away".
    for (const tag of LOCALES) {
      const text = privacy(tag).collect.caretaker;
      expect(text).toMatch(tag === 'en' ? /visit records/u : /registros de visita/u);
    }
  });
});

describe('privacy policy: who can issue and revoke these links', () => {
  it('says an admin does, and both handlers still require one', () => {
    // Caught while reviewing this change: the first draft of the section said
    // "any member can turn it off", which is what a SITTER link allows. Both
    // of the surfaces this section is about are admin-only on every route —
    // issue, list and revoke — so the draft published exactly the kind of
    // claim the section was written to fix.
    // Bounded to the revoke handler's OWN declaration — from `export const
    // revokeX` to the next `export const` — because a slice that runs to the
    // end of the file picks up some later handler's `requireAdmin()` and
    // passes with the guard deleted. A negative control caught exactly that:
    // removing the real guard left this test green until it was bounded.
    for (const [file, handler] of [
      ['backend/src/handlers/households/kioskLink.ts', 'revokeKioskLink'],
      ['backend/src/handlers/caretakers/management.ts', 'revokeCaretaker'],
    ] as const) {
      const source = readFileSync(new URL(file, ROOT), 'utf8');
      const start = source.indexOf(`export const ${handler} =`);
      expect(start, `${handler} was renamed; re-point this check`).toBeGreaterThan(-1);
      const rest = source.slice(start + 1);
      const end = rest.indexOf('\nexport const ');
      const declaration = end === -1 ? rest : rest.slice(0, end);
      expect(declaration, `${file}: ${handler} no longer requires an admin`).toMatch(
        /requireAdmin\(\)/u
      );
    }

    for (const tag of LOCALES) {
      const { body } = privacy(tag).otherLinks;
      expect(body).toMatch(tag === 'en' ? /admin/iu : /administradora/iu);
      expect(body, 'must not imply any member can revoke these').not.toMatch(
        tag === 'en' ? /any member can turn it off/iu : /cualquier miembro puede desactivarlo/iu
      );
    }
  });
});

describe('privacy policy: the wall display', () => {
  it('says the link does not expire, and the code still gives it no expiry', () => {
    // `kioskService` writes its row with no `ttl` and no `expiresAt`, on
    // purpose (see its header). The published sentence depends on that, so a
    // future expiry has to come back through this test.
    // Anchor asserted BEFORE it is used. `indexOf` returns -1 for a function
    // that has been renamed, and `slice(-1)` is the last character of the
    // file — on which both assertions below pass while checking nothing. A
    // negative control caught exactly that here.
    const anchor = kioskSource.indexOf('export async function issueKioskLink');
    expect(
      anchor,
      'issueKioskLink was renamed; re-point this check at the row it writes'
    ).toBeGreaterThan(-1);

    const createBlock = kioskSource.slice(anchor);
    expect(createBlock).not.toMatch(/^\s*ttl:/mu);
    expect(createBlock).not.toMatch(/^\s*expiresAt:/mu);

    for (const tag of LOCALES) {
      const { body } = privacy(tag).otherLinks;
      expect(body).toMatch(tag === 'en' ? /does not expire/u : /No caduca/u);
    }
  });
});
