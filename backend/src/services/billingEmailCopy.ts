/**
 * Plain-text copy for the money-lifecycle emails, in English and Spanish.
 *
 * Pure module: no SES, no DynamoDB, no clock. Given a `BillingNotice`
 * (`models/billingNotices.ts`) and a rendering context it returns
 * `{ subject, text }`, so every sentence in this file is assertable in a unit
 * test without sending anything.
 *
 * ## Three rules it enforces, all of them for the same reason
 *
 * 1. **A null field prints no number.** `models/billingNotices.ts` publishes
 *    `null` for anything the Stripe event did not carry. Where that would have
 *    been an amount or a date, the copy says plainly that it could not be
 *    included and points at the billing page. It never renders `0`, `$0.00`,
 *    an epoch date, or "unknown" dressed as a value
 *    ([ADR 0010](../../../docs/adr/0010-settled-read-states.md)).
 * 2. **Amounts and dates go through `Intl`.** `Intl.NumberFormat` with the
 *    currency Stripe reported, and `Intl.DateTimeFormat` in the recipient's
 *    stored timezone — never string concatenation, per `docs/i18n.md`.
 *    Minor units are divided by the fraction digits `Intl` itself resolves for
 *    the currency, so a zero-decimal currency (JPY) is not silently divided by
 *    100.
 * 3. **No unsubscribe, and the email says why.** Every notice here is
 *    transactional: it concerns money already taken, money about to be taken,
 *    or access about to end. It is not gated on any notification preference
 *    and carries no marketing unsubscribe — instead a footer states that it is
 *    a billing message and links to notification settings, so the absence is
 *    explained rather than merely missing
 *    ([ADR 0023](../../../docs/adr/0023-billing-lifecycle-emails.md)).
 *
 * ## Localization, honestly
 *
 * The backend has no per-user locale field yet — `feat/useful-emails` owns
 * adding one — so `composeBillingEmail` takes the locale as a parameter and
 * today's callers pass the `en` default. Both catalogs are complete and
 * tested; adopting the field is a one-line change at each call site in
 * `services/billingEmails.ts`. When the shared multipart template layer lands,
 * these composers should move onto it: they deliberately produce a body and a
 * subject and nothing else, so nothing here has to be unpicked first.
 */
import type { BillingNotice, Money, PurchasedItem } from '../models/billingNotices.js';
import { getPlan, type Plan } from '../models/plans.js';

export type BillingEmailLocale = 'en' | 'es';

export const DEFAULT_BILLING_EMAIL_LOCALE: BillingEmailLocale = 'en';

/** BCP-47 tags for `Intl`. Regional choices: `en-US` matches the product's
 *  existing frontend default; `es-ES` matches the shipped es catalog. */
const INTL_LOCALES: Record<BillingEmailLocale, string> = { en: 'en-US', es: 'es-ES' };

export interface BillingEmailContext {
  locale: BillingEmailLocale;
  /** IANA zone the recipient's account stores. Validated by the caller. */
  timeZone: string;
  /** FRONTEND_URL base; trailing slashes are stripped here. */
  appUrl: string;
  /**
   * The plan the household holds AT THE MOMENT THE EMAIL IS COMPOSED, read
   * back from our own row after the event was applied — not guessed from the
   * event. Only the cancellation notices use it.
   */
  currentPlan?: Plan;
}

export interface ComposedEmail {
  subject: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Intl formatting
// ---------------------------------------------------------------------------

/**
 * `Money` in the recipient's language. Minor units are converted using the
 * fraction digits `Intl` resolves for that currency, so USD divides by 100 and
 * JPY divides by 1.
 */
export function formatMoney(money: Money, locale: BillingEmailLocale): string | null {
  const currency = money.currency.toUpperCase();
  // A malformed code would make Intl throw; the notice model already rejects
  // one, and this is the second door on the same rule.
  if (!/^[A-Z]{3}$/u.test(currency)) return null;
  const formatter = new Intl.NumberFormat(INTL_LOCALES[locale], { style: 'currency', currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(money.minorUnits / 10 ** digits);
}

/** An ISO instant as a date in the recipient's zone, or null if unreadable. */
export function formatDate(
  iso: string,
  locale: BillingEmailLocale,
  timeZone: string
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], { dateStyle: 'long', timeZone }).format(
    date
  );
}

/** Month + year only — a card expires at the end of a month, not on a day. */
function formatMonthYear(month: number, year: number, locale: BillingEmailLocale): string {
  // Noon UTC on the 15th: far enough from both edges that no timezone can
  // shift the rendered month.
  const instant = new Date(Date.UTC(year, month - 1, 15, 12));
  return new Intl.DateTimeFormat(INTL_LOCALES[locale], {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(instant);
}

function formatCount(value: number, locale: BillingEmailLocale): string {
  return new Intl.NumberFormat(INTL_LOCALES[locale]).format(value);
}

// ---------------------------------------------------------------------------
// Shared phrases
// ---------------------------------------------------------------------------

const PHRASES = {
  en: {
    greeting: 'Hi there,',
    signoff: ['Thanks for growing with us,', 'The Family Greenhouse team'],
    billingLink: (url: string) => `Manage your plan and see every invoice: ${url}`,
    amountUnknown:
      "We weren't able to include the amount in this email. The invoice on your billing page has it.",
    footer: (settingsUrl: string) =>
      [
        'This is a billing message about your Family Greenhouse household. We send it',
        'whatever your notification settings say, because it is about your money and',
        'your access — so it has no unsubscribe link.',
        `Your notification settings: ${settingsUrl}`,
      ].join('\n'),
  },
  es: {
    greeting: 'Hola:',
    signoff: ['Gracias por cultivar con nosotros,', 'El equipo de Family Greenhouse'],
    billingLink: (url: string) => `Gestiona tu plan y consulta tus facturas: ${url}`,
    amountUnknown:
      'No hemos podido incluir el importe en este correo. Lo encontrarás en la factura, en tu página de facturación.',
    footer: (settingsUrl: string) =>
      [
        'Este es un mensaje de facturación sobre tu hogar en Family Greenhouse. Te lo',
        'enviamos con independencia de tus preferencias de notificación, porque afecta a',
        'tu dinero y a tu acceso; por eso no lleva enlace para darte de baja.',
        `Tus preferencias de notificación: ${settingsUrl}`,
      ].join('\n'),
  },
} as const;

function baseUrl(appUrl: string): string {
  return appUrl.replace(/\/+$/u, '');
}

/** Assemble greeting + body + link + signoff + footer, dropping empty slots. */
function envelope(locale: BillingEmailLocale, appUrl: string, body: string[]): string {
  const phrases = PHRASES[locale];
  const base = baseUrl(appUrl);
  return [
    phrases.greeting,
    '',
    ...body,
    '',
    phrases.billingLink(`${base}/settings/billing`),
    '',
    ...phrases.signoff,
    '',
    '--',
    phrases.footer(`${base}/settings/notifications`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// What was bought
// ---------------------------------------------------------------------------

function itemLabel(item: PurchasedItem, locale: BillingEmailLocale): string {
  switch (item.kind) {
    case 'plan':
      return locale === 'es'
        ? `Plan ${getPlan(item.planId).name}`
        : `${getPlan(item.planId).name} plan`;
    case 'identifyCredits':
      return locale === 'es'
        ? `${formatCount(item.credits, locale)} identificaciones de plantas`
        : `${formatCount(item.credits, locale)} plant identifications`;
    case 'described':
      return item.description;
  }
}

// ---------------------------------------------------------------------------
// Per-notice composers
// ---------------------------------------------------------------------------

function receipt(
  notice: Extract<BillingNotice, { kind: 'payment_receipt' }>,
  ctx: BillingEmailContext
): ComposedEmail {
  const { locale, timeZone } = ctx;
  const phrases = PHRASES[locale];
  const amount = notice.amount === null ? null : formatMoney(notice.amount, locale);
  const item = notice.item === null ? null : itemLabel(notice.item, locale);
  const start =
    notice.periodStart === null ? null : formatDate(notice.periodStart, locale, timeZone);
  const end = notice.periodEnd === null ? null : formatDate(notice.periodEnd, locale, timeZone);
  const body: string[] = [];

  if (locale === 'es') {
    body.push('Hemos recibido tu pago. Aquí tienes el resumen:');
    body.push('');
    if (item !== null) body.push(`  Concepto: ${item}`);
    if (amount !== null) body.push(`  Importe: ${amount}`);
    if (start !== null && end !== null) body.push(`  Periodo: del ${start} al ${end}`);
    if (amount === null) body.push(`  ${phrases.amountUnknown}`);
    if (notice.invoiceUrl !== null) {
      body.push('');
      body.push(`Factura completa: ${notice.invoiceUrl}`);
    }
    if (notice.oneTime) {
      body.push('');
      body.push('Ha sido un pago único: no se renueva y no hay nada que cancelar.');
    }
  } else {
    body.push("We've received your payment. Here's what it covered:");
    body.push('');
    if (item !== null) body.push(`  Item: ${item}`);
    if (amount !== null) body.push(`  Amount: ${amount}`);
    if (start !== null && end !== null) body.push(`  Period: ${start} to ${end}`);
    if (amount === null) body.push(`  ${phrases.amountUnknown}`);
    if (notice.invoiceUrl !== null) {
      body.push('');
      body.push(`Full invoice: ${notice.invoiceUrl}`);
    }
    if (notice.oneTime) {
      body.push('');
      body.push('This was a one-time payment: nothing renews and there is nothing to cancel.');
    }
  }

  return {
    subject: locale === 'es' ? 'Tu recibo de Family Greenhouse' : 'Your Family Greenhouse receipt',
    text: envelope(locale, ctx.appUrl, body),
  };
}

function renewal(
  notice: Extract<BillingNotice, { kind: 'renewal_notice' }>,
  ctx: BillingEmailContext
): ComposedEmail {
  const { locale, timeZone } = ctx;
  const phrases = PHRASES[locale];
  const amount = notice.amount === null ? null : formatMoney(notice.amount, locale);
  const date = formatDate(notice.renewsAt, locale, timeZone);
  const body: string[] = [];

  if (locale === 'es') {
    body.push(
      date === null
        ? 'Tu suscripción a Family Greenhouse se renovará pronto.'
        : `Tu suscripción a Family Greenhouse se renovará el ${date}.`
    );
    body.push('');
    if (amount !== null) body.push(`  Importe: ${amount}`);
    else body.push(`  ${phrases.amountUnknown}`);
    body.push('');
    body.push('No tienes que hacer nada: el cobro es automático con la tarjeta registrada.');
    body.push('Si prefieres no renovar, puedes cancelar antes de esa fecha desde tu página de');
    body.push('facturación, en "Gestionar suscripción". Conservarás el acceso hasta el final');
    body.push('del periodo que ya has pagado.');
  } else {
    body.push(
      date === null
        ? 'Your Family Greenhouse subscription renews soon.'
        : `Your Family Greenhouse subscription renews on ${date}.`
    );
    body.push('');
    if (amount !== null) body.push(`  Amount: ${amount}`);
    else body.push(`  ${phrases.amountUnknown}`);
    body.push('');
    body.push('You do not need to do anything — the card on file is charged automatically.');
    body.push('If you would rather not renew, cancel before that date from your billing');
    body.push('page under "Manage subscription". You keep access until the end of the');
    body.push('period you have already paid for.');
  }

  return {
    subject:
      locale === 'es'
        ? 'Tu plan de Family Greenhouse se renueva pronto'
        : 'Your Family Greenhouse plan renews soon',
    text: envelope(locale, ctx.appUrl, body),
  };
}

function paymentFailed(
  notice: Extract<BillingNotice, { kind: 'payment_failed' }>,
  ctx: BillingEmailContext
): ComposedEmail {
  const { locale, timeZone } = ctx;
  const phrases = PHRASES[locale];
  const amount = notice.amount === null ? null : formatMoney(notice.amount, locale);
  const retryDate =
    notice.nextAttempt.state === 'scheduled'
      ? formatDate(notice.nextAttempt.at, locale, timeZone)
      : null;
  const body: string[] = [];

  if (locale === 'es') {
    body.push('No hemos podido cobrar el pago de tu suscripción a Family Greenhouse.');
    body.push('');
    if (amount !== null) body.push(`  Importe pendiente: ${amount}`);
    else body.push(`  ${phrases.amountUnknown}`);
    body.push('');
    body.push('Qué pasa ahora:');
    if (retryDate !== null) {
      body.push(`  - Volveremos a intentarlo el ${retryDate}.`);
    } else if (notice.nextAttempt.state === 'none') {
      body.push('  - Este era el último intento automático: no habrá más reintentos.');
    } else {
      body.push('  - No sabemos si habrá otro intento automático. Tu página de');
      body.push('    facturación muestra el estado real de la factura.');
    }
    body.push('  - Si la factura no llega a pagarse, Stripe dejará de reintentarlo y tu');
    body.push('    suscripción no continuará.');
    body.push('  - No se borra nada: tus plantas, tareas, fotos e historial siguen ahí,');
    body.push('    sea cual sea el plan en el que acabes.');
    body.push('');
    if (notice.invoiceUrl !== null) {
      body.push('Lo más rápido es pagar esta factura directamente en Stripe:');
      body.push(`  ${notice.invoiceUrl}`);
      body.push('');
      body.push('Ahí también puedes cambiar la tarjeta.');
    } else {
      body.push('Lo más rápido es actualizar la tarjeta en "Gestionar suscripción".');
    }
  } else {
    body.push("We couldn't take the payment for your Family Greenhouse subscription.");
    body.push('');
    if (amount !== null) body.push(`  Amount due: ${amount}`);
    else body.push(`  ${phrases.amountUnknown}`);
    body.push('');
    body.push('What happens next:');
    if (retryDate !== null) {
      body.push(`  - We'll try the card again on ${retryDate}.`);
    } else if (notice.nextAttempt.state === 'none') {
      body.push('  - That was the last automatic attempt — there will be no more retries.');
    } else {
      body.push("  - We don't know whether another automatic attempt is scheduled. Your");
      body.push('    billing page shows the invoice’s real status.');
    }
    body.push('  - If the invoice is never paid, Stripe stops retrying and your');
    body.push('    subscription will not continue.');
    body.push('  - Nothing is deleted either way: your plants, tasks, photos and care');
    body.push('    history stay, whatever plan you end up on.');
    body.push('');
    if (notice.invoiceUrl !== null) {
      body.push('The quickest fix is to pay this invoice directly with Stripe:');
      body.push(`  ${notice.invoiceUrl}`);
      body.push('');
      body.push('You can change the card there too.');
    } else {
      body.push('The quickest fix is to update the card under "Manage subscription".');
    }
  }

  return {
    subject:
      locale === 'es'
        ? 'No hemos podido cobrar tu pago de Family Greenhouse'
        : "We couldn't take your Family Greenhouse payment",
    text: envelope(locale, ctx.appUrl, body),
  };
}

function cardExpiring(
  notice: Extract<BillingNotice, { kind: 'card_expiring' }>,
  ctx: BillingEmailContext
): ComposedEmail {
  const { locale } = ctx;
  const expiry =
    notice.expMonth !== null && notice.expYear !== null
      ? formatMonthYear(notice.expMonth, notice.expYear, locale)
      : null;
  // Only ever describes the card with digits Stripe actually sent.
  const card =
    notice.brand !== null && notice.last4 !== null
      ? `${notice.brand} ••••${notice.last4}`
      : notice.last4 !== null
        ? `••••${notice.last4}`
        : notice.brand;
  const body: string[] = [];

  if (locale === 'es') {
    if (card !== null && expiry !== null) {
      body.push(`La tarjeta que tienes registrada (${card}) caduca a finales de ${expiry}.`);
    } else if (expiry !== null) {
      body.push(`La tarjeta que tienes registrada caduca a finales de ${expiry}.`);
    } else {
      body.push(`La tarjeta que tienes registrada (${card ?? ''}) está a punto de caducar.`.trim());
    }
    body.push('');
    body.push('Qué pasa si no la cambias: el siguiente cobro fallará, te avisaremos, y si');
    body.push('no se resuelve, la suscripción terminará y tu hogar pasará al plan gratuito.');
    body.push('No perderás ninguna planta ni tu historial.');
    body.push('');
    body.push('Puedes cambiarla en "Gestionar suscripción" cuando te venga bien.');
  } else {
    if (card !== null && expiry !== null) {
      body.push(`The card on file (${card}) expires at the end of ${expiry}.`);
    } else if (expiry !== null) {
      body.push(`The card on file expires at the end of ${expiry}.`);
    } else {
      body.push(`The card on file (${card ?? ''}) is about to expire.`.trim());
    }
    body.push('');
    body.push("If it isn't replaced, the next charge will fail. We'll tell you when that");
    body.push('happens, and if it stays unpaid the subscription ends and your household');
    body.push('moves to the free plan. No plants and no history are lost.');
    body.push('');
    body.push('You can replace it under "Manage subscription" whenever suits you.');
  }

  return {
    subject:
      locale === 'es'
        ? 'La tarjeta de tu cuenta caduca pronto'
        : 'The card on your account expires soon',
    text: envelope(locale, ctx.appUrl, body),
  };
}

function cancellationScheduled(
  notice: Extract<BillingNotice, { kind: 'cancellation_scheduled' }>,
  ctx: BillingEmailContext
): ComposedEmail {
  const { locale, timeZone, currentPlan } = ctx;
  const until =
    notice.accessUntil === null ? null : formatDate(notice.accessUntil, locale, timeZone);
  const free = getPlan('seedling');
  const planName = currentPlan?.name;
  const body: string[] = [];

  if (locale === 'es') {
    body.push('Hemos registrado la cancelación de tu suscripción. Nada más que hacer.');
    body.push('');
    body.push('Qué acceso conservas:');
    body.push(
      until === null
        ? `  - Mantienes ${planName ? `el plan ${planName}` : 'tu plan actual'} hasta el final del periodo que ya has pagado.`
        : `  - Mantienes ${planName ? `el plan ${planName}` : 'tu plan actual'} hasta el ${until}.`
    );
    body.push(`  - Después, tu hogar pasa al plan gratuito ${free.name}.`);
    body.push('  - No se borra nada: tus plantas, tareas, fotos e historial siguen ahí.');
    body.push('');
    body.push('Si cambias de opinión, puedes reactivar la suscripción antes de esa fecha');
    body.push('desde "Gestionar suscripción".');
  } else {
    body.push("Your cancellation is recorded. There's nothing else to do.");
    body.push('');
    body.push('What you keep, and until when:');
    body.push(
      until === null
        ? `  - You keep ${planName ? `the ${planName} plan` : 'your current plan'} until the end of the period you have already paid for.`
        : `  - You keep ${planName ? `the ${planName} plan` : 'your current plan'} until ${until}.`
    );
    body.push(`  - After that your household moves to the free ${free.name} plan.`);
    body.push('  - Nothing is deleted: your plants, tasks, photos and care history stay.');
    body.push('');
    body.push('If you change your mind, you can restart the subscription before that date');
    body.push('under "Manage subscription".');
  }

  return {
    subject:
      locale === 'es'
        ? 'Tu plan de Family Greenhouse va a terminar'
        : 'Your Family Greenhouse plan is set to end',
    text: envelope(locale, ctx.appUrl, body),
  };
}

function cancellationComplete(
  notice: Extract<BillingNotice, { kind: 'cancellation_complete' }>,
  ctx: BillingEmailContext
): ComposedEmail {
  const { locale, timeZone, currentPlan } = ctx;
  const ended = notice.endedAt === null ? null : formatDate(notice.endedAt, locale, timeZone);
  const body: string[] = [];

  if (locale === 'es') {
    body.push(
      ended === null
        ? 'Tu suscripción a Family Greenhouse ha terminado.'
        : `Tu suscripción a Family Greenhouse terminó el ${ended}.`
    );
    body.push('');
    body.push('Qué acceso tienes ahora:');
    if (currentPlan) {
      body.push(`  - Tu hogar está en el plan ${currentPlan.name}.`);
      body.push(
        `  - Sus límites: hasta ${formatCount(currentPlan.maxPlants, locale)} plantas y ${formatCount(currentPlan.maxMembers, locale)} miembros.`
      );
    }
    body.push('  - No se ha borrado nada: tus plantas, tareas, fotos e historial siguen ahí,');
    body.push('    aunque superen los límites del plan. Puedes exportarlo cuando quieras.');
    body.push('  - No volveremos a cobrarte nada.');
    body.push('');
    body.push('Si quieres volver más adelante, tu hogar te está esperando tal y como lo');
    body.push('dejaste.');
  } else {
    body.push(
      ended === null
        ? 'Your Family Greenhouse subscription has ended.'
        : `Your Family Greenhouse subscription ended on ${ended}.`
    );
    body.push('');
    body.push('What you have access to now:');
    if (currentPlan) {
      body.push(`  - Your household is on the ${currentPlan.name} plan.`);
      body.push(
        `  - Its limits: up to ${formatCount(currentPlan.maxPlants, locale)} plants and ${formatCount(currentPlan.maxMembers, locale)} members.`
      );
    }
    body.push('  - Nothing has been deleted: your plants, tasks, photos and care history');
    body.push('    are all still there, even where they exceed the free limits, and you can');
    body.push('    export them at any time.');
    body.push('  - You will not be charged again.');
    body.push('');
    body.push('If you come back later, your household will be exactly as you left it.');
  }

  return {
    subject:
      locale === 'es'
        ? 'Tu plan de Family Greenhouse ha terminado'
        : 'Your Family Greenhouse plan has ended',
    text: envelope(locale, ctx.appUrl, body),
  };
}

/** Compose the email for any notice. Total over the union — adding a notice
 *  kind without copy is a compile error, not a silent English fallback. */
export function composeBillingEmail(
  notice: BillingNotice,
  ctx: BillingEmailContext
): ComposedEmail {
  switch (notice.kind) {
    case 'payment_receipt':
      return receipt(notice, ctx);
    case 'renewal_notice':
      return renewal(notice, ctx);
    case 'payment_failed':
      return paymentFailed(notice, ctx);
    case 'card_expiring':
      return cardExpiring(notice, ctx);
    case 'cancellation_scheduled':
      return cancellationScheduled(notice, ctx);
    case 'cancellation_complete':
      return cancellationComplete(notice, ctx);
  }
}

/**
 * Confirmation that an account was deleted.
 *
 * Deliberately states what was RETAINED as prominently as what was removed.
 * `DELETE /me` preserves shared household activity under a pseudonymized
 * member name (`docs/compliance.md` §3), the table has point-in-time recovery
 * enabled so backups lag a live delete, Stripe keeps its own record of
 * payments already made, and the audit log records that a deletion happened.
 * Every one of those is true, none of them is in the privacy-policy summary a
 * person reads at the moment they press Delete, and an email that claimed
 * "everything is gone" would be false.
 *
 * `soleMemberHouseholds` is the count of households the user was the only
 * member of — those really were erased outright — read from the deletion path
 * itself, never estimated.
 */
export function composeAccountDeletionEmail(
  locale: BillingEmailLocale,
  appUrl: string,
  soleMemberHouseholds: number,
  sharedHouseholds: number
): ComposedEmail {
  const base = baseUrl(appUrl);
  const body: string[] = [];

  if (locale === 'es') {
    body.push('Hemos eliminado tu cuenta de Family Greenhouse. Esto es lo que ha pasado.');
    body.push('');
    body.push('Lo que hemos borrado:');
    body.push('  - Tu inicio de sesión. Ya no puedes acceder con esta dirección.');
    body.push('  - Tus preferencias de notificación, tu teléfono y tus dispositivos');
    body.push('    registrados para avisos.');
    if (soleMemberHouseholds > 0) {
      body.push(
        `  - ${formatCount(soleMemberHouseholds, locale)} hogar(es) del que eras el único miembro, con sus plantas,`
      );
      body.push('    tareas, fotos, espacios, claves de API y enlaces de cuidador.');
      body.push('  - Cualquier suscripción de esos hogares, cancelada en Stripe.');
    }
    body.push('');
    body.push('Lo que NO hemos borrado, y por qué:');
    if (sharedHouseholds > 0) {
      body.push(
        `  - El historial de cuidados de ${formatCount(sharedHouseholds, locale)} hogar(es) que compartías con otras`
      );
      body.push('    personas. Ese historial es de ellas tanto como tuyo, así que se conserva');
      body.push('    con tu nombre sustituido por uno anónimo. No queda tu identificador.');
    }
    body.push('  - Stripe, nuestro proveedor de pagos, conserva el registro de los pagos ya');
    body.push('    realizados según sus propias obligaciones legales.');
    body.push('  - Nuestras copias de seguridad de la base de datos, que permiten recuperar');
    body.push('    el sistema, todavía contienen datos anteriores durante su periodo de');
    body.push('    retención; caducan solas.');
    body.push('  - Un registro de auditoría que dice que se produjo una eliminación.');
    body.push('');
    body.push('No hace falta que hagas nada más. Si crees que esto ha sido un error,');
    body.push(`escríbenos a support@familygreenhouse.net.`);
  } else {
    body.push("We've deleted your Family Greenhouse account. Here is exactly what happened.");
    body.push('');
    body.push('What we deleted:');
    body.push('  - Your login. This address can no longer sign in.');
    body.push('  - Your notification preferences, phone number, and registered devices.');
    if (soleMemberHouseholds > 0) {
      body.push(
        `  - ${formatCount(soleMemberHouseholds, locale)} household(s) where you were the only member — their plants,`
      );
      body.push('    tasks, photos, spaces, API keys and sitter links.');
      body.push('  - Any subscription those households had, cancelled at Stripe.');
    }
    body.push('');
    body.push('What we did NOT delete, and why:');
    if (sharedHouseholds > 0) {
      body.push(
        `  - The care history of ${formatCount(sharedHouseholds, locale)} household(s) you shared with other people.`
      );
      body.push('    That record belongs to them as much as to you, so it stays — with your');
      body.push('    name replaced by an anonymous one and your account id removed.');
    }
    body.push('  - Stripe, our payment processor, keeps its own record of payments already');
    body.push('    made, under its own legal retention rules.');
    body.push('  - Our database backups, which exist so the service can be recovered, still');
    body.push('    contain earlier data for their retention window. They expire on their own.');
    body.push('  - An audit log entry recording that a deletion took place.');
    body.push('');
    body.push('There is nothing else for you to do. If this was a mistake, write to us at');
    body.push('support@familygreenhouse.net.');
  }

  const phrases = PHRASES[locale];
  const text = [
    phrases.greeting,
    '',
    ...body,
    '',
    ...phrases.signoff,
    '',
    '--',
    locale === 'es'
      ? [
          'Este es el último mensaje que te enviamos: confirma una acción que has',
          'solicitado y no depende de ninguna preferencia de notificación, porque esas',
          'preferencias ya no existen.',
          `Family Greenhouse — ${base}`,
        ].join('\n')
      : [
          'This is the last message we will send you. It confirms an action you asked',
          'for and is not governed by any notification preference, because those',
          'preferences no longer exist.',
          `Family Greenhouse — ${base}`,
        ].join('\n'),
  ].join('\n');

  return {
    subject:
      locale === 'es'
        ? 'Tu cuenta de Family Greenhouse ha sido eliminada'
        : 'Your Family Greenhouse account has been deleted',
    text,
  };
}
