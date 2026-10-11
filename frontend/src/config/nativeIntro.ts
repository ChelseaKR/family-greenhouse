import type { TFunction } from 'i18next';
import { getNativePlatform, hasNativePlugin } from '@/lib/platform';

/**
 * The signed-out intro in the iOS app (NativeIntro `present`,
 * ios/App/App/NativeIntro*.swift, ADR 0035): a few native pages telling what
 * the app is for, then two doors, "Create account" and "I already have an
 * account". The web owns every word (the en and es catalogs, `auth.intro.*`);
 * Swift owns the pictures, the paging and the motion. The intro signs nobody
 * in or up: it answers which door was tapped, and the web opens its own
 * sign-up or sign-in screen, the same screens as the website.
 *
 * The rule both sides keep: only a tap on one of the two doors is a choice,
 * and "Create account" only when it was offered. Swift answers
 * `{ choice: null }` for every other ending (the web closed it, another
 * replaced it, VoiceOver's escape on the last page), and `introChoice` below
 * accepts nothing else.
 */

/** The name the iOS app registers the plugin under (NativeIntroPlugin.swift `jsName`). */
export const NATIVE_INTRO_PLUGIN = 'NativeIntro';
/** The methods the web needs; both must be listed in the bridge's header. */
export const NATIVE_INTRO_METHODS = ['present', 'dismiss'];

/**
 * True only inside the iOS app when the bridge lists the NativeIntro plugin
 * with both methods (`Capacitor.PluginHeaders`, read the way the keychain
 * plugin is, ADR 0034). An app built without it, Android, and the website
 * keep the web sign-in screen exactly as before; a plugin's JavaScript is
 * never driven without its native half.
 */
export function hasNativeIntro(): boolean {
  return (
    getNativePlatform() === 'ios' && hasNativePlugin(NATIVE_INTRO_PLUGIN, NATIVE_INTRO_METHODS)
  );
}

/**
 * The story pages, in order, then the last page. Each id picks its picture
 * in Swift (`IntroIllustration`): the greenhouse mark, a water drop being
 * claimed, a suitcase with a link, the app icon.
 */
export const INTRO_STORY_PAGES = ['household', 'claim', 'away'] as const;
export const INTRO_LAST_PAGE = 'start';

/** The brand name above the last page's title. A name, so not translated. */
export const INTRO_APP_NAME = 'Family Greenhouse';

export type IntroStart = 'story' | 'final';
export type IntroChoice = 'create' | 'signIn';

export interface NativeIntroPage {
  id: string;
  title: string;
  body: string;
}

/** `present`: web -> native, answered with a NativeIntroResult. */
export interface NativeIntroRequest {
  /** Names this presentation, for `dismiss`. */
  token: string;
  /** `story`: every page; `final`: only the last one. */
  start: IntroStart;
  /** The story pages, then the last page. */
  pages: NativeIntroPage[];
  skip: string;
  next: string;
  /** "Page {n} of {total}", read by VoiceOver on the page indicator. */
  pagePosition: string;
  appName: string;
  tagline: string;
  /** Left out when registration is paused: then only the sign-in door. */
  create?: string;
  signIn: string;
}

/** `present`'s answer: the door that was tapped, or null for no choice. */
export interface NativeIntroResult {
  choice: IntroChoice | null;
}

/** The intro, in the app's language. */
export function introRequest(
  t: TFunction,
  options: { start: IntroStart; offerCreate: boolean }
): Omit<NativeIntroRequest, 'token'> {
  const page = (id: string): NativeIntroPage => ({
    id,
    title: t(`auth.intro.${id}.title`),
    body: t(`auth.intro.${id}.body`),
  });
  return {
    start: options.start,
    pages: [...INTRO_STORY_PAGES.map(page), page(INTRO_LAST_PAGE)],
    skip: t('auth.intro.skip'),
    next: t('auth.intro.next'),
    pagePosition: t('auth.intro.pagePosition'),
    appName: INTRO_APP_NAME,
    tagline: t('brand.tagline'),
    ...(options.offerCreate ? { create: t('auth.createAccount') } : {}),
    signIn: t('auth.intro.haveAccount'),
  };
}

/**
 * What the web does with an answer: a door the request offered, or nothing.
 * Anything else (a null, a missing field, a word that is not a door, Create
 * when it was not offered) is no choice, and the sign-in screen stays.
 */
export function introChoice(
  result: unknown,
  request: Pick<NativeIntroRequest, 'create'>
): IntroChoice | null {
  const choice = (result as { choice?: unknown } | null | undefined)?.choice;
  if (choice === 'signIn') return 'signIn';
  if (choice === 'create' && request.create) return 'create';
  return null;
}
