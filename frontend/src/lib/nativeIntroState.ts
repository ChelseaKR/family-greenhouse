/**
 * When the apps' signed-out intro shows, and from which page (ADR 0035).
 *
 * - The whole story once per install: until the person has answered it or
 *   signed in on this install. The mark is in `localStorage`, which goes
 *   with the app when it is deleted, so a reinstall starts with the story
 *   again (on Android, unless Auto Backup restores the app's data).
 * - After that, every signed-out start (a launch, a sign-out) opens on the
 *   last page only: the two doors.
 * - At most once per signed-out stretch: going from sign-in to "Create
 *   account" and back does not bring it up again. Signing in starts a new
 *   stretch, so the next sign-out shows it.
 *
 * Kept out of config/nativeIntro.ts because App.tsx imports `noteSignedIn`,
 * and this is a few lines for every visitor where that is a whole module.
 */

const SEEN_KEY = 'fg.nativeIntro.seen';

let claimed = false;

/** Where the next intro opens. */
export function introStart(): 'story' | 'final' {
  try {
    return localStorage.getItem(SEEN_KEY) ? 'final' : 'story';
  } catch {
    return 'story';
  }
}

/** The story has been answered, or the person signed in here. */
export function markIntroSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Storage refused: the story shows again next time, which is harmless.
  }
}

/** Claims this signed-out stretch's one intro. False if it is taken. */
export function claimIntro(): boolean {
  if (claimed) return false;
  claimed = true;
  return true;
}

/** An intro that was claimed but never answered (the web left first). */
export function releaseIntro(): void {
  claimed = false;
}

/** Called while signed in, inside the shells: a new stretch, and no story. */
export function noteSignedIn(): void {
  claimed = false;
  markIntroSeen();
}

/** Test seam. */
export function resetNativeIntroStateForTests(): void {
  claimed = false;
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    // nothing to reset
  }
}
