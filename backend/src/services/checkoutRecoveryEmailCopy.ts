/**
 * Plain-text copy for the abandoned-checkout recovery email, in English and
 * Spanish.
 *
 * Pure module: no SES, no DynamoDB, no clock beyond what the caller passes
 * in — so every sentence here is assertable in a unit test without sending
 * anything. Same discipline `services/billingEmailCopy.ts` documents for
 * itself, and deliberately a SIBLING file rather than an addition to it:
 * every composer there takes a `BillingNotice` derived from a Stripe EVENT
 * (`models/billingNotices.ts`), and this email is not one. It is triggered by
 * a SCHEDULED scan of the same stale-marker read `GET /billing/me` already
 * publishes (`billing.staleCheckoutMarker`, shipped in PR #790), not a
 * webhook, so there is no `BillingNotice` to switch on here.
 *
 * ## What this deliberately cannot say
 *
 * `HouseholdSubscription.staleCheckout` (`services/billing.ts`) carries no
 * plan id: `claimPendingCheckout` records only the Checkout Session id and the
 * moment, never what was being bought — #790's own PR body says so directly.
 * So this copy names "a paid plan", never a tier, exactly the limitation
 * #790's in-app notice accepted, for the same reason: inventing a tier from
 * data that is not on the row would be a false claim, and a live Stripe
 * lookup to fill the gap would touch a real Stripe object from an
 * unattended background job, which this change does not do either.
 *
 * ## The sentence PR #790's own finding exists to keep honest
 *
 * A Checkout Session that completed with a payment method that settles LATER
 * (a bank debit — `checkout.session.completed` with `payment_status:
 * 'unpaid'`) leaves the exact same marker in place until
 * `checkout.session.async_payment_succeeded` eventually clears it
 * (`billing.applyStripeEvent`'s `settlesPendingCheckout` branch) — which can
 * be days after this job reads the marker as stale. So this email is not
 * allowed to say "you were not charged": it hedges exactly the way #790's
 * notice hedges, because the underlying uncertainty is identical, and it
 * matters MORE here — this lands unsolicited in an inbox, rather than only on
 * a page the household chose to open.
 */
import { formatDaysAgo, type EmailLocale } from './email/catalog.js';

export type CheckoutRecoveryEmailLocale = EmailLocale;

export interface CheckoutRecoveryEmailContext {
  locale: CheckoutRecoveryEmailLocale;
  /** FRONTEND_URL base; trailing slashes are stripped here. */
  appUrl: string;
  /**
   * `staleCheckout.startedAt` off `billing.getHouseholdSubscription` — when
   * THIS checkout attempt began, ISO 8601. Never the raw Stripe Session id:
   * this module has no more of the row than that public shape carries, and
   * `HouseholdSubscription.staleCheckout` deliberately does not leak it.
   */
  startedAt: string;
  /** Clock the caller controls, so "how long ago" is deterministic in tests. */
  now: Date;
}

export interface ComposedCheckoutRecoveryEmail {
  subject: string;
  text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function baseUrl(appUrl: string): string {
  return appUrl.replace(/\/+$/u, '');
}

const PHRASES = {
  en: {
    greeting: 'Hi there,',
    signoff: ['Thanks for growing with us,', 'The Family Greenhouse team'],
    footer: (settingsUrl: string) =>
      [
        'This is a one-time email about a checkout you started — we send it once',
        'per attempt, and it does not repeat. It is not gated on your notification',
        'settings, because it is tied to one specific action rather than an',
        'ongoing preference.',
        `Manage your notification settings: ${settingsUrl}`,
      ].join('\n'),
  },
  es: {
    greeting: 'Hola:',
    signoff: ['Gracias por cultivar con nosotros,', 'El equipo de Family Greenhouse'],
    footer: (settingsUrl: string) =>
      [
        'Este es un correo único sobre un intento de pago que iniciaste: lo',
        'enviamos una sola vez por intento y no se repite. No depende de tus',
        'preferencias de notificación, porque está ligado a una acción concreta',
        'y no a una preferencia continua.',
        `Gestiona tus preferencias de notificación: ${settingsUrl}`,
      ].join('\n'),
  },
} as const;

/**
 * The abandoned-checkout recovery email.
 *
 * Structure mirrors `billingEmailCopy.ts`'s `envelope`: greeting, body, a
 * direct link back to checkout, signoff, footer — but this footer explains
 * ungated-and-one-time rather than ungated-and-transactional, because this
 * email is neither a receipt nor a renewal notice.
 */
export function composeCheckoutRecoveryEmail(
  ctx: CheckoutRecoveryEmailContext
): ComposedCheckoutRecoveryEmail {
  const { locale, now, startedAt } = ctx;
  const phrases = PHRASES[locale];
  const base = baseUrl(ctx.appUrl);
  const startedAtMs = Date.parse(startedAt);
  const daysAgo = Number.isNaN(startedAtMs)
    ? 0
    : Math.max(0, (now.getTime() - startedAtMs) / DAY_MS);
  // "today" / "hoy" for the ordinary case (the job runs every 15-30 minutes
  // against a 45-minute staleness window, so same-day is the common outcome);
  // Intl.RelativeTimeFormat degrades gracefully to "N days ago" when a run was
  // delayed or truncated.
  const when = formatDaysAgo(locale, daysAgo);
  const billingUrl = `${base}/settings/billing`;

  const body: string[] =
    locale === 'es'
      ? [
          `Empezaste a pagar un plan de pago de Family Greenhouse ${when} y parece que no` +
            ' llegaste a completarlo.',
          '',
          'Por lo que podemos ver, no se te ha cobrado nada. La única excepción: si' +
            ' pagaste por transferencia bancaria u otro método que se confirma después de' +
            ' la compra, esa confirmación puede tardar varios días en llegarnos — si es tu' +
            ' caso, revisa tu correo por si tienes ya un recibo de Stripe antes de' +
            ' intentarlo de nuevo.',
          '',
          'Si quieres terminar, puedes continuar justo donde lo dejaste:',
          `  ${billingUrl}`,
          '',
          'Sin prisa y sin fecha límite. Si has cambiado de idea, no tienes que hacer' +
            ' nada más: solo enviamos este correo una vez por cada intento de pago, así' +
            ' que no volverás a recibirlo por este en concreto.',
        ]
      : [
          `You started checking out for a paid Family Greenhouse plan ${when}, and it` +
            " looks like it didn't go through.",
          '',
          "As far as we can tell, you weren't charged for it. The one exception: if you" +
            ' paid by bank transfer or another method that confirms after checkout, that' +
            ' confirmation can take a few days to reach us — if that sounds like what' +
            ' happened, check your email for a receipt from Stripe before trying again.',
          '',
          "If you'd still like to finish, you can pick up right where you left off:",
          `  ${billingUrl}`,
          '',
          'No rush, and no deadline on this. If you changed your mind, there is nothing' +
            ' else to do — we only send this once per checkout attempt, so you will not' +
            ' hear about this particular one again.',
        ];

  return {
    subject:
      locale === 'es'
        ? 'Empezaste a registrarte en Family Greenhouse: ¿quieres terminar?'
        : 'You started signing up for Family Greenhouse — want to finish?',
    text: [
      phrases.greeting,
      '',
      ...body,
      '',
      ...phrases.signoff,
      '',
      '--',
      phrases.footer(`${base}/settings?section=notifications`),
    ].join('\n'),
  };
}
