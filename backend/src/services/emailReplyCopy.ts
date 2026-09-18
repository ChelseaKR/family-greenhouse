/**
 * The words of every email the reply path sends back (#667, ADR 0031), in
 * English and Spanish. Pure: no DynamoDB, no clock beyond what it is handed.
 *
 * Rules this copy holds:
 *
 *   - **Say what changed, and only what changed.** A confirmation lists each
 *     task the reply named with what actually happened to it. A task someone
 *     else already handled is reported as already handled and "nothing
 *     changed" — never as a success (the issue's "`snooze 3d` on an
 *     already-completed task replies with the settled state").
 *   - **Nothing inbound is echoed.** No line of the person's reply, no subject,
 *     no display name reaches these bodies or their subjects. Every value here
 *     comes from our own rows (plant name, task label, due date) or from the
 *     catalog below. The reply cannot be made to say anything we did not write.
 *   - **Say that a computer reads the address**, and where a person is, so a
 *     real question typed into a reply is not silently lost.
 */
import type { ReplyLocale } from './emailReplyTokens.js';

export type TaskOutcome =
  | {
      kind: 'completed';
      number: number;
      plantName: string | null;
      taskLabel: string | null;
      nextDue: string;
    }
  | {
      kind: 'snoozed';
      number: number;
      plantName: string | null;
      taskLabel: string | null;
      days: number;
      nextDue: string;
    }
  | {
      /** The occurrence the reminder named was already completed, snoozed or
       *  rescheduled by the time the reply arrived. Nothing was changed. */
      kind: 'settled';
      number: number;
      plantName: string | null;
      taskLabel: string | null;
      nextDue: string;
    }
  | { kind: 'gone'; number: number };

export type HelpReason = 'unrecognized' | 'which_task' | 'no_such_task';

export interface ReplyEmail {
  subject: string;
  text: string;
}

interface Copy {
  appliedSubject: string;
  unchangedSubject: string;
  completed: (row: string, due: string) => string;
  snoozed: (row: string, days: string, dayWord: string, due: string) => string;
  settled: (row: string, due: string) => string;
  gone: (n: string) => string;
  dayOne: string;
  dayOther: string;
  unnamedPlant: string;
  unnamedTask: string;
  unreadableDate: string;
  seeAll: (url: string) => string;
  robot: (support: string | null) => string;

  helpSubject: string;
  helpLead: Record<HelpReason, (count: string) => string>;
  helpSyntaxOne: string[];
  helpSyntaxMany: string[];
  helpOnce: string;

  expiredSubject: string;
  expiredBody: (days: string, url: string) => string;

  unverifiedSubject: string;
  unverifiedBody: (url: string) => string;
}

const COPY: Record<ReplyLocale, Copy> = {
  en: {
    appliedSubject: 'Updated from your reply',
    unchangedSubject: 'No changes from your reply',
    completed: (row, due) => `${row}: marked done. Next due ${due}.`,
    snoozed: (row, days, dayWord, due) => `${row}: snoozed ${days} ${dayWord}. Now due ${due}.`,
    settled: (row, due) =>
      `${row}: already taken care of since your reminder, and next due ${due}. Nothing changed.`,
    gone: (n) => `${n}. This task no longer exists. Nothing changed.`,
    dayOne: 'day',
    dayOther: 'days',
    unnamedPlant: "a plant whose name we couldn't load",
    unnamedTask: 'unnamed care task',
    unreadableDate: 'on a date we could not read',
    seeAll: (url) => `Everything is in the app: ${url}`,
    robot: (support) =>
      support
        ? `This address is read by a computer, not a person. To reach a person, write to ${support}.`
        : 'This address is read by a computer, not a person.',

    helpSubject: "We couldn't read your reply",
    helpLead: {
      unrecognized: () =>
        'Nothing was changed: the first line of your reply is not one of the commands we understand.',
      which_task: (count) =>
        `Nothing was changed: your reminder listed ${count} tasks, so the reply needs to say which ones.`,
      no_such_task: (count) =>
        `Nothing was changed: your reminder listed ${count} tasks, and the reply named a number that is not one of them.`,
    },
    helpSyntaxOne: [
      'Reply with one of these on the first line:',
      '  done',
      '  snooze',
      '  snooze 3 days',
    ],
    helpSyntaxMany: [
      'Reply with one of these on the first line, using the numbers from the reminder:',
      '  done 1',
      '  done 1, 2',
      '  snooze 2 for 3 days',
    ],
    helpOnce: 'We send this note once per reminder. Only the first line of a reply is read.',

    expiredSubject: 'This reply address has expired',
    expiredBody: (days, url) =>
      `Replies to a reminder work for ${days} days, and this one has expired, so nothing was changed. Reply to your next reminder, or mark the care done in the app: ${url}`,

    unverifiedSubject: "We couldn't confirm that reply came from you",
    unverifiedBody: (url) =>
      `We received a reply to your plant care reminder, but your email provider did not confirm that it came from your address, so nothing was changed. You can mark the care done in the app: ${url}`,
  },
  es: {
    appliedSubject: 'Actualizado desde tu respuesta',
    unchangedSubject: 'Sin cambios desde tu respuesta',
    completed: (row, due) => `${row}: marcada como hecha. Próxima vez: ${due}.`,
    snoozed: (row, days, dayWord, due) =>
      `${row}: pospuesta ${days} ${dayWord}. Ahora toca: ${due}.`,
    settled: (row, due) =>
      `${row}: ya se había atendido después de tu recordatorio, y la próxima vez es ${due}. No se cambió nada.`,
    gone: (n) => `${n}. Esta tarea ya no existe. No se cambió nada.`,
    dayOne: 'día',
    dayOther: 'días',
    unnamedPlant: 'una planta cuyo nombre no pudimos cargar',
    unnamedTask: 'tarea de cuidado sin nombre',
    unreadableDate: 'en una fecha que no pudimos leer',
    seeAll: (url) => `Todo está en la aplicación: ${url}`,
    robot: (support) =>
      support
        ? `Esta dirección la lee un ordenador, no una persona. Para hablar con una persona, escribe a ${support}.`
        : 'Esta dirección la lee un ordenador, no una persona.',

    helpSubject: 'No pudimos leer tu respuesta',
    helpLead: {
      unrecognized: () =>
        'No se cambió nada: la primera línea de tu respuesta no es una de las órdenes que entendemos.',
      which_task: (count) =>
        `No se cambió nada: tu recordatorio tenía ${count} tareas, así que la respuesta tiene que decir cuáles.`,
      no_such_task: (count) =>
        `No se cambió nada: tu recordatorio tenía ${count} tareas y la respuesta nombró un número que no es de ninguna.`,
    },
    helpSyntaxOne: [
      'Responde con una de estas en la primera línea:',
      '  hecho',
      '  posponer',
      '  posponer 3 días',
    ],
    helpSyntaxMany: [
      'Responde con una de estas en la primera línea, con los números del recordatorio:',
      '  hecho 1',
      '  hecho 1, 2',
      '  posponer 2 por 3 días',
    ],
    helpOnce:
      'Enviamos esta nota una sola vez por recordatorio. Solo leemos la primera línea de cada respuesta.',

    expiredSubject: 'Esta dirección de respuesta ha caducado',
    expiredBody: (days, url) =>
      `Las respuestas a un recordatorio funcionan durante ${days} días y esta ha caducado, así que no se cambió nada. Responde a tu próximo recordatorio o marca el cuidado como hecho en la aplicación: ${url}`,

    unverifiedSubject: 'No pudimos confirmar que la respuesta era tuya',
    unverifiedBody: (url) =>
      `Recibimos una respuesta a tu recordatorio de cuidado de plantas, pero tu proveedor de correo no confirmó que viniera de tu dirección, así que no se cambió nada. Puedes marcar el cuidado como hecho en la aplicación: ${url}`,
  },
};

/** A due date the way a person reads it, in the reminder's zone. */
export function formatDue(iso: string, locale: ReplyLocale, timeZone: string): string | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const options: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(parsed));
  } catch {
    // A corrupt stored zone must not lose the confirmation; UTC is stated
    // nowhere, but the day is at most one off, and the app has the exact time.
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(
      new Date(parsed)
    );
  }
}

function rowLabel(
  copy: Copy,
  n: number,
  plantName: string | null,
  taskLabel: string | null
): string {
  return `${n}. ${plantName?.trim() || copy.unnamedPlant} — ${taskLabel?.trim() || copy.unnamedTask}`;
}

export function composeOutcomeReply(input: {
  locale: ReplyLocale;
  timeZone: string;
  outcomes: TaskOutcome[];
  appUrl: string;
  supportAddress: string | null;
}): ReplyEmail {
  const copy = COPY[input.locale];
  const number = new Intl.NumberFormat(input.locale);
  const due = (iso: string) => formatDue(iso, input.locale, input.timeZone) ?? copy.unreadableDate;
  const lines = input.outcomes.map((outcome) => {
    if (outcome.kind === 'gone') return copy.gone(number.format(outcome.number));
    const row = rowLabel(copy, outcome.number, outcome.plantName, outcome.taskLabel);
    switch (outcome.kind) {
      case 'completed':
        return copy.completed(row, due(outcome.nextDue));
      case 'snoozed':
        return copy.snoozed(
          row,
          number.format(outcome.days),
          outcome.days === 1 ? copy.dayOne : copy.dayOther,
          due(outcome.nextDue)
        );
      default:
        return copy.settled(row, due(outcome.nextDue));
    }
  });
  const changed = input.outcomes.some((o) => o.kind === 'completed' || o.kind === 'snoozed');
  return {
    subject: changed ? copy.appliedSubject : copy.unchangedSubject,
    text: [lines.join('\n'), copy.seeAll(input.appUrl), copy.robot(input.supportAddress)].join(
      '\n\n'
    ),
  };
}

export function composeHelpReply(input: {
  locale: ReplyLocale;
  reason: HelpReason;
  taskCount: number;
  supportAddress: string | null;
}): ReplyEmail {
  const copy = COPY[input.locale];
  const count = new Intl.NumberFormat(input.locale).format(input.taskCount);
  const syntax = input.taskCount === 1 ? copy.helpSyntaxOne : copy.helpSyntaxMany;
  return {
    subject: copy.helpSubject,
    text: [
      copy.helpLead[input.reason](count),
      syntax.join('\n'),
      copy.helpOnce,
      copy.robot(input.supportAddress),
    ].join('\n\n'),
  };
}

export function composeExpiredReply(input: {
  locale: ReplyLocale;
  validDays: number;
  appUrl: string;
}): ReplyEmail {
  const copy = COPY[input.locale];
  return {
    subject: copy.expiredSubject,
    text: copy.expiredBody(
      new Intl.NumberFormat(input.locale).format(input.validDays),
      input.appUrl
    ),
  };
}

export function composeUnverifiedReply(input: { locale: ReplyLocale; appUrl: string }): ReplyEmail {
  const copy = COPY[input.locale];
  return { subject: copy.unverifiedSubject, text: copy.unverifiedBody(input.appUrl) };
}

export const __testing = { COPY };
