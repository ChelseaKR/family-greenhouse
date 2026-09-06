/**
 * String catalog for outbound email, English + Spanish.
 *
 * ## Why this is not the frontend catalog
 *
 * `frontend/src/i18n/locales/{en,es}/translation.json` is loaded by i18next in
 * the browser. A Lambda cannot reach it: the backend is a separate npm
 * workspace with its own esbuild bundle, and importing across the boundary
 * would ship the whole app catalog into every email Lambda. So email copy
 * lives here, in the workspace that renders it. ADR 0007 still governs the
 * frontend catalogs; ADR 0021 records this split.
 *
 * The consequence worth stating plainly: **every i18n CI gate scans
 * `frontend/` only**, so none of them sees this file. The guard is
 * `backend/tests/unit/services/email/catalog.test.ts`, which enforces the same
 * three rules the frontend gate does — key parity, placeholder parity, and
 * exactly the CLDR plural categories each locale requires — and runs in the
 * same `npm run verify` chain.
 *
 * ## Plurals
 *
 * Spanish needs a `_many` category that English does not (docs/i18n.md), and
 * the ad-hoc `count === 1 ? 'plant' : 'plants'` ternaries these emails used to
 * carry cannot express it. `tn()` selects with `Intl.PluralRules`, so the
 * catalog declares the categories and the code never hard-codes a rule.
 *
 * ## Numbers and dates
 *
 * Never concatenated. `formatCount` and `formatDaysAgo` route through
 * `Intl.NumberFormat` / `Intl.RelativeTimeFormat` so "1,234" and "hace 11
 * días" come from the platform, per docs/i18n.md.
 */
import { logger } from '../../utils/logger.js';

export type EmailLocale = 'en' | 'es';

export const EMAIL_LOCALES: readonly EmailLocale[] = ['en', 'es'] as const;

export function isEmailLocale(value: unknown): value is EmailLocale {
  return value === 'en' || value === 'es';
}

type Catalog = Record<string, string>;

const en: Catalog = {
  // --- shared footer -------------------------------------------------------
  'footer.reason.household':
    'You are getting this because you are a member of {{household}} on Family Greenhouse.',
  'footer.reason.householdGeneric':
    'You are getting this because you are a member of a household on Family Greenhouse.',
  'footer.reason.welcome':
    'You are getting this because you just created a household on Family Greenhouse.',
  'footer.safety':
    'Family Greenhouse will never ask for your password or payment details by email.',
  'footer.manage': 'Email settings',
  'footer.unsubscribe': 'Unsubscribe from these',

  // --- task-type labels ----------------------------------------------------
  'taskType.water': 'Watering',
  'taskType.fertilize': 'Feeding',
  'taskType.prune': 'Pruning',
  'taskType.repot': 'Repotting',
  'taskType.custom': 'Custom care',

  // --- welcome -------------------------------------------------------------
  'welcome.subject': 'Welcome to Family Greenhouse 🌱',
  'welcome.title': 'Welcome to Family Greenhouse',
  'welcome.preheader': 'Add your first plant — it takes under a minute.',
  'welcome.greeting': 'Hi {{name}},',
  'welcome.greetingGeneric': 'Hi there,',
  'welcome.intro': 'You are all set up. We are glad you are here.',
  'welcome.firstStep':
    'The best first step is to add your first plant. Give it a name, or start from a species suggestion and we will fill in the care details for you.',
  'welcome.cta': 'Add your first plant',
  'welcome.tipsHeading': 'Two things worth knowing',
  'welcome.tip1':
    'Most houseplants would rather be a little too dry than too wet. When in doubt, wait a day and check the soil with your finger.',
  'welcome.tip2':
    'Bright, indirect light suits the widest range of plants — a spot near a window that never gets harsh midday sun is a safe bet.',
  'welcome.guides': 'Not sure where to begin? Our care guides cover the popular plants.',
  'welcome.guidesCta': 'Browse the care guides',
  'welcome.signoff': 'Happy growing — the Family Greenhouse team',

  // --- weekly digest -------------------------------------------------------
  'digest.subject_one': 'Weekly digest: 1 plant could use some care',
  'digest.subject_other': 'Weekly digest: {{count}} plants could use some care',
  'digest.subject.unknown': 'Weekly digest: your household check-in',
  'digest.title': 'Your week in the greenhouse',
  'digest.preheader.grabs_one': '{{count}} task is up for grabs.',
  'digest.preheader.grabs_other': '{{count}} tasks are up for grabs.',
  'digest.preheader.default': 'A short look at what needs a hand this week.',
  'digest.preheader.unknown': 'We could not check every plant this week.',
  'digest.greeting': 'Hi {{name}},',
  'digest.greetingGeneric': 'Hi there,',
  'digest.onTrack_one': 'Good news first: {{count}} of your plants is on track.',
  'digest.onTrack_other': 'Good news first: {{count}} of your plants are on track.',
  'digest.onTrackAll': 'Good news first: every plant in the house is on track.',
  'digest.needHandHeading': 'Could use a hand',
  'digest.upForGrabs': 'Up for grabs',
  'digest.moreWaiting_one': 'And {{count}} more plant is waiting.',
  'digest.moreWaiting_other': 'And {{count}} more plants are waiting.',
  'digest.overdue_one': '{{task}} · {{count}} day overdue',
  'digest.overdue_other': '{{task}} · {{count}} days overdue',
  'digest.dueToday': '{{task}} · due today',
  'digest.dueUnknown': '{{task}} · we could not read this task’s due date',
  'digest.lastCare.by': 'Last done by {{name}} {{when}}.',
  'digest.lastCare.byYou': 'You did this one {{when}}.',
  'digest.lastCare.never': 'No care logged for this plant yet.',
  'digest.lastCare.unavailable': 'Care history could not be loaded for this plant.',
  'digest.assigned.to': '{{name}} usually looks after this one.',
  'digest.assigned.covering': '{{cover}} is covering for {{away}} right now.',
  'digest.assigned.nobody': 'Nobody has claimed this yet.',
  'digest.cta': 'Open Family Greenhouse',
  'digest.weatherHeading': 'Outside this week',
  'digest.weather.unavailable': 'We could not read your local forecast this week.',
  'digest.trendHeading': 'How the week went',
  'digest.trend.up':
    'Your household completed {{now}} tasks in the last seven days, up from {{before}} the week before.',
  'digest.trend.down':
    'Your household completed {{now}} tasks in the last seven days, down from {{before}} the week before.',
  'digest.trend.steady':
    'Your household completed {{now}} tasks in the last seven days — about the same as the week before.',
  'digest.trend.unavailable': 'We could not load your household’s 30-day trend.',
  'digest.driftHeading': 'A schedule worth a tweak',
  'digest.drift.everyDays_one': 'every day',
  'digest.drift.everyDays_other': 'every {{count}} days',
  'digest.drift.line':
    '{{task}}: this actually happens about {{actual}}, but the schedule says {{scheduled}}.',
  'digest.drift.cta': 'Open the plant to match its schedule to reality in one tap.',
  'digest.petHeading': 'Worth knowing',
  'digest.pet.line': '{{plant}} is toxic to {{pets}}, and it lives somewhere they can reach.',
  'digest.pet.cats': 'cats',
  'digest.pet.dogs': 'dogs',
  'digest.pet.both': 'cats and dogs',
  'digest.pet.unavailable': 'We could not check which spaces your pets can reach.',
  'digest.atRisk.unavailable':
    'We could not check which plants need care this week. An empty list below means we did not manage to look — not that everything is fine.',
  'digest.closing': 'A few minutes goes a long way.',

  // --- year recap ----------------------------------------------------------
  'recap.subject': 'Your {{year}} plant care year in review 🌱',
  'recap.title': 'Your {{year}} in the greenhouse',
  'recap.preheader': 'A year of plant care, counted up.',
  'recap.total_one': 'What a year. Your household completed {{count}} plant-care task in {{year}}.',
  'recap.total_other':
    'What a year. Your household completed {{count}} plant-care tasks in {{year}}.',
  'recap.whoHeading': 'Who did the work',
  'recap.memberUnknown': 'A household member',
  'recap.typeHeading': 'By task type',
  'recap.plantsHeading': 'Most pampered plants',
  'recap.plantUnknown': 'A plant we could not look up',
  'recap.plantsUnavailable':
    'We could not load your plant names, so some rows below are unnamed. It does not mean those plants are gone.',
  'recap.count_one': '{{count}} task',
  'recap.count_other': '{{count}} tasks',
  'recap.cta': 'See your year in the app',
  'recap.closing': 'Thanks for keeping things growing — here is to an even greener {{year}}.',

  // --- unsubscribe landing page -------------------------------------------
  'unsub.title': 'Unsubscribe',
  'unsub.category.weekly_digest': 'the weekly digest',
  'unsub.category.year_recap': 'the year in review',
  'unsub.category.pest_alerts': 'pest season heads-ups',
  'unsub.confirmBody':
    'This turns off {{category}}. Your other Family Greenhouse emails are not affected, and you can turn it back on any time in your settings.',
  'unsub.confirmButton': 'Turn these emails off',
  'unsub.doneTitle': 'You are unsubscribed',
  'unsub.doneBody':
    'We have turned off {{category}}. You can turn it back on in your Family Greenhouse settings whenever you like.',
  'unsub.invalidTitle': 'This link no longer works',
  'unsub.invalidBody':
    'Unsubscribe links expire, and they stop working once your email settings change. You can turn these emails off in your Family Greenhouse settings instead.',
  'unsub.errorTitle': 'We could not do that right now',
  'unsub.errorBody':
    'Something on our side is not responding, so nothing has been changed. Please try again in a few minutes, or change your email settings in the app.',
  'unsub.settingsLink': 'Open your email settings',
};

const es: Catalog = {
  // --- shared footer -------------------------------------------------------
  'footer.reason.household':
    'Recibes este correo porque formas parte de {{household}} en Family Greenhouse.',
  'footer.reason.householdGeneric':
    'Recibes este correo porque formas parte de un hogar en Family Greenhouse.',
  'footer.reason.welcome':
    'Recibes este correo porque acabas de crear un hogar en Family Greenhouse.',
  'footer.safety':
    'Family Greenhouse nunca te pedirá tu contraseña ni tus datos de pago por correo.',
  'footer.manage': 'Ajustes de correo',
  'footer.unsubscribe': 'Darse de baja',

  // --- task-type labels ----------------------------------------------------
  'taskType.water': 'Riego',
  'taskType.fertilize': 'Abono',
  'taskType.prune': 'Poda',
  'taskType.repot': 'Trasplante',
  'taskType.custom': 'Cuidado personalizado',

  // --- welcome -------------------------------------------------------------
  'welcome.subject': 'Te damos la bienvenida a Family Greenhouse 🌱',
  'welcome.title': 'Te damos la bienvenida a Family Greenhouse',
  'welcome.preheader': 'Añade tu primera planta: se tarda menos de un minuto.',
  'welcome.greeting': 'Hola {{name}}:',
  'welcome.greetingGeneric': 'Hola:',
  'welcome.intro': 'Ya está todo listo. Nos alegra tenerte por aquí.',
  'welcome.firstStep':
    'El mejor primer paso es añadir tu primera planta. Ponle un nombre, o parte de una especie sugerida y nosotros completamos los cuidados por ti.',
  'welcome.cta': 'Añadir mi primera planta',
  'welcome.tipsHeading': 'Dos cosas que conviene saber',
  'welcome.tip1':
    'Casi todas las plantas de interior prefieren quedarse algo secas antes que encharcadas. Ante la duda, espera un día y comprueba la tierra con el dedo.',
  'welcome.tip2':
    'La luz brillante e indirecta le sienta bien a la mayoría de plantas: un sitio cerca de una ventana que no reciba el sol fuerte del mediodía es una apuesta segura.',
  'welcome.guides':
    '¿No sabes por dónde empezar? Nuestras guías de cuidados cubren las plantas más comunes.',
  'welcome.guidesCta': 'Ver las guías de cuidados',
  'welcome.signoff': 'Feliz cultivo: el equipo de Family Greenhouse',

  // --- weekly digest -------------------------------------------------------
  'digest.subject_one': 'Resumen semanal: 1 planta necesita cuidados',
  'digest.subject_many': 'Resumen semanal: {{count}} plantas necesitan cuidados',
  'digest.subject_other': 'Resumen semanal: {{count}} plantas necesitan cuidados',
  'digest.subject.unknown': 'Resumen semanal: cómo va tu hogar',
  'digest.title': 'Tu semana en el invernadero',
  'digest.preheader.grabs_one': '{{count}} tarea está libre para quien la quiera.',
  'digest.preheader.grabs_many': '{{count}} tareas están libres para quien las quiera.',
  'digest.preheader.grabs_other': '{{count}} tareas están libres para quien las quiera.',
  'digest.preheader.default': 'Un vistazo rápido a lo que necesita una mano esta semana.',
  'digest.preheader.unknown': 'Esta semana no pudimos revisar todas las plantas.',
  'digest.greeting': 'Hola {{name}}:',
  'digest.greetingGeneric': 'Hola:',
  'digest.onTrack_one': 'Empecemos por lo bueno: {{count}} de tus plantas va al día.',
  'digest.onTrack_many': 'Empecemos por lo bueno: {{count}} de tus plantas van al día.',
  'digest.onTrack_other': 'Empecemos por lo bueno: {{count}} de tus plantas van al día.',
  'digest.onTrackAll': 'Empecemos por lo bueno: todas las plantas de la casa van al día.',
  'digest.needHandHeading': 'Necesitan una mano',
  'digest.upForGrabs': 'Libre',
  'digest.moreWaiting_one': 'Y {{count}} planta más está esperando.',
  'digest.moreWaiting_many': 'Y {{count}} plantas más están esperando.',
  'digest.moreWaiting_other': 'Y {{count}} plantas más están esperando.',
  'digest.overdue_one': '{{task}} · {{count}} día de retraso',
  'digest.overdue_many': '{{task}} · {{count}} días de retraso',
  'digest.overdue_other': '{{task}} · {{count}} días de retraso',
  'digest.dueToday': '{{task}} · toca hoy',
  'digest.dueUnknown': '{{task}} · no pudimos leer la fecha de esta tarea',
  'digest.lastCare.by': 'La última vez la hizo {{name}} {{when}}.',
  'digest.lastCare.byYou': 'Esta la hiciste tú {{when}}.',
  'digest.lastCare.never': 'Todavía no hay cuidados registrados para esta planta.',
  'digest.lastCare.unavailable': 'No pudimos cargar el historial de cuidados de esta planta.',
  'digest.assigned.to': 'Normalmente se encarga {{name}}.',
  'digest.assigned.covering': 'Ahora mismo {{cover}} está cubriendo a {{away}}.',
  'digest.assigned.nobody': 'Todavía nadie la ha cogido.',
  'digest.cta': 'Abrir Family Greenhouse',
  'digest.weatherHeading': 'Fuera, esta semana',
  'digest.weather.unavailable': 'Esta semana no pudimos consultar la previsión de tu zona.',
  'digest.trendHeading': 'Cómo ha ido la semana',
  'digest.trend.up':
    'Tu hogar completó {{now}} tareas en los últimos siete días, frente a {{before}} la semana anterior.',
  'digest.trend.down':
    'Tu hogar completó {{now}} tareas en los últimos siete días, por debajo de las {{before}} de la semana anterior.',
  'digest.trend.steady':
    'Tu hogar completó {{now}} tareas en los últimos siete días, más o menos como la semana anterior.',
  'digest.trend.unavailable': 'No pudimos cargar la tendencia de los últimos 30 días de tu hogar.',
  'digest.driftHeading': 'Un calendario que conviene ajustar',
  'digest.drift.everyDays_one': 'cada día',
  'digest.drift.everyDays_many': 'cada {{count}} días',
  'digest.drift.everyDays_other': 'cada {{count}} días',
  'digest.drift.line':
    '{{task}}: en la práctica se hace {{actual}}, pero el calendario dice {{scheduled}}.',
  'digest.drift.cta': 'Abre la planta para ajustar su calendario a la realidad con un toque.',
  'digest.petHeading': 'Conviene saberlo',
  'digest.pet.line': '{{plant}} es tóxica para {{pets}} y está en un sitio a su alcance.',
  'digest.pet.cats': 'los gatos',
  'digest.pet.dogs': 'los perros',
  'digest.pet.both': 'los gatos y los perros',
  'digest.pet.unavailable': 'No pudimos comprobar a qué espacios llegan tus mascotas.',
  'digest.atRisk.unavailable':
    'Esta semana no pudimos comprobar qué plantas necesitan cuidados. Si la lista de abajo está vacía es que no logramos mirar, no que todo esté bien.',
  'digest.closing': 'Unos minutos marcan la diferencia.',

  // --- year recap ----------------------------------------------------------
  'recap.subject': 'Tu año {{year}} de cuidado de plantas 🌱',
  'recap.title': 'Tu {{year}} en el invernadero',
  'recap.preheader': 'Un año de cuidados, en números.',
  'recap.total_one': 'Vaya año. Tu hogar completó {{count}} tarea de cuidados en {{year}}.',
  'recap.total_many': 'Vaya año. Tu hogar completó {{count}} tareas de cuidados en {{year}}.',
  'recap.total_other': 'Vaya año. Tu hogar completó {{count}} tareas de cuidados en {{year}}.',
  'recap.whoHeading': 'Quién hizo el trabajo',
  'recap.memberUnknown': 'Alguien del hogar',
  'recap.typeHeading': 'Por tipo de tarea',
  'recap.plantsHeading': 'Las plantas más mimadas',
  'recap.plantUnknown': 'Una planta que no pudimos consultar',
  'recap.plantsUnavailable':
    'No pudimos cargar los nombres de tus plantas, así que algunas filas salen sin nombre. No significa que esas plantas ya no estén.',
  'recap.count_one': '{{count}} tarea',
  'recap.count_many': '{{count}} tareas',
  'recap.count_other': '{{count}} tareas',
  'recap.cta': 'Ver tu año en la app',
  'recap.closing': 'Gracias por seguir cultivando: por un {{year}} aún más verde.',

  // --- unsubscribe landing page -------------------------------------------
  'unsub.title': 'Darse de baja',
  'unsub.category.weekly_digest': 'el resumen semanal',
  'unsub.category.year_recap': 'el resumen del año',
  'unsub.category.pest_alerts': 'los avisos de plagas',
  'unsub.confirmBody':
    'Esto desactiva {{category}}. El resto de correos de Family Greenhouse no cambian, y puedes volver a activarlo cuando quieras desde tus ajustes.',
  'unsub.confirmButton': 'Desactivar estos correos',
  'unsub.doneTitle': 'Te has dado de baja',
  'unsub.doneBody':
    'Hemos desactivado {{category}}. Puedes volver a activarlo cuando quieras desde los ajustes de Family Greenhouse.',
  'unsub.invalidTitle': 'Este enlace ya no funciona',
  'unsub.invalidBody':
    'Los enlaces para darse de baja caducan, y dejan de funcionar en cuanto cambian tus ajustes de correo. Puedes desactivar estos correos desde los ajustes de Family Greenhouse.',
  'unsub.errorTitle': 'Ahora mismo no hemos podido hacerlo',
  'unsub.errorBody':
    'Algo no responde por nuestra parte, así que no hemos cambiado nada. Inténtalo de nuevo en unos minutos, o cambia tus ajustes de correo en la aplicación.',
  'unsub.settingsLink': 'Abrir tus ajustes de correo',
};

const CATALOGS: Record<EmailLocale, Catalog> = { en, es };

/** Exposed for the parity test; not part of the rendering API. */
export const __catalogs = CATALOGS;

export type Vars = Record<string, string | number>;

function interpolate(template: string, vars: Vars | undefined): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  );
}

/**
 * Look up a non-plural key. A missing key is a bug the catalog parity test
 * exists to prevent, so at runtime we log it loudly and return the key —
 * never an empty string, which would silently drop a line from a household's
 * email with nothing to notice.
 */
export function t(locale: EmailLocale, key: string, vars?: Vars): string {
  const value = CATALOGS[locale][key] ?? CATALOGS.en[key];
  if (value === undefined) {
    logger.error({ key, locale, msg: 'email_catalog.missing_key' }, 'email_catalog.missing_key');
    return key;
  }
  return interpolate(value, vars);
}

/**
 * Look up a plural key, selecting the CLDR category with `Intl.PluralRules`
 * and passing `count` through as a locale-formatted `{{count}}`.
 */
export function tn(locale: EmailLocale, key: string, count: number, vars?: Vars): string {
  const category = new Intl.PluralRules(locale).select(count);
  const catalog = CATALOGS[locale];
  const value =
    catalog[`${key}_${category}`] ??
    catalog[`${key}_other`] ??
    CATALOGS.en[`${key}_${category}`] ??
    CATALOGS.en[`${key}_other`];
  if (value === undefined) {
    logger.error({ key, locale, msg: 'email_catalog.missing_key' }, 'email_catalog.missing_key');
    return key;
  }
  return interpolate(value, { count: formatCount(locale, count), ...vars });
}

/** Locale-formatted integer. Never `String(n)` — see docs/i18n.md. */
export function formatCount(locale: EmailLocale, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * A calendar year. Still `Intl`, but with grouping off: a year is an
 * identifier, not a quantity, and `formatCount` renders 2025 as "2,025".
 */
export function formatYear(locale: EmailLocale, year: number): string {
  return new Intl.NumberFormat(locale, { useGrouping: false }).format(year);
}

/**
 * "11 days ago" / "hace 11 días", or "yesterday" / "ayer" and "today" / "hoy"
 * where the locale has a word for it. `Intl.RelativeTimeFormat` owns the
 * grammar so no template has to.
 */
export function formatDaysAgo(locale: EmailLocale, days: number): string {
  const whole = Number.isFinite(days) ? Math.max(0, Math.round(days)) : 0;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-whole, 'day');
}
