/**
 * The words of the "your gift ends in 7 days" email (ADR 0028), in English
 * and Spanish. Sent once per gift, to a household's admins, by the same daily
 * scan and under the same consent, quiet-hours and exactly-once rules as the
 * no-card-trial emails (`trialLifecycleEmails.ts`).
 *
 * Why it exists: a gift ends on the clock and nothing else tells the
 * household. The first gifts redeemed in late December 2026 end in late
 * March 2027, so this had to exist before then.
 *
 * Pure: no SES, no DynamoDB, no clock beyond what the caller passes in.
 *
 * Rules this copy keeps (pinned by `giftEndingEmailCopy.test.ts`):
 *   - No urgency and no incentive: the plain date, no "last chance", no
 *     discount, no code. The one price named is the catalog's monthly price.
 *   - Nothing is deleted, and it says so.
 *   - It does not invite a checkout before the gift ends. A subscription
 *     started during a gift charges for days the gift already covers (ADR
 *     0028's known gap), so the copy says to start it on or after the end date.
 */
import { PLANS } from '../models/plans.js';
import type { GiftablePlanId } from '../models/giftSubscriptions.js';
import { t, type EmailLocale } from './email/catalog.js';
import { appUrl, settingsUrl } from './email/links.js';
import { renderEmail, type EmailBlock } from './email/template.js';
import { formatEndDate } from './trialLifecycleEmailCopy.js';

/** The email goes out once 7 days or fewer remain. */
export const GIFT_ENDING_DAYS_BEFORE_END = 7;

export interface GiftEndingEmailContext {
  locale: EmailLocale;
  recipientName: string | null;
  planId: GiftablePlanId;
  /** `giftEndsAt`, ISO 8601. */
  endsAt: string;
  timeZone: string;
  unsubscribeUrl: string | null;
}

interface Phrases {
  subject: string;
  title: string;
  preheader: string;
  greeting: string;
  greetingGeneric: string;
  intro: string;
  keptHeading: string;
  kept: string;
  keep: string;
  nothingToDo: string;
  cta: string;
  reply: string;
  reason: string;
}

const PHRASES: Record<EmailLocale, Phrases> = {
  en: {
    subject: 'Your {{plan}} gift ends on {{date}}',
    title: 'Your {{plan}} gift ends on {{date}}',
    preheader: 'Nothing is charged and nothing is deleted.',
    greeting: 'Hi {{name}},',
    greetingGeneric: 'Hi there,',
    intro:
      'The {{plan}} gift your household was given ends on {{date}}. Nothing is charged, and nothing renews. On that day your household goes back to its own plan automatically.',
    keptHeading: 'Nothing is deleted',
    kept: 'Every plant, care task, note and bit of care history stays in your household, and you can still open and edit all of it. If you have more plants or people than your own plan allows, they all stay; adding more is paused until there is room.',
    keep: 'If you would like to keep {{plan}} after that, it is {{price}} a month. You can start it in Settings, under Billing, on or after {{date}}. Starting it sooner would charge you for days the gift already covers.',
    nothingToDo: 'If you would rather not, there is nothing you need to do.',
    cta: 'See plans in Settings',
    reply: 'Questions? Reply to this email and a person will read it.',
    reason:
      'You are getting this because someone gave your household a gift of {{plan}} on Family Greenhouse. This is the only email about it ending.',
  },
  es: {
    subject: 'Tu regalo de {{plan}} termina el {{date}}',
    title: 'Tu regalo de {{plan}} termina el {{date}}',
    preheader: 'No se cobra nada y no se borra nada.',
    greeting: 'Hola, {{name}}:',
    greetingGeneric: 'Hola:',
    intro:
      'El regalo de {{plan}} que recibió tu hogar termina el {{date}}. No se cobra nada y nada se renueva. Ese día tu hogar vuelve a su propio plan de forma automática.',
    keptHeading: 'No se borra nada',
    kept: 'Cada planta, tarea de cuidado, nota y todo el historial de cuidados sigue en tu hogar, y puedes abrirlo y editarlo todo. Si tienes más plantas o personas de las que permite tu propio plan, todas se quedan; solo se pausa añadir más hasta que haya sitio.',
    keep: 'Si quieres conservar {{plan}} después, cuesta {{price}} al mes. Puedes empezarlo en Ajustes, en Facturación, a partir del {{date}}. Si lo empiezas antes, pagarías días que el regalo ya cubre.',
    nothingToDo: 'Si prefieres no hacerlo, no tienes que hacer nada.',
    cta: 'Ver los planes en Ajustes',
    reply: '¿Preguntas? Responde a este correo y lo leerá una persona.',
    reason:
      'Recibes esto porque alguien le regaló a tu hogar {{plan}} en Family Greenhouse. Este es el único correo sobre su final.',
  },
};

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name: string) =>
    name in vars ? vars[name] : m
  );
}

export interface ComposedGiftEndingEmail {
  subject: string;
  preheader: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

export function composeGiftEndingEmail(ctx: GiftEndingEmailContext): ComposedGiftEndingEmail {
  const p = PHRASES[ctx.locale];
  const plan = PLANS[ctx.planId];
  const date = formatEndDate(ctx.locale, ctx.endsAt, ctx.timeZone);
  const price = new Intl.NumberFormat(ctx.locale, { style: 'currency', currency: 'USD' }).format(
    plan.monthlyPrice
  );
  const vars = { plan: plan.name, date, price };
  const name = ctx.recipientName?.trim();
  const blocks: EmailBlock[] = [
    { kind: 'text', text: name ? fill(p.greeting, { name }) : p.greetingGeneric },
    { kind: 'text', text: fill(p.intro, vars) },
    { kind: 'heading', text: p.keptHeading },
    { kind: 'text', text: p.kept },
    { kind: 'divider' },
    { kind: 'text', text: fill(p.keep, vars) },
    { kind: 'text', text: p.nothingToDo },
    { kind: 'button', label: p.cta, href: appUrl('/settings/billing') },
    { kind: 'text', text: p.reply, tone: 'muted' },
  ];
  const links = [{ label: t(ctx.locale, 'footer.manage'), href: settingsUrl() }];
  if (ctx.unsubscribeUrl) {
    links.push({ label: t(ctx.locale, 'footer.unsubscribe'), href: ctx.unsubscribeUrl });
  }
  const subject = fill(p.subject, vars);
  const preheader = p.preheader;
  const { html, text } = renderEmail({
    locale: ctx.locale,
    title: fill(p.title, vars),
    preheader,
    blocks,
    footer: { reason: fill(p.reason, vars), safety: t(ctx.locale, 'footer.safety'), links },
  });
  const headers = ctx.unsubscribeUrl
    ? {
        'List-Unsubscribe': `<${ctx.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    : undefined;
  return { subject, preheader, text, html, headers };
}
