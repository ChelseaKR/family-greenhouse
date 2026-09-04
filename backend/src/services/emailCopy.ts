/**
 * Localized plain-text copy for the household emails.
 *
 * Why this file exists at all: `docs/i18n.md` describes a frontend-only
 * catalog (`frontend/src/i18n/locales/{en,es}`), loaded by i18next in the
 * browser. Nothing in `backend/src` can reach it, so every email the product
 * sends today is hardcoded English — including for the users who run the whole
 * UI in Spanish. The household emails added alongside this file are the first
 * mail in the product written in both languages, so they carry their own
 * catalog here rather than shipping English-only and calling it a follow-up.
 *
 * Shape rules this module follows, all of them consequences of bugs the email
 * audit found in the existing composers:
 *
 *   - **Pluralization is per-language, not a ternary.** `composeDigestEmail`
 *     bakes English grammar into logic (`total === 1 ? 'plant' : 'plants'`),
 *     which Spanish cannot express. Each locale owns its own phrase builders.
 *   - **Dates and numbers go through `Intl`,** never string concatenation —
 *     the rule `docs/i18n.md` states and the email layer has been violating
 *     because the i18n gate only scans `frontend/`.
 *   - **A value we could not read is `null`, and `null` renders as an
 *     acknowledged unknown,** never as a plausible fact. The recap's
 *     `plantNames.get(id) ?? 'A former plant'` and the reminder's
 *     `?? 'a housemate'` both announce a failed lookup as a truth about a
 *     plant's lifecycle or a person's name. Nothing here does that: an
 *     unnamed person is described as unnamed, with a link to the surface that
 *     knows.
 *
 * Everything in this file is pure so the copy can be asserted in unit tests
 * without reaching SES.
 */

/** Languages the product ships. Mirrors the frontend catalog set. */
export const EMAIL_LOCALES = ['en', 'es'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'en';

export interface ComposedEmail {
  subject: string;
  text: string;
}

/** Coerce arbitrary input (a request body field, a stored preference) to a
 *  supported locale. Anything unrecognised falls back to the product default;
 *  an unsupported language is not a failed read, it is an unsupported
 *  language. */
export function normalizeEmailLocale(value: unknown): EmailLocale {
  if (typeof value !== 'string') return DEFAULT_EMAIL_LOCALE;
  const tag = value.trim().toLowerCase().split(/[-_]/)[0];
  return (EMAIL_LOCALES as readonly string[]).includes(tag)
    ? (tag as EmailLocale)
    : DEFAULT_EMAIL_LOCALE;
}

/**
 * The locale to write a member's email in.
 *
 * `NotificationPreferences` has no `locale` field on main today — the audit's
 * finding was that "there is no field an email composer could read even if it
 * wanted to". A parallel branch (`feat/useful-emails`) adds one. This reads it
 * structurally so that the day the field lands, every household email switches
 * language with no change here; until then every caller gets the default.
 * Deliberately not a `notificationPrefs` edit: that file is being changed on
 * the other branch and a duplicate field would collide.
 */
export function preferredEmailLocale(prefs: unknown): EmailLocale {
  if (prefs && typeof prefs === 'object' && 'locale' in prefs) {
    return normalizeEmailLocale((prefs as { locale?: unknown }).locale);
  }
  return DEFAULT_EMAIL_LOCALE;
}

// ---------------------------------------------------------------------------
// Formatting primitives
// ---------------------------------------------------------------------------

/** A calendar date in the recipient's language. `timeZone: 'UTC'` keeps the
 *  rendered day stable regardless of where the Lambda runs; these are
 *  day-granularity facts (an invite expiry, a vacation window), not instants. */
export function formatDate(iso: string, locale: EmailLocale): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(ms));
}

function formatNumber(value: number, locale: EmailLocale): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** Whole days `iso` is in the past, or null when the date is unusable.
 *  The digest renders `waiting NaN days for some care` because it does this
 *  arithmetic without the guard. */
export function daysOverdue(iso: string, now: Date): number | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const days = Math.floor((now.getTime() - ms) / 86_400_000);
  return Number.isFinite(days) ? Math.max(0, days) : null;
}

/** "a, b and c" / "a, b y c". */
function joinNames(names: string[], locale: EmailLocale): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
}

// ---------------------------------------------------------------------------
// Task labels
// ---------------------------------------------------------------------------

const TASK_LABELS: Record<EmailLocale, Record<string, string>> = {
  en: {
    water: 'water',
    fertilize: 'fertilize',
    prune: 'prune',
    repot: 'repot',
  },
  es: {
    water: 'regar',
    fertilize: 'abonar',
    prune: 'podar',
    repot: 'trasplantar',
  },
};

/** Generic label for a custom task whose `customType` is missing. The digest
 *  prints the literal string `custom` here — a missing label rendered as a
 *  real one. This says "a care task", which is true of every task. */
const UNNAMED_TASK_LABEL: Record<EmailLocale, string> = {
  en: 'a care task',
  es: 'una tarea de cuidado',
};

/**
 * Human label for a task. A custom task uses the household's own wording
 * verbatim (it is user-authored, not translatable); a custom task with no
 * wording gets the generic label rather than the internal enum value.
 */
export function taskLabel(
  task: { type: string; customType?: string | null },
  locale: EmailLocale
): string {
  if (task.type === 'custom') {
    const custom = task.customType?.trim();
    return custom ? custom : UNNAMED_TASK_LABEL[locale];
  }
  return TASK_LABELS[locale][task.type] ?? UNNAMED_TASK_LABEL[locale];
}

// ---------------------------------------------------------------------------
// Shared footer
// ---------------------------------------------------------------------------

/**
 * Every household email ends the same way: what it was, and the one link that
 * turns it off. The audit's finding — *"our emails have no unsubscribe link
 * today, which is a gap we'd rather name than hide"* — is quoted from the
 * product's own help copy. These emails do not repeat it.
 *
 * A `List-Unsubscribe` header needs `SendEmailCommand` to become the v2 API,
 * which is `emailNotifier.ts` and belongs to the branch rewriting it; an
 * in-body link is what this branch can ship without touching that file.
 */
function footer(settingsUrl: string, reason: string, locale: EmailLocale): string[] {
  return locale === 'es'
    ? ['', '—', reason, `Elige qué correos recibes: ${settingsUrl}`]
    : ['', '—', reason, `Choose which emails you get: ${settingsUrl}`];
}

// ---------------------------------------------------------------------------
// 1. Invite
// ---------------------------------------------------------------------------

export interface InviteCopyInput {
  /** Required. An invite that cannot name its sender is not sent — see
   *  `inviteEmail.sendInviteEmail`. */
  inviterName: string;
  householdName: string;
  joinUrl: string;
  /** ISO timestamp the invite code stops working. */
  expiresAt: string;
}

export function composeInviteEmail(input: InviteCopyInput, locale: EmailLocale): ComposedEmail {
  const expires = formatDate(input.expiresAt, locale);
  if (locale === 'es') {
    return {
      subject: `${input.inviterName} te invita a cuidar las plantas de ${input.householdName}`,
      text: [
        'Hola:',
        '',
        `${input.inviterName} te ha invitado a unirte a "${input.householdName}" en`,
        'Family Greenhouse, una app donde quienes comparten casa cuidan las plantas',
        'juntas: cada planta tiene su calendario de riego y abono, los recordatorios',
        'llegan a quien corresponde, y el historial queda a la vista de todo el mundo.',
        '',
        'Si aceptas, verás las plantas de ese hogar y su historial de cuidados, podrás',
        'marcar tareas como hechas y el resto del hogar verá lo que hagas. No compartes',
        'nada de tus otros hogares, y puedes salir cuando quieras.',
        '',
        `Acepta la invitación: ${input.joinUrl}`,
        '',
        expires
          ? `El enlace caduca el ${expires}. Después habrá que pedir otro.`
          : 'El enlace caduca a los siete días. Después habrá que pedir otro.',
        '',
        `Si no conoces a ${input.inviterName}, ignora este correo: sin abrir el enlace no`,
        'ocurre nada y no volveremos a escribirte.',
        '',
        'Un saludo,',
        'Family Greenhouse',
      ].join('\n'),
    };
  }
  return {
    subject: `${input.inviterName} invited you to help care for ${input.householdName}'s plants`,
    text: [
      'Hi,',
      '',
      `${input.inviterName} invited you to join "${input.householdName}" on Family`,
      'Greenhouse — an app where the people who share a home share the plant care:',
      'each plant has its own watering and feeding schedule, reminders go to whoever',
      'the task belongs to, and everyone can see what has already been done.',
      '',
      "If you accept, you'll see that household's plants and their care history, you",
      'can mark tasks done, and the rest of the household will see what you do. None',
      'of your other households are shared, and you can leave whenever you like.',
      '',
      `Accept the invitation: ${input.joinUrl}`,
      '',
      expires
        ? `The link stops working on ${expires}. After that you'd need a new one.`
        : "The link stops working after seven days. After that you'd need a new one.",
      '',
      `If you don't know ${input.inviterName}, you can ignore this email — nothing`,
      "happens unless you open the link, and we won't write again.",
      '',
      'Warmly,',
      'Family Greenhouse',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// 2. Someone joined
// ---------------------------------------------------------------------------

export interface MemberJoinedCopyInput {
  /** null = the member row could not be read. Never substituted with a name. */
  memberName: string | null;
  householdName: string | null;
  /** True when this recipient is the person whose invite was accepted. */
  recipientSentTheInvite: boolean;
  householdUrl: string;
  settingsUrl: string;
}

export function composeMemberJoinedEmail(
  input: MemberJoinedCopyInput,
  locale: EmailLocale
): ComposedEmail {
  const es = locale === 'es';
  const home = input.householdName;
  if (es) {
    const subject = input.memberName
      ? home
        ? `${input.memberName} se ha unido a ${home}`
        : `${input.memberName} se ha unido a tu hogar`
      : 'Alguien se ha unido a tu hogar';
    const lines = [
      input.memberName
        ? `${input.memberName} ha aceptado la invitación y ya forma parte de ${home ?? 'tu hogar'}.`
        : `Alguien ha aceptado una invitación y ya forma parte de ${home ?? 'tu hogar'}. No hemos podido leer su nombre; la lista de miembros lo tiene.`,
      '',
    ];
    if (input.recipientSentTheInvite) {
      lines.push(
        'Tú enviaste esa invitación. Gracias por hacer del cuidado de las plantas algo compartido.',
        ''
      );
    }
    lines.push(
      'Ya puede ver las plantas del hogar, marcar tareas como hechas y recibir',
      'recordatorios de lo que se le asigne.',
      '',
      `Miembros del hogar: ${input.householdUrl}`,
      ...footer(input.settingsUrl, 'Recibes este correo porque alguien se unió a tu hogar.', locale)
    );
    return { subject, text: lines.join('\n') };
  }
  const subject = input.memberName
    ? home
      ? `${input.memberName} joined ${home}`
      : `${input.memberName} joined your household`
    : 'Someone joined your household';
  const lines = [
    input.memberName
      ? `${input.memberName} accepted the invitation and is now part of ${home ?? 'your household'}.`
      : `Someone accepted an invitation and is now part of ${home ?? 'your household'}. We couldn't load their name — the member list has it.`,
    '',
  ];
  if (input.recipientSentTheInvite) {
    lines.push('You sent that invitation. Thanks for making the plant care a shared thing.', '');
  }
  lines.push(
    'They can now see the household plants, mark tasks done, and get reminders for',
    'anything assigned to them.',
    '',
    `Household members: ${input.householdUrl}`,
    ...footer(input.settingsUrl, 'You get this because someone joined your household.', locale)
  );
  return { subject, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// 3. A task is up for grabs
// ---------------------------------------------------------------------------

export interface UpForGrabsTask {
  plantName: string;
  taskLabel: string;
  /** null when `nextDue` was unparseable — the line says "overdue" with no
   *  count rather than "NaN days". */
  daysOverdue: number | null;
  plantUrl: string;
}

export interface UpForGrabsCopyInput {
  householdName: string | null;
  /** The tasks named in the body. */
  tasks: UpForGrabsTask[];
  /** The real number of unclaimed overdue tasks, which may exceed
   *  `tasks.length`. The digest's own docstring records why a listed count
   *  must never become the reported total. */
  totalCount: number;
  claimUrl: string;
  settingsUrl: string;
}

function overdueSuffix(days: number | null, locale: EmailLocale): string {
  if (days === null) return locale === 'es' ? '(atrasada)' : '(overdue)';
  if (days <= 0) return locale === 'es' ? '(para hoy)' : '(due today)';
  if (locale === 'es') {
    return days === 1 ? '(1 día de retraso)' : `(${formatNumber(days, 'es')} días de retraso)`;
  }
  return days === 1 ? '(1 day overdue)' : `(${formatNumber(days, 'en')} days overdue)`;
}

export function composeUpForGrabsEmail(
  input: UpForGrabsCopyInput,
  locale: EmailLocale
): ComposedEmail {
  const es = locale === 'es';
  const listed = input.tasks.map(
    (t) =>
      `  - ${t.plantName} — ${t.taskLabel} ${overdueSuffix(t.daysOverdue, locale)}\n    ${t.plantUrl}`
  );
  const hidden = input.totalCount - input.tasks.length;
  if (es) {
    const subject =
      input.totalCount === 1
        ? 'Una tarea sigue sin dueño'
        : `${formatNumber(input.totalCount, 'es')} tareas siguen sin dueño`;
    const lines = [
      input.totalCount === 1
        ? `Esta tarea de ${input.householdName ?? 'vuestro hogar'} lleva días atrasada y no la ha cogido nadie:`
        : `Estas tareas de ${input.householdName ?? 'vuestro hogar'} llevan días atrasadas y no las ha cogido nadie:`,
      '',
      ...listed,
    ];
    if (hidden > 0) {
      lines.push('', hidden === 1 ? 'Y una más.' : `Y ${formatNumber(hidden, 'es')} más.`);
    }
    lines.push(
      '',
      input.totalCount === 1
        ? 'Si te viene bien, cógela y quien la vea sabrá que ya tiene dueño. Si no, no pasa nada: este correo va a todo el hogar, no solo a ti.'
        : 'Si te viene bien, coge las que puedas y el resto del hogar verá que ya tienen dueño. Si no, no pasa nada: este correo va a todo el hogar, no solo a ti.',
      '',
      `Coger una tarea: ${input.claimUrl}`,
      ...footer(
        input.settingsUrl,
        'Recibes este correo porque hay tareas atrasadas sin asignar en tu hogar.',
        locale
      )
    );
    return { subject, text: lines.join('\n') };
  }
  const subject =
    input.totalCount === 1
      ? 'One task is up for grabs'
      : `${input.totalCount} tasks are up for grabs`;
  const lines = [
    input.totalCount === 1
      ? `This task in ${input.householdName ?? 'your household'} has been overdue for a few days and nobody has picked it up:`
      : `These tasks in ${input.householdName ?? 'your household'} have been overdue for a few days and nobody has picked them up:`,
    '',
    ...listed,
  ];
  if (hidden > 0) {
    lines.push('', hidden === 1 ? 'And one more.' : `And ${hidden} more.`);
  }
  lines.push(
    '',
    input.totalCount === 1
      ? "If it suits you, claim it and everyone else will see it has a name on it. If not, that's fine — this went to the whole household, not just you."
      : "If any of them suit you, claim them and everyone else will see they have a name on them. If not, that's fine — this went to the whole household, not just you.",
    '',
    `Claim a task: ${input.claimUrl}`,
    ...footer(
      input.settingsUrl,
      'You get this because your household has overdue tasks nobody is assigned to.',
      locale
    )
  );
  return { subject, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// 4. You're covering while someone is away
// ---------------------------------------------------------------------------

export interface CoverageTask {
  plantName: string;
  taskLabel: string;
  /** ISO date the task is next due. */
  dueDate: string;
  plantUrl: string;
}

export interface CoverageCopyInput {
  awayName: string | null;
  householdName: string | null;
  startDate: string;
  endDate: string;
  /**
   * The away member's tasks that fall inside the window.
   *
   * `null` means the task read did not settle — the email says so. An empty
   * ARRAY means the read settled and there genuinely are none, which is real,
   * reassuring information. Collapsing those two into one rendering is the
   * defect class this repo names; they are different sentences here.
   */
  tasks: CoverageTask[] | null;
  tasksUrl: string;
  settingsUrl: string;
}

export function composeCoverageEmail(input: CoverageCopyInput, locale: EmailLocale): ComposedEmail {
  const es = locale === 'es';
  const start = formatDate(input.startDate, locale);
  const end = formatDate(input.endDate, locale);
  const who = input.awayName;

  const listLines = (): string[] => {
    if (input.tasks === null) {
      return es
        ? [
            'No hemos podido cargar la lista de tareas en este momento, así que no la',
            'incluimos aquí en vez de enseñarte una lista incompleta. En la app está al día:',
            `    ${input.tasksUrl}`,
          ]
        : [
            "We couldn't load the task list just now, so we're leaving it out rather than",
            'showing you a partial one. The app has the current version:',
            `    ${input.tasksUrl}`,
          ];
    }
    if (input.tasks.length === 0) {
      return es
        ? [
            'Ahora mismo no hay ninguna tarea suya dentro de esas fechas. Si aparece alguna, te llegará en el recordatorio del día.',
          ]
        : [
            "Right now none of their tasks fall inside those dates. If any appear, they'll show up in your daily reminder.",
          ];
    }
    return [
      es ? 'Lo que hay previsto:' : "Here's what's scheduled:",
      '',
      ...input.tasks.map((t) => {
        const due = formatDate(t.dueDate, locale);
        const when = due ?? (es ? 'fecha no disponible' : 'date unavailable');
        return `  - ${t.plantName} — ${t.taskLabel} · ${when}\n    ${t.plantUrl}`;
      }),
    ];
  };

  if (es) {
    const subject = who
      ? `${who} estará fuera — tú cubres sus plantas`
      : 'Vas a cubrir las plantas de alguien del hogar';
    const range = start && end ? `del ${start} al ${end}` : 'durante su ausencia';
    return {
      subject,
      text: [
        who
          ? `${who} estará fuera ${range} y tú figuras como la persona que cubre sus tareas en ${input.householdName ?? 'vuestro hogar'}.`
          : `Alguien de ${input.householdName ?? 'vuestro hogar'} estará fuera ${range} y tú figuras como la persona que cubre sus tareas. No hemos podido leer su nombre; en la app aparece.`,
        '',
        'Durante esas fechas, sus tareas te llegarán a ti en los recordatorios diarios.',
        'No hace falta que hagas nada ahora: esto es solo para que no te pille por sorpresa.',
        '',
        ...listLines(),
        '',
        `Ver las tareas del hogar: ${input.tasksUrl}`,
        ...footer(
          input.settingsUrl,
          'Recibes este correo porque alguien te ha puesto como cobertura.',
          locale
        ),
      ].join('\n'),
    };
  }
  const subject = who
    ? `${who} is away — you're covering their plants`
    : "You're covering someone's plants while they're away";
  const range = start && end ? `from ${start} to ${end}` : 'while they are away';
  return {
    subject,
    text: [
      who
        ? `${who} is away ${range}, and you're down as the person covering their tasks in ${input.householdName ?? 'your household'}.`
        : `Someone in ${input.householdName ?? 'your household'} is away ${range}, and you're down as the person covering their tasks. We couldn't load their name — the app has it.`,
      '',
      'While those dates are running, their tasks arrive in your daily reminders.',
      "Nothing to do right now — this is just so it doesn't arrive as a surprise.",
      '',
      ...listLines(),
      '',
      `See the household tasks: ${input.tasksUrl}`,
      ...footer(
        input.settingsUrl,
        'You get this because someone named you as their cover.',
        locale
      ),
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// 5. Someone covered for you (credit, not a scoreboard)
// ---------------------------------------------------------------------------

export interface CareCreditItem {
  plantName: string;
  taskLabel: string;
  /** null = we could not read who did it. The line says so; it does not
   *  invent a housemate. */
  actorName: string | null;
  /** The completion note the person left, if any. */
  note: string | null;
  plantUrl: string;
}

export interface CareCreditCopyInput {
  items: CareCreditItem[];
  /** Real events beyond the ones listed. */
  moreCount: number;
  activityUrl: string;
  settingsUrl: string;
}

/**
 * Deliberately absent from this email: any count per person, any ordering by
 * volume, any mention of the recipient's own contribution, and any mention of
 * anyone who did nothing. It names the people who helped and stops.
 * `docs/roadmap.md`'s north star is "share plant care without anyone feeling
 * like a nag"; a message that quantifies is a scoreboard, and a scoreboard
 * nags the person at the bottom of it.
 */
export function composeCareCreditEmail(
  input: CareCreditCopyInput,
  locale: EmailLocale
): ComposedEmail {
  const es = locale === 'es';
  const names = [...new Set(input.items.map((i) => i.actorName).filter((n): n is string => !!n))];
  const someoneUnnamed = input.items.some((i) => i.actorName === null);

  const lines = input.items.map((item) => {
    const note = item.note?.trim();
    const head = item.actorName
      ? `  - ${item.actorName} — ${item.plantName} · ${item.taskLabel}`
      : es
        ? `  - ${item.plantName} · ${item.taskLabel} (no hemos podido leer quién)`
        : `  - ${item.plantName} · ${item.taskLabel} (we couldn't load who)`;
    return note ? `${head}\n    “${note}”\n    ${item.plantUrl}` : `${head}\n    ${item.plantUrl}`;
  });

  if (es) {
    const subject =
      names.length === 0
        ? 'Alguien se ocupó de tus plantas'
        : names.length === 1
          ? `${names[0]} se ocupó de tus plantas`
          : `${joinNames(names, 'es')} se ocuparon de tus plantas`;
    const opener =
      names.length === 0
        ? 'Alguien del hogar hizo tareas que estaban a tu nombre:'
        : names.length === 1
          ? `${names[0]} hizo tareas que estaban a tu nombre:`
          : `${joinNames(names, 'es')} hicieron tareas que estaban a tu nombre:`;
    const body = [opener, '', ...lines];
    if (input.moreCount > 0) {
      body.push(
        '',
        input.moreCount === 1
          ? 'Y una tarea más.'
          : `Y ${formatNumber(input.moreCount, 'es')} tareas más.`
      );
    }
    if (someoneUnnamed && names.length > 0) {
      body.push(
        '',
        'De alguna no hemos podido leer quién la hizo; el historial del hogar sí lo sabe.'
      );
    }
    body.push(
      '',
      'No hay nada que tengas que hacer. Te lo contamos porque merece saberse, no',
      'para pedirte nada: las tareas siguen su calendario normal.',
      '',
      `Ver el historial del hogar: ${input.activityUrl}`,
      ...footer(
        input.settingsUrl,
        'Recibes este correo cuando alguien hace una tarea que estaba a tu nombre.',
        locale
      )
    );
    return { subject, text: body.join('\n') };
  }

  const subject =
    names.length === 0
      ? 'Someone covered a task of yours'
      : names.length === 1
        ? `${names[0]} covered for you`
        : `${joinNames(names, 'en')} covered for you`;
  const opener =
    names.length === 0
      ? 'Someone in your household did tasks that had your name on them:'
      : names.length === 1
        ? `${names[0]} did tasks that had your name on them:`
        : `${joinNames(names, 'en')} did tasks that had your name on them:`;
  const body = [opener, '', ...lines];
  if (input.moreCount > 0) {
    body.push(
      '',
      input.moreCount === 1 ? 'And one more task.' : `And ${input.moreCount} more tasks.`
    );
  }
  if (someoneUnnamed && names.length > 0) {
    body.push('', "We couldn't load who did one of them — the household history knows.");
  }
  body.push(
    '',
    "There's nothing for you to do. We're telling you because it's worth knowing, not",
    'because we want anything back — the schedule carries on as normal.',
    '',
    `See the household history: ${input.activityUrl}`,
    ...footer(
      input.settingsUrl,
      'You get this when someone does a task that had your name on it.',
      locale
    )
  );
  return { subject, text: body.join('\n') };
}
