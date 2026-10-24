/**
 * The words of the two no-card-trial lifecycle emails (ADR 0039), in English
 * and Spanish, and the HTML and plain-text bodies built from them.
 *
 *   - `trial_day10`: "Your Garden trial ends in 4 days".
 *   - `trial_day14`: "You are back on Seedling, and nothing was deleted".
 *
 * Pure: no SES, no DynamoDB, no clock beyond what the caller passes in, so
 * every sentence can be asserted without sending anything.
 *
 * ## Rules this copy keeps (and `trialLifecycleEmailCopy.test.ts` pins)
 *
 *   - **No urgency, no incentive.** No countdown language beyond the plain
 *     date, no "last chance", no "hurry", no discount, no code. The only price
 *     named is the one in the plan catalog, and it is named once.
 *   - **Caps, not deletions.** It says what stops being available and that
 *     everything already made is kept. Every figure comes from the plan
 *     catalog (`models/plans.ts`), never a literal.
 *   - **Absence is never an achievement.** A household that added no plant is
 *     told "You have not added a plant yet." A count that could not be read is
 *     left out and the email says so; it is never written as 0.
 *   - **Only existing data.** Plants added, care tasks done. Nothing that
 *     needed new tracking. (Reminders delivered is excluded on purpose; see
 *     `trialLifecycleFacts.ts`.)
 *   - **Escaping** is `renderEmail`'s: every interpolated value, including the
 *     recipient's name, goes through `escapeHtml` there.
 */
import { PLANS } from '../models/plans.js';
import { t, formatCount, type EmailLocale } from './email/catalog.js';
import { appUrl, settingsUrl } from './email/links.js';
import { renderEmail, type EmailBlock } from './email/template.js';
import type { CountRead, TrialFacts } from './trialLifecycleFacts.js';
import { withSeedlingGrandfather } from '../models/plans.js';

export type TrialEmailKind = 'trial_day10' | 'trial_day14';

export interface TrialEmailContext {
  kind: TrialEmailKind;
  locale: EmailLocale;
  /** The recipient's display name, or null when the member row has none. */
  recipientName: string | null;
  /** `noCardTrialEndsAt`, ISO 8601. */
  endsAt: string;
  now: Date;
  /** The recipient's IANA zone, for rendering the end date. */
  timeZone: string;
  facts: TrialFacts;
  /** One-click unsubscribe URL, or null when it could not be minted. */
  unsubscribeUrl: string | null;
  /**
   * The household row's `createdAt`. A household created before the
   * 2026-10-23 Seedling cut falls back to 20 plants and 3 members, not 8 and
   * 2 (ADR 0040), and the email must name the caps it will actually have.
   */
  householdCreatedAt?: string | null;
}

export interface ComposedTrialEmail {
  subject: string;
  preheader: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

type Plural = { one: string; other: string };

interface Phrases {
  d10Subject: Plural;
  d10Title: Plural;
  d10Preheader: string;
  d10Intro: string;
  d10ChangesHeading: string;
  d10ChangesLead: string;
  d14Subject: string;
  d14Title: string;
  d14Preheader: string;
  d14Intro: string;
  d14KeptHeading: string;
  d14Kept: string;
  d14DifferentHeading: string;
  greeting: string;
  greetingGeneric: string;
  factsHeading: string;
  plantsAdded: Plural;
  plantsNone: string;
  tasksDone: Plural;
  tasksNone: string;
  factsUnavailable: string;
  limitPlants: string;
  limitMembers: string;
  limitTools: string;
  overPlants: string;
  overMembers: string;
  keepGarden: string;
  nothingToDo: string;
  cta: string;
  reply: string;
  reasonDay10: string;
  reasonDay14: string;
}

const PHRASES: Record<EmailLocale, Phrases> = {
  en: {
    d10Subject: {
      one: 'Your Garden trial ends in {{count}} day',
      other: 'Your Garden trial ends in {{count}} days',
    },
    d10Title: {
      one: 'Your Garden trial ends in {{count}} day',
      other: 'Your Garden trial ends in {{count}} days',
    },
    d10Preheader: 'Nothing is charged. After {{date}} you are on Seedling, and nothing is deleted.',
    d10Intro:
      'Your household’s free Garden trial ends on {{date}}. We never asked for a card, so nothing will be charged. On that day your household moves to Seedling, the free plan, on its own.',
    d10ChangesHeading: 'What changes on {{date}}',
    d10ChangesLead: 'Everything you have made stays. What changes is what you can add:',
    d14Subject: 'You are back on Seedling, and nothing was deleted',
    d14Title: 'Your Garden trial has ended',
    d14Preheader: 'Everything you added is still here, and nothing was charged.',
    d14Intro:
      'Your household’s free Garden trial ended on {{date}}. Your household is now on Seedling, the free plan. No card was on file, and nothing was charged.',
    d14KeptHeading: 'Nothing was deleted',
    d14Kept:
      'Every plant, care task, note and bit of care history is still in your household, and you can still open and edit all of it.',
    d14DifferentHeading: 'What is different now',
    greeting: 'Hi {{name}},',
    greetingGeneric: 'Hi there,',
    factsHeading: 'What your household did during the trial',
    plantsAdded: { one: 'You added {{count}} plant.', other: 'You added {{count}} plants.' },
    plantsNone: 'You have not added a plant yet.',
    tasksDone: {
      one: 'Your household marked {{count}} care task done.',
      other: 'Your household marked {{count}} care tasks done.',
    },
    tasksNone: 'No care task has been marked done yet.',
    factsUnavailable:
      'We could not load your household’s counts for this email, so none are shown. That does not mean there is nothing to count.',
    limitPlants:
      'Plants: Seedling holds up to {{limit}} active plants. If you have more, they all stay; you just cannot add another until you are under {{limit}}.',
    limitMembers:
      'People: up to {{limit}} in a household. Nobody is removed; new people cannot join until there is room.',
    limitTools:
      'Garden tools: the care assistant, the Away Kit, plant tags, the coverage view and the longer analytics history pause. What you already made with them is kept.',
    overPlants:
      'You have {{count}} active plants, more than Seedling’s {{limit}}. They all stay. Adding another is paused until you have fewer than {{limit}}.',
    overMembers:
      'Your household has {{count}} people, more than Seedling’s {{limit}}. They all stay. New people cannot join until there is room.',
    keepGarden:
      'If you would like to keep Garden, it is {{price}} a month. You can start it any time in Settings, under Billing.',
    nothingToDo: 'If you would rather stay on Seedling, there is nothing you need to do.',
    cta: 'See plans in Settings',
    reply: 'Questions? Reply to this email and a person will read it.',
    reasonDay10:
      'You are getting this because your household started a free Garden trial on Family Greenhouse. We send two emails about it: this one, and one when it ends.',
    reasonDay14:
      'You are getting this because your household had a free Garden trial on Family Greenhouse. This is the last email about it.',
  },
  es: {
    d10Subject: {
      one: 'Tu prueba de Garden termina en {{count}} día',
      other: 'Tu prueba de Garden termina en {{count}} días',
    },
    d10Title: {
      one: 'Tu prueba de Garden termina en {{count}} día',
      other: 'Tu prueba de Garden termina en {{count}} días',
    },
    d10Preheader: 'No se cobra nada. Después del {{date}} pasas a Seedling y no se borra nada.',
    d10Intro:
      'La prueba gratuita de Garden de tu hogar termina el {{date}}. Nunca pedimos una tarjeta, así que no se cobrará nada. Ese día tu hogar pasa a Seedling, el plan gratuito, de forma automática.',
    d10ChangesHeading: 'Qué cambia el {{date}}',
    d10ChangesLead: 'Todo lo que has creado se queda. Lo que cambia es lo que puedes añadir:',
    d14Subject: 'Has vuelto a Seedling y no se borró nada',
    d14Title: 'Terminó tu prueba de Garden',
    d14Preheader: 'Todo lo que añadiste sigue aquí y no se cobró nada.',
    d14Intro:
      'La prueba gratuita de Garden de tu hogar terminó el {{date}}. Tu hogar está ahora en Seedling, el plan gratuito. No había ninguna tarjeta registrada y no se cobró nada.',
    d14KeptHeading: 'No se borró nada',
    d14Kept:
      'Cada planta, tarea de cuidado, nota y todo el historial de cuidados sigue en tu hogar, y puedes abrirlo y editarlo todo.',
    d14DifferentHeading: 'Qué es distinto ahora',
    greeting: 'Hola, {{name}}:',
    greetingGeneric: 'Hola:',
    factsHeading: 'Lo que hizo tu hogar durante la prueba',
    plantsAdded: { one: 'Añadiste {{count}} planta.', other: 'Añadiste {{count}} plantas.' },
    plantsNone: 'Todavía no has añadido ninguna planta.',
    tasksDone: {
      one: 'Tu hogar marcó {{count}} tarea de cuidado como hecha.',
      other: 'Tu hogar marcó {{count}} tareas de cuidado como hechas.',
    },
    tasksNone: 'Todavía no se ha marcado ninguna tarea de cuidado como hecha.',
    factsUnavailable:
      'No pudimos cargar los recuentos de tu hogar para este correo, así que no se muestran. Eso no significa que no haya nada que contar.',
    limitPlants:
      'Plantas: Seedling admite hasta {{limit}} plantas activas. Si tienes más, todas se quedan; solo no podrás añadir otra hasta tener menos de {{limit}}.',
    limitMembers:
      'Personas: hasta {{limit}} en un hogar. No se quita a nadie; las personas nuevas no pueden unirse hasta que haya sitio.',
    limitTools:
      'Herramientas de Garden: el asistente de cuidados, el Kit de Ausencia, las etiquetas de plantas, la vista de cobertura y el historial de analíticas más largo se pausan. Lo que ya creaste con ellas se conserva.',
    overPlants:
      'Tienes {{count}} plantas activas, más que las {{limit}} de Seedling. Todas se quedan. No podrás añadir otra hasta tener menos de {{limit}}.',
    overMembers:
      'Tu hogar tiene {{count}} personas, más que las {{limit}} de Seedling. Todas se quedan. Las personas nuevas no pueden unirse hasta que haya sitio.',
    keepGarden:
      'Si quieres conservar Garden, cuesta {{price}} al mes. Puedes empezarlo cuando quieras en Ajustes, en Facturación.',
    nothingToDo: 'Si prefieres quedarte en Seedling, no tienes que hacer nada.',
    cta: 'Ver los planes en Ajustes',
    reply: '¿Preguntas? Responde a este correo y lo leerá una persona.',
    reasonDay10:
      'Recibes esto porque tu hogar empezó una prueba gratuita de Garden en Family Greenhouse. Enviamos dos correos sobre ella: este y otro cuando termine.',
    reasonDay14:
      'Recibes esto porque tu hogar tuvo una prueba gratuita de Garden en Family Greenhouse. Este es el último correo sobre ella.',
  },
};

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m
  );
}

function plural(locale: EmailLocale, forms: Plural, count: number, vars = {}): string {
  const category = new Intl.PluralRules(locale).select(count);
  return fill(category === 'one' ? forms.one : forms.other, {
    count: formatCount(locale, count),
    ...vars,
  });
}

/** The end date as the recipient reads it: their zone, their language. A zone
 *  Intl rejects falls back to UTC rather than throwing in the middle of a run. */
export function formatEndDate(locale: EmailLocale, endsAt: string, timeZone: string): string {
  const date = new Date(endsAt);
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
  }
}

/** Whole days from `now` to `endsAt`, never below 1 while the trial runs. */
export function daysLeft(endsAt: string, now: Date): number {
  const ms = Date.parse(endsAt) - now.getTime();
  return Math.max(1, Math.ceil(ms / DAY_MS));
}

function countOf(read: CountRead): number | null {
  return read.status === 'ok' ? read.value : null;
}

/**
 * The facts section. Returns an empty list only when there is nothing honest
 * to say; a household with no plants gets the plain sentence for that, and a
 * failed read gets a sentence saying so.
 */
function factBlocks(ctx: TrialEmailContext, p: Phrases): EmailBlock[] {
  const { locale, facts } = ctx;
  const plants = countOf(facts.plantsAdded);
  const tasks = countOf(facts.tasksCompleted);
  const lines: string[] = [];
  let unreadable = false;

  if (plants === null) unreadable = true;
  else if (plants === 0) lines.push(p.plantsNone);
  else lines.push(plural(locale, p.plantsAdded, plants));

  // Tasks only mean something once there are plants. With none added, the
  // plain "not added a plant yet" line stands alone.
  if (plants !== 0) {
    if (tasks === null) unreadable = true;
    else if (tasks === 0) lines.push(p.tasksNone);
    else lines.push(plural(locale, p.tasksDone, tasks));
  }

  const blocks: EmailBlock[] = [{ kind: 'heading', text: p.factsHeading }];
  for (const line of lines) blocks.push({ kind: 'text', text: line });
  if (unreadable) blocks.push({ kind: 'notice', text: p.factsUnavailable });
  return blocks;
}

/** What Seedling holds for THIS household: the catalog, or its grandfathered caps. */
function limitBlocks(ctx: TrialEmailContext, p: Phrases, withOver: boolean): EmailBlock[] {
  const { locale, facts } = ctx;
  const seedling = withSeedlingGrandfather(PLANS.seedling, ctx.householdCreatedAt);
  const plantLimit = seedling.limits.plants;
  const memberLimit = seedling.limits.members;
  const blocks: EmailBlock[] = [];
  if (plantLimit !== null) {
    blocks.push({
      kind: 'text',
      text: fill(p.limitPlants, { limit: formatCount(locale, plantLimit) }),
    });
  }
  if (memberLimit !== null) {
    blocks.push({
      kind: 'text',
      text: fill(p.limitMembers, { limit: formatCount(locale, memberLimit) }),
    });
  }
  blocks.push({ kind: 'text', text: p.limitTools });
  if (withOver) {
    const plantsNow = countOf(facts.plantsNow);
    const membersNow = countOf(facts.membersNow);
    if (plantLimit !== null && plantsNow !== null && plantsNow > plantLimit) {
      blocks.push({
        kind: 'notice',
        text: fill(p.overPlants, {
          count: formatCount(locale, plantsNow),
          limit: formatCount(locale, plantLimit),
        }),
      });
    }
    if (memberLimit !== null && membersNow !== null && membersNow > memberLimit) {
      blocks.push({
        kind: 'notice',
        text: fill(p.overMembers, {
          count: formatCount(locale, membersNow),
          limit: formatCount(locale, memberLimit),
        }),
      });
    }
  }
  return blocks;
}

export function composeTrialLifecycleEmail(ctx: TrialEmailContext): ComposedTrialEmail {
  const { kind, locale } = ctx;
  const p = PHRASES[locale];
  const date = formatEndDate(locale, ctx.endsAt, ctx.timeZone);
  const price = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(
    PLANS.garden.monthlyPrice
  );
  const name = ctx.recipientName?.trim();
  const greeting = name ? fill(p.greeting, { name }) : p.greetingGeneric;

  let subject: string;
  let title: string;
  let preheader: string;
  let reason: string;
  const blocks: EmailBlock[] = [{ kind: 'text', text: greeting }];

  if (kind === 'trial_day10') {
    const left = daysLeft(ctx.endsAt, ctx.now);
    subject = plural(locale, p.d10Subject, left);
    title = plural(locale, p.d10Title, left);
    preheader = fill(p.d10Preheader, { date });
    reason = p.reasonDay10;
    blocks.push({ kind: 'text', text: fill(p.d10Intro, { date }) });
    blocks.push(...factBlocks(ctx, p));
    blocks.push({ kind: 'heading', text: fill(p.d10ChangesHeading, { date }) });
    blocks.push({ kind: 'text', text: p.d10ChangesLead });
    blocks.push(...limitBlocks(ctx, p, false));
  } else {
    subject = p.d14Subject;
    title = p.d14Title;
    preheader = p.d14Preheader;
    reason = p.reasonDay14;
    blocks.push({ kind: 'text', text: fill(p.d14Intro, { date }) });
    blocks.push({ kind: 'heading', text: p.d14KeptHeading });
    blocks.push({ kind: 'text', text: p.d14Kept });
    blocks.push(...factBlocks(ctx, p));
    blocks.push({ kind: 'heading', text: p.d14DifferentHeading });
    blocks.push(...limitBlocks(ctx, p, true));
  }

  blocks.push({ kind: 'divider' });
  blocks.push({ kind: 'text', text: fill(p.keepGarden, { price }) });
  blocks.push({ kind: 'text', text: p.nothingToDo });
  blocks.push({ kind: 'button', label: p.cta, href: appUrl('/settings/billing') });
  blocks.push({ kind: 'text', text: p.reply, tone: 'muted' });

  const links = [{ label: t(locale, 'footer.manage'), href: settingsUrl() }];
  if (ctx.unsubscribeUrl) {
    links.push({ label: t(locale, 'footer.unsubscribe'), href: ctx.unsubscribeUrl });
  }

  const { html, text } = renderEmail({
    locale,
    title,
    preheader,
    blocks,
    footer: { reason, safety: t(locale, 'footer.safety'), links },
  });

  const headers = ctx.unsubscribeUrl
    ? {
        'List-Unsubscribe': `<${ctx.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    : undefined;

  return { subject, preheader, text, html, headers };
}
