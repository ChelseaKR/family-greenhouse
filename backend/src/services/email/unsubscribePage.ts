/**
 * The landing page behind an unsubscribe link.
 *
 * ## Why the API returns HTML here, and why it is unstyled
 *
 * `middleware/securityHeaders.ts` stamps `Content-Security-Policy:
 * default-src 'none'` on every API response, on the stated grounds that "the
 * API only ever returns data … never HTML or scripts". That is still the
 * right default, so this page lives inside it rather than around it: no
 * scripts, no images, no external or inline CSS — `style-src` falls back to
 * `default-src`, so an inline `style` attribute would simply be dropped. What
 * is left is semantic HTML, which every browser renders perfectly legibly.
 *
 * Loosening a security header so an unsubscribe confirmation could have
 * rounded corners would be a bad trade. ADR 0021 records it.
 *
 * ## Why GET does not unsubscribe
 *
 * Mail clients and corporate security scanners (Outlook Safe Links, most
 * scanning proxies) fetch every URL in a message. A GET that mutated would
 * unsubscribe people who never clicked. So GET renders a one-button form and
 * POST does the work — which is also exactly the shape RFC 8058 one-click
 * needs, since a provider's automated `List-Unsubscribe-Post` lands on the
 * same POST route.
 */
import { t, type EmailLocale } from './catalog.js';
import { escapeHtml } from './template.js';
import { settingsUrl } from './links.js';
import type { EmailCategory } from './capability.js';

export interface UnsubscribePageInput {
  locale: EmailLocale;
  /** Absolute URL the confirm form posts to (token included). */
  actionUrl?: string;
  category?: EmailCategory;
}

function page(locale: EmailLocale, title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="${locale}">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtml(
    title
  )}</title></head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
<p><a href="${escapeHtml(settingsUrl())}">${escapeHtml(t(locale, 'unsub.settingsLink'))}</a></p>
</body>
</html>
`;
}

function categoryLabel(locale: EmailLocale, category: EmailCategory): string {
  return t(locale, `unsub.category.${category}`);
}

/** The confirm form a human sees after clicking the footer link. */
export function renderConfirmPage(input: Required<UnsubscribePageInput>): string {
  const label = categoryLabel(input.locale, input.category);
  const body =
    `<p>${escapeHtml(t(input.locale, 'unsub.confirmBody', { category: label }))}</p>` +
    `<form method="post" action="${escapeHtml(input.actionUrl)}">` +
    `<input type="hidden" name="List-Unsubscribe" value="One-Click" />` +
    `<button type="submit">${escapeHtml(t(input.locale, 'unsub.confirmButton'))}</button>` +
    `</form>`;
  return page(input.locale, t(input.locale, 'unsub.title'), body);
}

export function renderDonePage(locale: EmailLocale, category: EmailCategory): string {
  const label = categoryLabel(locale, category);
  return page(
    locale,
    t(locale, 'unsub.doneTitle'),
    `<p>${escapeHtml(t(locale, 'unsub.doneBody', { category: label }))}</p>`
  );
}

export function renderInvalidPage(locale: EmailLocale): string {
  return page(
    locale,
    t(locale, 'unsub.invalidTitle'),
    `<p>${escapeHtml(t(locale, 'unsub.invalidBody'))}</p>`
  );
}

/**
 * Shown when the capability secret could not be read. It says we changed
 * nothing, because we did not — reporting a failed lookup as "you are
 * unsubscribed" would be this repo's named defect class aimed squarely at the
 * one promise an unsubscribe link makes.
 */
export function renderUnavailablePage(locale: EmailLocale): string {
  return page(
    locale,
    t(locale, 'unsub.errorTitle'),
    `<p>${escapeHtml(t(locale, 'unsub.errorBody'))}</p>`
  );
}
