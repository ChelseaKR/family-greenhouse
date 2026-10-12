/**
 * The public token pages must call a task's day what the rest of the app
 * calls it, at every time of day.
 *
 * The bug this pins: the sitter page (/sit/:token) labelled the demo
 * household's due-today watering "Overdue" at 2pm and "Due today" at 4am,
 * while the tasks page and dashboard said "Today" all day. The API rows for
 * the public pages carry a server-computed `overdue` flag, and that flag is
 * the INSTANT rule (`nextDue < now`, ADR 0025): a task due at 09:00 turns
 * "overdue" at 09:01. Every signed-in page reads the calendar day instead
 * (`isOverdue` / `isToday` / `formatDueDate` in `utils/date.ts`), so a task
 * due at 09:00 is today's job until local midnight. The sitter, sitter brief,
 * caretaker, kiosk and plant tag pages all showed the flag; their day counts
 * also rounded elapsed hours, so 23:00 tonight to 09:00 the day after
 * tomorrow (34 hours) read "Due tomorrow".
 *
 * Each case below pins the clock to a local wall time (04:00, 14:00, 23:00),
 * feeds the page the flag exactly as the server computes it, and asserts the
 * page's label matches what the signed-in app's own helpers say for the same
 * instant. The instants are built from local wall-clock fields, so the file
 * means the same thing in any process zone: vitest pins America/New_York, and
 * running it with TZ=America/Los_Angeles, TZ=UTC or TZ=Asia/Kolkata checks
 * the same claims for a Pacific household and for households ahead of UTC.
 *
 * The negative control at the bottom proves the fixtures can tell the two
 * rules apart: if the server flag and the app's day agreed for every case,
 * every assertion here would pass on the broken pages too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { calendarDaysBetween, formatDueDate, isOverdue, isToday } from '@/utils/date';
import { formatDate, formatRelativeDay } from '@/i18n/format';
import { SitPage } from '@/features/sitter/SitPage';
import { SitBriefPage } from '@/features/sitter/SitBriefPage';
import { CaretakerPage } from '@/features/caretaker/CaretakerPage';
import { KioskPage } from '@/features/kiosk/KioskPage';
import { ScanTagPage } from '@/features/tags/ScanTagPage';
import { sitterService } from '@/services/sitterService';
import { caretakerVisitService } from '@/services/caretakerVisitService';
import { kioskService } from '@/services/kioskService';
import { publicTagService } from '@/services/plantTagService';

vi.mock('@/services/sitterService', async () => {
  const actual = await vi.importActual<typeof import('@/services/sitterService')>(
    '@/services/sitterService'
  );
  return {
    ...actual,
    sitterService: { getView: vi.fn(), getBrief: vi.fn(), completeTask: vi.fn() },
  };
});
vi.mock('@/services/caretakerVisitService', async () => {
  const actual = await vi.importActual<typeof import('@/services/caretakerVisitService')>(
    '@/services/caretakerVisitService'
  );
  return {
    ...actual,
    caretakerVisitService: {
      getView: vi.fn(),
      completeTask: vi.fn(),
      addNote: vi.fn(),
      addPhoto: vi.fn(),
    },
  };
});
vi.mock('@/services/kioskService', async () => {
  const actual =
    await vi.importActual<typeof import('@/services/kioskService')>('@/services/kioskService');
  return { ...actual, kioskService: { getView: vi.fn(), completeTask: vi.fn() } };
});
vi.mock('@/services/plantTagService', async () => {
  const actual = await vi.importActual<typeof import('@/services/plantTagService')>(
    '@/services/plantTagService'
  );
  return { ...actual, publicTagService: { getView: vi.fn(), completeTask: vi.fn() } };
});

const TOKEN = 'a'.repeat(64);

/** A wall-clock instant in the process zone, relative to Wednesday 14 October 2026. */
function local(dayOffset: number, hour: number, minute = 0): Date {
  return new Date(2026, 9, 14 + dayOffset, hour, minute, 0, 0);
}

/** The `overdue` flag exactly as the API computes it (taskService.dueTasksThrough). */
function serverOverdue(dueIso: string, now: Date): boolean {
  return dueIso < now.toISOString();
}

/**
 * The due dates under test, by the plant that carries them. Each sits on a
 * boundary one of the old readings got wrong: the demo's 09:00 due-today
 * shape, the end-of-day shape `firstDueIso` writes for a new task, half an
 * hour either side of midnight, and two days out.
 */
const DUE = [
  { plant: 'Monstera', type: 'water', due: () => local(0, 9) },
  { plant: 'Pothos', type: 'fertilize', due: () => new Date(2026, 9, 14, 23, 59, 59, 999) },
  { plant: 'Fern', type: 'prune', due: () => local(-1, 23, 30) },
  { plant: 'Aloe', type: 'repot', due: () => local(1, 0, 30) },
  { plant: 'Jade', type: 'mist', due: () => local(2, 9) },
] as const;

const CLOCKS = [
  { name: '04:00', now: () => local(0, 4) },
  { name: '14:00', now: () => local(0, 14) },
  { name: '23:00', now: () => local(0, 23) },
];

/** What the signed-in app's own helpers say about this due date, right now. */
function appSays(dueIso: string): 'overdue' | 'today' | 'tomorrow' | number {
  if (isOverdue(dueIso)) return 'overdue';
  if (isToday(dueIso)) return 'today';
  if (formatDueDate(dueIso) === 'Tomorrow') return 'tomorrow';
  return calendarDaysBetween(new Date(), new Date(dueIso));
}

function rows(now: Date) {
  return DUE.map((d, i) => {
    const dueDate = d.due().toISOString();
    return {
      taskId: `t${i}`,
      plantId: `p${i}`,
      plantName: d.plant,
      taskType: d.type,
      dueDate,
      spaceName: null,
      placementNote: null,
      overdue: serverOverdue(dueDate, now),
    };
  });
}

function rowFor(text: RegExp): HTMLElement {
  // `p` only: the sitter page's photo picker lists the same plant names as
  // <option>s once its own request settles.
  const li = screen.getByText(text, { selector: 'p' }).closest('li');
  if (!li) throw new Error(`no list row for ${String(text)}`);
  return li;
}

describe.each(CLOCKS)('public pages agree with the app at $name local', ({ now }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Only Date is faked, so findBy* polling still runs on real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the sitter page (/sit/:token)', async () => {
    vi.mocked(sitterService.getView).mockResolvedValue({
      label: null,
      expiresAt: local(7, 12).toISOString(),
      tasks: rows(now()).map(({ plantId: _plantId, ...rest }) => rest),
    });
    render(
      <MemoryRouter initialEntries={[`/sit/${TOKEN}`]}>
        <Routes>
          <Route path="/sit/:token" element={<SitPage />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByText(/Monstera/);

    for (const d of DUE) {
      const says = appSays(d.due().toISOString());
      const expected =
        says === 'overdue'
          ? 'Overdue'
          : says === 'today'
            ? 'Due today'
            : says === 'tomorrow'
              ? 'Due tomorrow'
              : `Due in ${says} days`;
      expect(within(rowFor(new RegExp(d.plant))).getByText(expected)).toBeInTheDocument();
    }
  });

  it('the caretaker page (/caretaker/:token)', async () => {
    vi.mocked(caretakerVisitService.getView).mockResolvedValue({
      caretakerName: 'Dana',
      startsAt: local(-1, 12).toISOString(),
      expiresAt: local(7, 12).toISOString(),
      permissions: ['task.complete'],
      tasks: rows(now()),
    });
    render(
      <MemoryRouter initialEntries={[`/caretaker/${TOKEN}`]}>
        <Routes>
          <Route path="/caretaker/:token" element={<CaretakerPage />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByText(/Monstera/);

    for (const d of DUE) {
      const says = appSays(d.due().toISOString());
      const expected =
        says === 'overdue'
          ? 'Overdue'
          : says === 'today'
            ? 'Due today'
            : says === 'tomorrow'
              ? 'Due tomorrow'
              : `Due in ${says} days`;
      expect(within(rowFor(new RegExp(d.plant))).getByText(expected)).toBeInTheDocument();
    }
  });

  it('the kiosk page (/kiosk/:token)', async () => {
    // The kiosk shows overdue work and the next day; its third label covers
    // everything after today.
    vi.mocked(kioskService.getView).mockResolvedValue({
      pollIntervalSeconds: 300,
      tasks: rows(now()).map(({ plantId: _plantId, ...rest }) => rest),
    });
    render(
      <MemoryRouter initialEntries={[`/kiosk/${TOKEN}`]}>
        <Routes>
          <Route path="/kiosk/:token" element={<KioskPage />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByText(/Monstera/);

    for (const d of DUE) {
      const says = appSays(d.due().toISOString());
      const expected =
        says === 'overdue' ? 'Overdue' : says === 'today' ? 'Due today' : 'Due tomorrow';
      expect(within(rowFor(new RegExp(d.plant))).getByText(expected)).toBeInTheDocument();
    }
  });

  it('the plant tag page (/tag/:token)', async () => {
    vi.mocked(publicTagService.getView).mockResolvedValue({
      plantName: 'Monstera',
      species: null,
      careNote: null,
      careNoteSource: null,
      history: { status: 'ok', lastCare: null, lastWatered: null },
      tasks: rows(now()).map((r) => ({
        taskId: r.taskId,
        taskType: r.taskType,
        dueDate: r.dueDate,
        overdue: r.overdue,
      })),
    });
    render(
      <MemoryRouter initialEntries={[`/tag/${TOKEN}`]}>
        <Routes>
          <Route path="/tag/:token" element={<ScanTagPage />} />
        </Routes>
      </MemoryRouter>
    );
    // One plant, so rows are told apart by task type.
    await screen.findByText(/Water the Monstera/i);

    for (const d of DUE) {
      const dueIso = d.due().toISOString();
      const expected =
        appSays(dueIso) === 'overdue' ? 'Overdue' : `Due ${formatRelativeDay(dueIso)}`;
      const row = rowFor(new RegExp(`^${d.type} the Monstera$`, 'i'));
      expect(within(row).getByText(expected)).toBeInTheDocument();
    }
  });

  it('the sitter brief (/sit/:token/brief)', async () => {
    vi.mocked(sitterService.getBrief).mockResolvedValue({
      label: null,
      startsAt: local(-1, 12).toISOString(),
      expiresAt: local(7, 12).toISOString(),
      plants: rows(now()).map((r) => ({
        plantId: r.plantId,
        name: r.plantName,
        spaceName: null,
        placementNote: null,
        careNote: null,
        careNoteSource: null,
        photoUrl: null,
        petSafety: null,
        tasks: [{ taskId: r.taskId, taskType: r.taskType, dueDate: r.dueDate, overdue: r.overdue }],
      })),
    });
    render(
      <MemoryRouter initialEntries={[`/sit/${TOKEN}/brief`]}>
        <Routes>
          <Route path="/sit/:token/brief" element={<SitBriefPage />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByRole('heading', { name: 'Monstera' });

    for (const d of DUE) {
      const dueIso = d.due().toISOString();
      const date = formatDate(dueIso);
      const expected = appSays(dueIso) === 'overdue' ? `overdue since ${date}` : `due ${date}`;
      const plantCard = screen.getByRole('heading', { name: d.plant }).closest('li');
      if (!plantCard) throw new Error(`no card for ${d.plant}`);
      expect(within(plantCard).getByText(expected)).toBeInTheDocument();
    }
  });
});

describe('negative control: the fixtures separate the two rules', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('at 14:00 the server flag calls the 09:00 task overdue while the app calls it today', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = local(0, 14);
    vi.setSystemTime(now);
    const dueIso = local(0, 9).toISOString();
    // The broken pages rendered this flag. If it ever agreed with the app,
    // the 14:00 and 23:00 cases above would pass on the broken pages too.
    expect(serverOverdue(dueIso, now)).toBe(true);
    expect(appSays(dueIso)).toBe('today');
  });

  it('at 04:00 the same task is not flagged, which is why the bug read as intermittent', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = local(0, 4);
    vi.setSystemTime(now);
    expect(serverOverdue(local(0, 9).toISOString(), now)).toBe(false);
  });

  it('at 23:00 rounding elapsed hours misreads 09:00 the day after tomorrow as tomorrow', () => {
    // 34 hours away rounds to 1 day; the calendar says 2.
    const now = local(0, 23);
    const due = local(2, 9);
    expect(Math.round((due.getTime() - now.getTime()) / 86_400_000)).toBe(1);
    expect(calendarDaysBetween(now, due)).toBe(2);
  });
});
