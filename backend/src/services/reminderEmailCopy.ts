/**
 * The phrases the branded reminder EMAIL adds on top of `reminderEmail.ts`'s
 * catalog: the title that says what to do, the section headings, the row
 * line, the action label, the "and N more" link and the closing button.
 *
 * ## Why a separate module
 *
 * Push (lane B of the 0.41.0 work) is getting the same treatment at the same
 * time, in `services/reminderCopy.ts`. Where the two surfaces say the same
 * thing — the title, the per-task line, the action label — they should use
 * the same words, and the plan is one shared module. That module was not on
 * `main` when this one was written, so these phrases live here, kept to the
 * shape a shared catalog would have (one object per locale, every key in
 * both, no logic beyond simple pluralization), so reconciling is a move,
 * not a rewrite. NOTES.md for this lane says so too.
 *
 * ## Rules
 *
 *   - Both locales carry every key; `reminderEmailMessage.test.ts` fails if
 *     one gains a key the other lacks.
 *   - Overdue work is grouped under a heading that asks for catch-up care,
 *     never one that scolds. The per-row due phrase is `describeRow`'s, so a
 *     task reads identically here, in the text part, in push and in a family
 *     chat.
 *   - Counts are formatted by `Intl.NumberFormat`; nothing here does
 *     `String(n)`.
 */
import type { ReminderLocale } from './reminderEmail.js';

export interface ReminderEmailCopy {
  /** "Water Monstera today" / "Water Monstera". The task label arrives
   *  already capitalized; `today` is true when nothing listed is overdue. */
  titleOne: (task: string, plant: string, today: boolean) => string;
  /** "Water Monstera and 2 more today". `rest` is the TRUE remaining count. */
  titleMany: (task: string, plant: string, rest: string, today: boolean) => string;
  /** When the most urgent plant's name could not be read: "3 plants need
   *  care today". Never names a placeholder plant. */
  titleCount: (count: string, one: boolean, today: boolean) => string;
  /** The verb when a task has no readable label: "Care for Monstera". */
  careVerb: string;
  /** Overdue and unreadable-date rows. Asks, does not scold. */
  headingCatchUp: string;
  headingToday: string;
  headingSoon: string;
  /** Rows whose due date could not be read: an instruction, not a state. */
  headingUnknown: string;
  headingUnclaimed: string;
  unclaimedIntro: string;
  /** The weather lines. */
  headingOutside: string;
  /** The per-row button. The app page is where the task is marked done;
   *  the label says so rather than promising a one-tap that does not exist. */
  markDone: string;
  /** "and 3 more", linking to the task list. */
  andMore: (count: string, one: boolean) => string;
  /** The closing button. */
  seeAll: string;
}

export const REMINDER_EMAIL_COPY: Record<ReminderLocale, ReminderEmailCopy> = {
  en: {
    titleOne: (task, plant, today) => `${task} ${plant}${today ? ' today' : ''}`,
    titleMany: (task, plant, rest, today) =>
      `${task} ${plant} and ${rest} more${today ? ' today' : ''}`,
    titleCount: (count, one, today) =>
      one
        ? `1 plant needs care${today ? ' today' : ''}`
        : `${count} plants need care${today ? ' today' : ''}`,
    careVerb: 'Care for',
    headingCatchUp: 'Ready for some catch-up care',
    headingToday: 'Due today',
    headingSoon: 'Coming up',
    headingUnknown: 'Check the due date',
    headingUnclaimed: 'Up for grabs',
    unclaimedIntro: 'Nobody has claimed these yet, so anyone in the household can take them.',
    headingOutside: 'Outside today',
    markDone: 'Mark done in the app',
    andMore: (count, one) => (one ? 'and 1 more' : `and ${count} more`),
    seeAll: 'See all tasks',
  },
  es: {
    titleOne: (task, plant, today) => `${task} ${plant}${today ? ' hoy' : ''}`,
    titleMany: (task, plant, rest, today) => `${task} ${plant} y ${rest} más${today ? ' hoy' : ''}`,
    titleCount: (count, one, today) =>
      one
        ? `1 planta necesita cuidados${today ? ' hoy' : ''}`
        : `${count} plantas necesitan cuidados${today ? ' hoy' : ''}`,
    careVerb: 'Cuidar',
    headingCatchUp: 'Listas para ponerse al día',
    headingToday: 'Para hoy',
    headingSoon: 'Próximas',
    headingUnknown: 'Revisa la fecha',
    headingUnclaimed: 'Sin asignar',
    unclaimedIntro: 'Nadie las ha tomado todavía, así que cualquiera del hogar puede hacerlo.',
    headingOutside: 'Fuera, hoy',
    markDone: 'Marcar como hecha en la app',
    andMore: (count, one) => (one ? 'y 1 más' : `y ${count} más`),
    seeAll: 'Ver todas las tareas',
  },
};

/** "water" → "Water", "regar" → "Regar". Locale-aware for the first letter
 *  only; a household's custom label keeps the rest of its own casing. */
export function capitalizeFirst(value: string, locale: ReminderLocale): string {
  if (!value) return value;
  const [first, ...rest] = value;
  return `${first.toLocaleUpperCase(locale)}${rest.join('')}`;
}
