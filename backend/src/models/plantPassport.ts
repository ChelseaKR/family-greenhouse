/**
 * The plant passport's recipient half (#676): the frozen summary a passport
 * link carries, and the first note an import writes from it.
 *
 * WHY IT IS A SNAPSHOT THE SERVER WRITES, NOT A PAYLOAD A CLIENT SENDS.
 * A passport link reaches someone with no relationship to the household that
 * made it, so nothing on the import path is taken on the recipient's word or
 * the sender's browser's. The summary is derived here, on the server, from the
 * household's own stored records at the moment the link is made, and frozen
 * onto the same 14-day share row a cutting link uses (so revocation, member
 * departure, the trash and account deletion already cover it). The recipient
 * presents only a 128-bit code; the import reads that row and writes into the
 * caller's own household. There is no request field that names a household,
 * a plant, a task or a note.
 *
 * Even so the stored block is treated as untrusted when it is read back: it is
 * parsed with a strict schema (unknown keys refused, every string and list
 * capped), and a block that does not parse is treated as absent, so a
 * corrupted or hand-edited row degrades to a plain cutting card instead of
 * being rendered or written.
 *
 * WHAT NEVER CROSSES. The summary carries the house rule (through the same
 * `resolveCareNote` every public surface uses), task intervals, a count and a
 * date for recent care, and lineage names. It has no field for the plant's
 * private `notes`, a completion's or task's `notes`, who did the care, where
 * the plant sits, an assignee, any id, or any token. There is deliberately no
 * place to put them: the schema is strict, so a field added to the builder
 * without being added here fails the parse rather than leaking.
 *
 * ABSENCES ARE STATED (#599, ADR 0010). A plant with no house rule says so. A
 * care window with nothing in it says whether the plant was added inside the
 * window ("not cared for YET") or is older ("nothing logged in 90 days"). A
 * read that came back full says "at least", never a ceiling presented as a
 * count.
 *
 * INERT UNTIL THE OWNER TURNS IT ON. Terraform `passport_import_enabled` sets
 * PASSPORT_IMPORT_ENABLED=1 on the plants Lambda. Until then every route in
 * this feature answers 404 PASSPORT_IMPORT_DISABLED and no summary is stored.
 */
import { z } from 'zod';
import { SEASONS, type SeasonalCadence } from '../services/seasonalCadence.js';
import type { SpeciesSource } from './types.js';

export function passportImportEnabled(): boolean {
  return process.env.PASSPORT_IMPORT_ENABLED === '1';
}

/** `details.code` on the 404 every route answers while the feature is off. */
export const PASSPORT_IMPORT_DISABLED = 'PASSPORT_IMPORT_DISABLED';
/** `details.code` on the 409 a repeated import of the same passport gets. */
export const PASSPORT_ALREADY_IMPORTED = 'PASSPORT_ALREADY_IMPORTED';

/** How far back the care summary reaches, in days. Matches the printed page. */
export const PASSPORT_WINDOW_DAYS = 90;
/**
 * How many completions are read to build the care summary. Newest first, so a
 * read this full whose oldest entry is still inside the window may have left
 * earlier in-window entries out, and the summary says "at least".
 */
export const PASSPORT_COMPLETIONS_READ = 100;
/** Tasks on the frozen schedule. More than this is stated, not silently cut. */
export const PASSPORT_MAX_SCHEDULE = 10;
/** The first note is a plant note, so it obeys the plant-note cap. */
export const PASSPORT_NOTE_MAX_LENGTH = 1000;

const TASK_TYPES = ['water', 'fertilize', 'prune', 'repot', 'custom'] as const;
const SPECIES_SOURCES = ['user', 'identified', 'catalog'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const interval = z.number().int().min(1).max(365);
const count = (max: number) => z.number().int().min(0).max(max);

/**
 * Every object is `.strict()`: an unknown key is a refusal, not a pass-through.
 * Every string, number and list is capped, and the caps bound the whole: a
 * summary with every field at its maximum serializes to under 3 KB (asserted in
 * the test), so there is no separate size check that could never fire.
 */
export const passportSummarySchema = z
  .object({
    version: z.literal(1),
    speciesSource: z.enum(SPECIES_SOURCES).nullable(),
    /** The day the sharing household added the plant. */
    inHouseholdSince: isoDate,
    schedule: z
      .array(
        z
          .object({
            type: z.enum(TASK_TYPES),
            /** The household's own name for a custom task, as written. */
            customType: z.string().min(1).max(50).nullable(),
            frequency: interval,
            seasonal: z
              .array(z.object({ season: z.enum(SEASONS), frequency: interval }).strict())
              .max(SEASONS.length),
          })
          .strict()
      )
      .max(PASSPORT_MAX_SCHEDULE),
    /** Tasks on the schedule beyond the ones listed above. */
    scheduleMore: count(10_000),
    care: z
      .object({
        windowDays: z.literal(PASSPORT_WINDOW_DAYS),
        loggedInWindow: count(PASSPORT_COMPLETIONS_READ),
        /** The read was full, so `loggedInWindow` is a floor. */
        atLeast: z.boolean(),
        /** The plant was added inside the window: "not cared for yet". */
        addedWithinWindow: z.boolean(),
        /** Newest logged care, when the read reached one. */
        lastLoggedOn: isoDate.nullable(),
      })
      .strict(),
    lineage: z
      .object({
        parentName: z.string().min(1).max(100).nullable(),
        cuttingsTaken: count(10_000),
      })
      .strict(),
  })
  .strict();

export type PassportSummary = z.infer<typeof passportSummarySchema>;

/**
 * Read a stored summary back. Null for anything that is not exactly a
 * summary — absent, malformed, oversize, or carrying a key it should not.
 * Never throws: a bad block is "no passport on this link".
 */
export function parsePassportSummary(raw: unknown): PassportSummary | null {
  if (raw === undefined || raw === null) return null;
  const parsed = passportSummarySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The import route takes no body. `.strict()` refuses every key, which is the
 * point: `householdId`, `plantId`, `notes` or anything else a caller might
 * forge is rejected rather than ignored, so it cannot later be mistaken for
 * input. A missing body is the same as `{}`.
 */
export const passportImportBodySchema = z.preprocess((value) => value ?? {}, z.object({}).strict());

/** The import route's whole body budget. `{}` is two bytes. */
export const PASSPORT_IMPORT_MAX_BODY_BYTES = 1024;

// ---------------------------------------------------------------------------
// Building the summary (pure: the service reads, this shapes)
// ---------------------------------------------------------------------------

export interface PassportSummaryInput {
  plant: { createdAt: string; speciesSource?: SpeciesSource | null };
  tasks: Array<{
    type: (typeof TASK_TYPES)[number];
    customType: string | null;
    frequency: number;
    seasonalCadences?: SeasonalCadence[] | null;
  }>;
  /** Completions as read, newest first. Only `completedAt` is ever looked at. */
  completions: Array<{ completedAt: string }>;
  /** The `limit` the completions were read with. */
  completionsReadLimit: number;
  lineage: { parentName: string | null; cuttingsTaken: number };
  now: Date;
}

/** Collapse whitespace and drop control characters from household free text. */
function cleanText(value: string | null | undefined, max: number): string | null {
  const cleaned = (value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || null;
}

/**
 * Field by field, never a spread: nothing on a plant, task or completion can
 * reach the summary except through a line below.
 */
export function buildPassportSummary(input: PassportSummaryInput): PassportSummary {
  const windowStart = input.now.getTime() - PASSPORT_WINDOW_DAYS * DAY_MS;
  const newestFirst = [...input.completions].sort((a, b) =>
    a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : 0
  );
  const inWindow = newestFirst.filter((c) => new Date(c.completedAt).getTime() >= windowStart);
  const oldestRead = newestFirst.at(-1);
  const atLeast =
    newestFirst.length >= input.completionsReadLimit &&
    oldestRead !== undefined &&
    new Date(oldestRead.completedAt).getTime() >= windowStart;
  const created = new Date(input.plant.createdAt).getTime();

  const listed = input.tasks.slice(0, PASSPORT_MAX_SCHEDULE);
  const summary: PassportSummary = {
    version: 1,
    speciesSource: input.plant.speciesSource ?? null,
    inHouseholdSince: input.plant.createdAt.slice(0, 10),
    schedule: listed.map((task) => ({
      type: task.type,
      customType: task.type === 'custom' ? cleanText(task.customType, 50) : null,
      frequency: task.frequency,
      seasonal: (task.seasonalCadences ?? []).map((c) => ({
        season: c.season,
        frequency: c.frequency,
      })),
    })),
    scheduleMore: Math.max(0, input.tasks.length - listed.length),
    care: {
      windowDays: PASSPORT_WINDOW_DAYS,
      loggedInWindow: Math.min(inWindow.length, PASSPORT_COMPLETIONS_READ),
      atLeast,
      addedWithinWindow: Number.isFinite(created) && created >= windowStart,
      lastLoggedOn: newestFirst[0]?.completedAt.slice(0, 10) ?? null,
    },
    lineage: {
      parentName: cleanText(input.lineage.parentName, 100),
      cuttingsTaken: Math.min(input.lineage.cuttingsTaken, 10_000),
    },
  };
  // The builder's own output must satisfy the schema a reader will hold it to.
  return passportSummarySchema.parse(summary);
}

// ---------------------------------------------------------------------------
// The first note (English + Spanish; the backend cannot load the app catalog)
// ---------------------------------------------------------------------------

export type PassportNoteLocale = 'en' | 'es';

interface NoteCatalog {
  header: string;
  houseRule: string;
  noHouseRule: string;
  speciesUser: string;
  speciesIdentified: string;
  speciesCatalog: string;
  speciesUnknown: string;
  since: string;
  schedule: string;
  noSchedule: string;
  scheduleMore: string;
  everyDay: string;
  everyDays: string;
  seasonal: string;
  taskWater: string;
  taskFertilize: string;
  taskPrune: string;
  taskRepot: string;
  seasons: Record<(typeof SEASONS)[number], string>;
  careOne: string;
  careMany: string;
  careAtLeast: string;
  careLast: string;
  careNoneYoung: string;
  careNoneOld: string;
  careNoneOldLast: string;
  lineage: string;
  parent: string;
  cuttings: string;
  cuttingsOne: string;
  noLineage: string;
}

const NOTE_CATALOG: Record<PassportNoteLocale, NoteCatalog> = {
  en: {
    header: 'Plant passport from {household}, shared on {date}.',
    houseRule: 'House rule: {rule}',
    noHouseRule: 'House rule: none was written for this plant.',
    speciesUser: 'Species as that household recorded it: typed in by them.',
    speciesIdentified:
      'Species as that household recorded it: suggested from a photo, so treat it as a guess.',
    speciesCatalog: 'Species as that household recorded it: picked from the plant catalog.',
    speciesUnknown: 'Species as that household recorded it: how it was recorded is not known.',
    since: 'In that household since {date}.',
    schedule: 'Care schedule: {items}.',
    noSchedule: 'Care schedule: none was set for this plant.',
    scheduleMore: '{items}; and {count} more',
    everyDay: '{task} every day',
    everyDays: '{task} every {n} days',
    seasonal: '{base} ({seasons})',
    taskWater: 'Water',
    taskFertilize: 'Fertilize',
    taskPrune: 'Prune',
    taskRepot: 'Repot',
    seasons: { spring: 'spring', summer: 'summer', autumn: 'autumn', winter: 'winter' },
    careOne: 'Care log: 1 care entry in the last {days} days{last}.',
    careMany: 'Care log: {n} care entries in the last {days} days{last}.',
    careAtLeast: 'Care log: at least {n} care entries in the last {days} days{last}.',
    careLast: ', most recent {date}',
    careNoneYoung: 'Care log: no care has been logged since this plant was added on {date}.',
    careNoneOld: 'Care log: no care was logged in the last {days} days.',
    careNoneOldLast:
      'Care log: no care was logged in the last {days} days. Last logged care: {date}.',
    lineage: 'Lineage: {parts}.',
    parent: 'a cutting of {parent}',
    cuttings: '{n} cuttings have been taken from it',
    cuttingsOne: '1 cutting has been taken from it',
    noLineage: 'Lineage: no parent plant or cuttings are recorded.',
  },
  es: {
    header: 'Pasaporte de planta de {household}, compartido el {date}.',
    houseRule: 'Regla de la casa: {rule}',
    noHouseRule: 'Regla de la casa: no se escribió ninguna para esta planta.',
    speciesUser: 'Especie según ese hogar: la escribieron ellos.',
    speciesIdentified:
      'Especie según ese hogar: sugerida a partir de una foto, así que tómala como una suposición.',
    speciesCatalog: 'Especie según ese hogar: elegida del catálogo de plantas.',
    speciesUnknown: 'Especie según ese hogar: no se sabe cómo se registró.',
    since: 'En ese hogar desde el {date}.',
    schedule: 'Calendario de cuidados: {items}.',
    noSchedule: 'Calendario de cuidados: no se definió ninguno para esta planta.',
    scheduleMore: '{items}; y {count} más',
    everyDay: '{task} cada día',
    everyDays: '{task} cada {n} días',
    seasonal: '{base} ({seasons})',
    taskWater: 'Regar',
    taskFertilize: 'Fertilizar',
    taskPrune: 'Podar',
    taskRepot: 'Trasplantar',
    seasons: { spring: 'primavera', summer: 'verano', autumn: 'otoño', winter: 'invierno' },
    careOne: 'Registro de cuidados: 1 cuidado en los últimos {days} días{last}.',
    careMany: 'Registro de cuidados: {n} cuidados en los últimos {days} días{last}.',
    careAtLeast: 'Registro de cuidados: al menos {n} cuidados en los últimos {days} días{last}.',
    careLast: ', el más reciente el {date}',
    careNoneYoung:
      'Registro de cuidados: no se ha registrado ningún cuidado desde que se añadió esta planta el {date}.',
    careNoneOld: 'Registro de cuidados: no se registró ningún cuidado en los últimos {days} días.',
    careNoneOldLast:
      'Registro de cuidados: no se registró ningún cuidado en los últimos {days} días. Último cuidado registrado: {date}.',
    lineage: 'Linaje: {parts}.',
    parent: 'esqueje de {parent}',
    cuttings: 'se han sacado {n} esquejes de ella',
    cuttingsOne: 'se ha sacado 1 esqueje de ella',
    noLineage: 'Linaje: no hay planta madre ni esquejes registrados.',
  },
};

/** `{name}` placeholders only; anything unmatched is left as written. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole
  );
}

export function isPassportNoteLocale(value: unknown): value is PassportNoteLocale {
  return value === 'en' || value === 'es';
}

/**
 * The first note an import writes, composed from the frozen summary plus the
 * two card fields that travel with it. Deterministic, at most
 * PASSPORT_NOTE_MAX_LENGTH characters, and made only of what the summary and
 * card hold — nothing is generated and nothing is looked up.
 */
export function composePassportNote(input: {
  summary: PassportSummary;
  /** The card's house rule (already resolved by `resolveCareNote`). */
  careRule: string | null;
  /** The card's species, or null. Only its provenance line depends on it. */
  species: string | null;
  householdName: string;
  /** The day the link was made, `YYYY-MM-DD`. */
  sharedOn: string;
  locale: PassportNoteLocale;
}): string {
  const c = NOTE_CATALOG[input.locale];
  const { summary } = input;
  const lines: string[] = [];

  lines.push(
    fill(c.header, {
      household: cleanText(input.householdName, 100) ?? '—',
      date: input.sharedOn,
    })
  );

  const rule = cleanText(input.careRule, 140);
  lines.push(rule ? fill(c.houseRule, { rule }) : c.noHouseRule);

  if (input.species?.trim()) {
    lines.push(
      summary.speciesSource === 'user'
        ? c.speciesUser
        : summary.speciesSource === 'identified'
          ? c.speciesIdentified
          : summary.speciesSource === 'catalog'
            ? c.speciesCatalog
            : c.speciesUnknown
    );
  }

  lines.push(fill(c.since, { date: summary.inHouseholdSince }));

  if (summary.schedule.length === 0) {
    lines.push(c.noSchedule);
  } else {
    const taskLabel = (item: PassportSummary['schedule'][number]): string =>
      item.type === 'custom'
        ? (item.customType ?? '—')
        : item.type === 'water'
          ? c.taskWater
          : item.type === 'fertilize'
            ? c.taskFertilize
            : item.type === 'prune'
              ? c.taskPrune
              : c.taskRepot;
    const every = (task: string, n: number): string =>
      n === 1 ? fill(c.everyDay, { task }) : fill(c.everyDays, { task, n });
    const items = summary.schedule.map((item) => {
      const base = every(taskLabel(item), item.frequency);
      if (item.seasonal.length === 0) return base;
      const seasons = item.seasonal.map((s) => `${c.seasons[s.season]} ${s.frequency}`).join(', ');
      return fill(c.seasonal, { base, seasons });
    });
    const joined = items.join('; ');
    lines.push(
      fill(c.schedule, {
        items:
          summary.scheduleMore > 0
            ? fill(c.scheduleMore, { items: joined, count: summary.scheduleMore })
            : joined,
      })
    );
  }

  const { care } = summary;
  if (care.loggedInWindow > 0) {
    const last = care.lastLoggedOn ? fill(c.careLast, { date: care.lastLoggedOn }) : '';
    const template = care.atLeast
      ? c.careAtLeast
      : care.loggedInWindow === 1
        ? c.careOne
        : c.careMany;
    lines.push(fill(template, { n: care.loggedInWindow, days: care.windowDays, last }));
  } else if (care.addedWithinWindow) {
    lines.push(fill(c.careNoneYoung, { date: summary.inHouseholdSince }));
  } else if (care.lastLoggedOn) {
    lines.push(fill(c.careNoneOldLast, { days: care.windowDays, date: care.lastLoggedOn }));
  } else {
    lines.push(fill(c.careNoneOld, { days: care.windowDays }));
  }

  const { lineage } = summary;
  if (lineage.parentName || lineage.cuttingsTaken > 0) {
    const parts: string[] = [];
    if (lineage.parentName) parts.push(fill(c.parent, { parent: lineage.parentName }));
    if (lineage.cuttingsTaken > 0) {
      parts.push(
        lineage.cuttingsTaken === 1 ? c.cuttingsOne : fill(c.cuttings, { n: lineage.cuttingsTaken })
      );
    }
    lines.push(fill(c.lineage, { parts: parts.join('; ') }));
  } else {
    lines.push(c.noLineage);
  }

  const note = lines.join('\n');
  return note.length <= PASSPORT_NOTE_MAX_LENGTH
    ? note
    : `${note.slice(0, PASSPORT_NOTE_MAX_LENGTH - 1).trimEnd()}…`;
}
