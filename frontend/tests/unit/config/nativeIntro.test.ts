import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import en from '@/i18n/locales/en/translation.json';
import es from '@/i18n/locales/es/translation.json';
import {
  INTRO_LAST_PAGE,
  INTRO_STORY_PAGES,
  NATIVE_INTRO_METHODS,
  NATIVE_INTRO_PLUGIN,
  introChoice,
  introRequest,
  type NativeIntroRequest,
} from '@/config/nativeIntro';

/**
 * The iOS app's signed-out intro (ADR 0035): the words the web sends Swift,
 * in both languages, what it accepts back, and the field names both sides
 * must agree on. Swift is not compiled in CI, so, as for the native frame
 * and the form sheet, its source is read and held to the web's shapes here.
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const model = read('ios/App/App/NativeIntroModel.swift');
const view = read('ios/App/App/NativeIntroView.swift');
const plugin = read('ios/App/App/NativeIntroPlugin.swift');
const main = read('ios/App/App/MainViewController.swift');
const project = read('ios/App/App.xcodeproj/project.pbxproj');

const t = i18n.t.bind(i18n);

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('the intro the web sends, in English', () => {
  const request = introRequest(t, { start: 'story', offerCreate: true });

  it('tells the story in three pages, then opens the two doors', () => {
    expect(request.pages.map((p) => p.id)).toEqual(['household', 'claim', 'away', 'start']);
    expect(request.pages).toEqual([
      {
        id: 'household',
        title: 'One plant list for the whole house',
        body: 'Everyone in your household sees the same plants, rooms, and care schedules.',
      },
      {
        id: 'claim',
        title: 'Claim it, and nobody waters twice',
        body: 'A task nobody has picked up is up for grabs. Claim it, and the rest of the house can see it’s handled.',
      },
      {
        id: 'away',
        title: 'Going away? Hand the plants over',
        body: 'Send a plant sitter a link that works without an account and stops working on the date you choose.',
      },
      {
        id: 'start',
        title: 'Start with your household',
        body: 'Create an account to set up your household, or sign in to the one you already share.',
      },
    ]);
    expect(request).toMatchObject({
      start: 'story',
      skip: 'Skip',
      next: 'Next',
      pagePosition: 'Page {n} of {total}',
      appName: 'Family Greenhouse',
      tagline: 'Grow together',
      create: 'Create account',
      signIn: 'I already have an account',
    });
  });

  it('uses the sign-up screen’s own button words for Create account', () => {
    expect(request.create).toBe(t('auth.createAccount'));
  });

  it('after the story, opens on the last page with the same words', () => {
    const final = introRequest(t, { start: 'final', offerCreate: true });
    expect(final.start).toBe('final');
    expect(final.pages.at(-1)?.id).toBe(INTRO_LAST_PAGE);
    expect(final.signIn).toBe(request.signIn);
  });

  it('offers only the sign-in door while registration is paused', () => {
    const paused = introRequest(t, { start: 'story', offerCreate: false });
    expect(paused).not.toHaveProperty('create');
    expect(paused.signIn).toBe('I already have an account');
  });
});

describe('the intro the web sends, in Spanish', () => {
  it('is Spanish on every page and button', async () => {
    await ensureLanguageCatalog('es');
    await i18n.changeLanguage('es');
    const request = introRequest(t, { start: 'story', offerCreate: true });
    expect(request.pages.map((p) => [p.title, p.body])).toEqual([
      [
        'Una lista de plantas para toda la casa',
        'Todas las personas de tu hogar ven las mismas plantas, habitaciones y calendarios de cuidado.',
      ],
      [
        'Tómala y nadie riega dos veces',
        'Una tarea que nadie ha tomado queda libre. Tómala y el resto de la casa verá que alguien se encarga.',
      ],
      [
        '¿Te vas unos días? Deja las plantas en buenas manos',
        'Envía a quien cuide tus plantas un enlace que funciona sin cuenta y deja de funcionar en la fecha que elijas.',
      ],
      [
        'Empieza con tu hogar',
        'Crea una cuenta para preparar tu hogar o inicia sesión en el que ya compartes.',
      ],
    ]);
    expect(request).toMatchObject({
      skip: 'Omitir',
      next: 'Siguiente',
      pagePosition: 'Página {n} de {total}',
      appName: 'Family Greenhouse',
      tagline: 'Crecer juntos',
      create: 'Crear una cuenta',
      signIn: 'Ya tengo una cuenta',
    });
  });
});

describe('the catalogs carry the intro in both languages', () => {
  type Tree = { [key: string]: string | Tree };
  const flatten = (tree: Tree, prefix = ''): Record<string, string> =>
    Object.entries(tree).reduce<Record<string, string>>((out, [key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof value === 'string'
        ? { ...out, [path]: value }
        : { ...out, ...flatten(value, path) };
    }, {});
  const enIntro = flatten((en as unknown as { auth: { intro: Tree } }).auth.intro);
  const esIntro = flatten((es as unknown as { auth: { intro: Tree } }).auth.intro);

  it('has the same keys in en and es', () => {
    expect(Object.keys(esIntro).sort()).toEqual(Object.keys(enIntro).sort());
    expect(Object.keys(enIntro).length).toBe(12);
  });

  it('is translated, not copied, in es', () => {
    for (const key of Object.keys(enIntro)) {
      expect(esIntro[key], `auth.intro.${key}`).not.toBe(enIntro[key]);
    }
  });

  it('has a title and a body for every page the web sends', () => {
    for (const id of [...INTRO_STORY_PAGES, INTRO_LAST_PAGE]) {
      expect(enIntro[`${id}.title`], id).toBeTruthy();
      expect(enIntro[`${id}.body`], id).toBeTruthy();
    }
  });

  it('keeps the page position placeholders Swift fills in, in both languages', () => {
    for (const words of [enIntro.pagePosition, esIntro.pagePosition]) {
      expect(words).toContain('{n}');
      expect(words).toContain('{total}');
    }
  });

  // App Review (Guideline 3.1.1): the app's first screen says nothing about
  // plans, prices, gifts, trials or buying. Every word the intro can show, in
  // both languages, including the reused button and tagline.
  it('says nothing about plans, prices, gifts, trials or purchases', async () => {
    const words: string[] = [];
    await ensureLanguageCatalog('es');
    for (const lng of ['en', 'es']) {
      await i18n.changeLanguage(lng);
      for (const offerCreate of [true, false]) {
        const r = introRequest(t, { start: 'story', offerCreate });
        words.push(
          ...r.pages.flatMap((p) => [p.title, p.body]),
          r.skip,
          r.next,
          r.pagePosition,
          r.appName,
          r.tagline,
          r.signIn,
          r.create ?? ''
        );
      }
    }
    const forbidden =
      /\b(plans?|pric\w*|free|gratis|gift\w*|regal\w*|trial|prueba|purchas\w*|buy\w*|compr\w*|subscri\w*|suscri\w*|pay\w*|pag[oa]\w*|seedling|garden|greenhouse plan)\b/i;
    for (const w of words) {
      expect(w, w).not.toMatch(forbidden);
      expect(w, w).not.toMatch(/[$€]\s*\d/);
    }
  });
});

describe('what the web accepts back', () => {
  const offered = { create: 'Create account' } as Pick<NativeIntroRequest, 'create'>;
  const notOffered = {} as Pick<NativeIntroRequest, 'create'>;

  it('accepts the two doors', () => {
    expect(introChoice({ choice: 'create' }, offered)).toBe('create');
    expect(introChoice({ choice: 'signIn' }, offered)).toBe('signIn');
    expect(introChoice({ choice: 'signIn' }, notOffered)).toBe('signIn');
  });

  it('refuses Create when it was not offered, and anything that is not a door', () => {
    expect(introChoice({ choice: 'create' }, notOffered)).toBeNull();
    for (const answer of [
      { choice: null },
      {},
      null,
      undefined,
      { choice: 'skip' },
      { choice: 'CREATE' },
      { choice: 1 },
      'create',
    ]) {
      expect(introChoice(answer, offered), JSON.stringify(answer)).toBeNull();
    }
  });
});

describe('Swift reads what the web sends', () => {
  it('registers the plugin under the name and methods the web checks for', () => {
    expect(plugin).toContain(`jsName = "${NATIVE_INTRO_PLUGIN}"`);
    for (const method of NATIVE_INTRO_METHODS) {
      expect(plugin).toContain(`CAPPluginMethod(name: "${method}"`);
      expect(plugin).toMatch(new RegExp(`@objc func ${method}\\(`));
    }
    expect(main).toContain('registerPluginInstance(NativeIntroPlugin())');
  });

  it('builds the three Swift files into the app', () => {
    for (const file of [
      'NativeIntroModel.swift',
      'NativeIntroView.swift',
      'NativeIntroPlugin.swift',
    ]) {
      expect(project).toContain(`/* ${file} in Sources */,`);
    }
  });

  it('parses every field of the request by its web name', () => {
    const request = introRequest(t, { start: 'story', offerCreate: true });
    const fields = Object.keys({ ...request, token: '' }).filter((f) => f !== 'token');
    for (const field of fields) {
      expect(model, field).toContain(`"${field}"`);
    }
    expect(plugin).toContain('call.getString("token")');
    for (const pageField of ['id', 'title', 'body'])
      expect(model).toContain(`page["${pageField}"]`);
    expect(model).toContain('case story');
    expect(model).toContain('case final');
  });

  it('answers the two choices by the names the web accepts', () => {
    expect(model).toMatch(/enum IntroChoice: String \{\s*case create\s*case signIn\s*\}/);
    expect(plugin).toContain('call.resolve(["choice": choice?.rawValue ?? NSNull()])');
  });

  it('draws a picture for every page id the web sends', () => {
    for (const id of [...INTRO_STORY_PAGES, INTRO_LAST_PAGE]) {
      expect(view).toContain(`case "${id}":`);
    }
  });

  it('carries no words of its own: every string on screen comes from the web', () => {
    // Text and Button take the request's strings; the only literals in the
    // view are SF Symbol names, page ids and accessibility identifiers.
    const literals = [...view.matchAll(/(?:Text|Button)\(\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(literals).toEqual([]);
  });

  it('honors Reduce Motion, Dynamic Type and VoiceOver in the view', () => {
    expect(view).toContain('accessibilityReduceMotion');
    expect(view).toContain('dynamicTypeSize');
    expect(view).toContain('accessibilityAdjustableAction');
    expect(view).toContain('.accessibilityAddTraits(.isHeader)');
    expect(view).toContain('.accessibilityAction(.escape)');
    expect(view).toContain('UISelectionFeedbackGenerator');
  });
});
