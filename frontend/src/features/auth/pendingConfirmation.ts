interface PendingConfirmation {
  email: string;
  redirect: string | null;
}

const KEY = 'fg.pendingConfirmation';

/** Keep confirmation context across a refresh without putting an email in the URL. */
export function setPendingConfirmation(value: PendingConfirmation): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private browsing; the recovery form remains usable.
  }
}

export function getPendingConfirmation(): PendingConfirmation | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingConfirmation>;
    if (typeof parsed.email !== 'string' || !parsed.email) return null;
    return {
      email: parsed.email,
      redirect: typeof parsed.redirect === 'string' ? parsed.redirect : null,
    };
  } catch {
    return null;
  }
}

export function clearPendingConfirmation(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // no-op
  }
}
