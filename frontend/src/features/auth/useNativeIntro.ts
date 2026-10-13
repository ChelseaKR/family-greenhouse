import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ensureLanguageCatalog } from '@/i18n';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { hasNativeIntro, introChoice, introRequest } from '@/config/nativeIntro';
import { claimIntro, introStart, markIntroSeen, releaseIntro } from '@/lib/nativeIntroState';

interface NativeIntroOptions {
  /**
   * False when the person already chose to sign in (an explicit `?redirect=`
   * link to sign-in, the email just confirmed): the intro does not stand in
   * front of that.
   */
  enabled: boolean;
  /** Where "Create account" goes: the sign-up screen, keeping any redirect. */
  signupHref: string;
  /** "I already have an account": the intro fades onto the sign-in form. */
  onSignIn: () => void;
}

/**
 * The apps' signed-out intro, over the sign-in screen (ADR 0035). Shown
 * only when the bridge lists the NativeIntro plugin (`hasNativeIntro`); the
 * website and an app built without the plugin render the sign-in
 * screen exactly as before and load nothing for it. The intro only reports
 * which door was tapped; the sign-in and sign-up screens, their requests and
 * the session are the web's, unchanged.
 */
export function useNativeIntro({ enabled, signupHref, onSignIn }: NativeIntroOptions): void {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const latest = useRef({ i18n, navigate, signupHref, onSignIn });
  latest.current = { i18n, navigate, signupHref, onSignIn };

  useEffect(() => {
    if (!enabled || !hasNativeIntro() || !claimIntro()) return;
    let live = true;
    let answered = false;
    let token: string | null = null;
    const start = introStart();

    // The words are read once the language's catalog is in: a Spanish
    // launch must not show an intro built from the English fallback while
    // the Spanish catalog is still on its way (measured in the e2e spec).
    const lng = latest.current.i18n.language;
    void Promise.all([
      import('@/services/nativeIntro'),
      ensureLanguageCatalog(lng).catch(() => undefined),
    ])
      .then(async ([{ presentIntro }]) => {
        if (!live) return;
        const { i18n: current } = latest.current;
        const request = introRequest(current.getFixedT(current.language), {
          start,
          offerCreate: PUBLIC_REGISTRATION_AVAILABLE,
        });
        const result = await presentIntro(request, (name) => {
          token = name;
        });
        answered = true;
        // Failed (null): never seen, and this stretch does not ask again.
        if (!live || result === null) return;
        markIntroSeen();
        const choice = introChoice(result, request);
        if (choice === 'create') latest.current.navigate(latest.current.signupHref);
        else if (choice === 'signIn') latest.current.onSignIn();
      })
      .catch(() => {
        answered = true;
      });

    return () => {
      live = false;
      if (answered) return;
      // The sign-in screen went away first (React's development double
      // mount, or a link that opened another screen): the next sign-in
      // screen of this stretch may show it, and one already up goes away.
      releaseIntro();
      const name = token;
      if (name) {
        void import('@/services/nativeIntro').then(({ dismissIntro }) => dismissIntro(name));
      }
    };
  }, [enabled]);
}
