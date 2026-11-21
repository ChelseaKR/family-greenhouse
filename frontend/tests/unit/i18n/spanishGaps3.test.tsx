import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import i18n from '@/i18n';
import { ensureLocaleCatalog } from '@/i18n/nonEnglishCatalog';
import { CareReportCard } from '@/features/plants/CareReportCard';
import { SitPage } from '@/features/sitter/SitPage';
import type { PlantWithTasks, Task } from '@/services/plantService';
import { sitterService, type SitterView } from '@/services/sitterService';
import { completedTaskName, taskTypeName } from '@/utils/taskTypeConfig';

vi.mock('@/services/sitterService', async () => {
  const actual = await vi.importActual<typeof import('@/services/sitterService')>(
    '@/services/sitterService'
  );
  return { ...actual, sitterService: { getView: vi.fn(), completeTask: vi.fn() } };
});

/**
 * Third pass at English on Spanish screens (WCAG 3.1.2; approved by Chelsea
 * 2026-11-20, FOR-APPROVAL-2 S1 to S9): the rows the 2026-11-18 pass held
 * for a look at the screens. Each case checks the Spanish beside the English,
 * so neither language borrows the other's text.
 */

const DAY = 86_400_000;
const SRC = resolve(__dirname, '../../../src');
const source = (file: string) => readFileSync(join(SRC, file), 'utf8');

function plantWithWaterDone(daysAgo: number): PlantWithTasks {
  const task = {
    id: 't1',
    plantId: 'p1',
    plantName: 'Pothos',
    type: 'water',
    customType: undefined,
    frequency: 7,
    lastCompleted: new Date(Date.now() - daysAgo * DAY - 3_600_000).toISOString(),
    nextDue: '2099-01-01T12:00:00.000Z',
  } as unknown as Task;
  return {
    id: 'p1',
    householdId: 'hh',
    name: 'Pothos',
    upcomingTasks: [task],
    recentCompletions: [],
  } as unknown as PlantWithTasks;
}

beforeAll(async () => {
  await ensureLocaleCatalog(i18n, 'es');
});
afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe.each([
  {
    lng: 'es',
    stat: ['Hoy', 'Ayer', 'Hace 3 días', 'Hace 2 semanas', 'Hace 1 mes'],
    row: ['último: hoy', 'último: ayer', 'último: hace 3 días', 'último: hace 2 semanas'],
    water: 'Regar',
  },
  {
    lng: 'en',
    stat: ['today', 'yesterday', '3d ago', '2w ago', '1mo ago'],
    row: ['last today', 'last yesterday', 'last 3d ago', 'last 2w ago'],
    water: 'Water',
  },
])('the care report in $lng (S1, S9)', (c) => {
  beforeEach(async () => {
    await i18n.changeLanguage(c.lng);
  });

  it.each([
    [0, 0],
    [1, 1],
    [3, 2],
    [14, 3],
    [40, 4],
  ])('%i days ago reads in the page language', (daysAgo, index) => {
    render(<CareReportCard plant={plantWithWaterDone(daysAgo)} />);
    expect(screen.getByText(c.stat[index])).toBeInTheDocument();
    if (index < c.row.length) expect(screen.getByText(c.row[index])).toBeInTheDocument();
  });

  it('names the task type, not its stored value', () => {
    render(<CareReportCard plant={plantWithWaterDone(3)} />);
    expect(screen.getByText(c.water)).toBeInTheDocument();
    expect(screen.queryByText('water')).not.toBeInTheDocument();
  });
});

describe('task type names (S9)', () => {
  it('a built-in type in each language, a custom type as typed', async () => {
    await i18n.changeLanguage('es');
    expect(taskTypeName(i18n.t, 'water')).toBe('Regar');
    expect(completedTaskName(i18n.t, 'water')).toBe('el riego');
    expect(completedTaskName(i18n.t, 'prune')).toBe('la poda');
    expect(taskTypeName(i18n.t, 'Mist leaves')).toBe('Mist leaves');
    expect(completedTaskName(i18n.t, 'Mist leaves')).toBe('Mist leaves');
    await i18n.changeLanguage('en');
    expect(taskTypeName(i18n.t, 'water')).toBe('Water');
    expect(completedTaskName(i18n.t, 'repot')).toBe('repotting');
  });

  it('the palette, the activity feed, the care history and the overdue alert use them', () => {
    expect(source('components/CommandPalette.tsx')).toContain(
      'taskTypeName(t, task.customType ?? task.type)'
    );
    expect(source('features/dashboard/DashboardPage.tsx')).toContain(
      'completedTaskName(t, event.payload.taskType)'
    );
    expect(source('features/plants/PlantDetailPage.tsx')).toContain(
      'completedTaskName(t, completion.taskType)'
    );
    expect(source('hooks/useOverdueAlerts.ts')).toContain(
      'taskTypeName(i18n.t, task.customType ?? task.type)'
    );
  });
});

describe('the sitter page Done button is named in the page language (S8)', () => {
  const view: SitterView = {
    label: 'Casa',
    expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
    tasks: [
      {
        taskId: 't1',
        plantName: 'Monstera',
        taskType: 'water',
        dueDate: new Date(Date.now() - 2 * DAY).toISOString(),
        spaceName: null,
        placementNote: null,
        overdue: true,
      },
    ],
  } as unknown as SitterView;

  it.each([
    ['es', 'Marcar «Riega la Monstera» como hecho'],
    ['en', 'Mark “Water the Monstera” as done'],
  ])('%s', async (lng, name) => {
    await i18n.changeLanguage(lng);
    vi.mocked(sitterService.getView).mockResolvedValue(view);
    render(
      <MemoryRouter initialEntries={[`/sit/${'a'.repeat(64)}`]}>
        <Routes>
          <Route path="/sit/:token" element={<SitPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByRole('button', { name })).toBeInTheDocument();
  });
});

describe('approved wording (S2 to S7)', () => {
  it('pins the Spanish beside the English', async () => {
    const rows: Array<[key: string, opts: Record<string, unknown>, es: string, en: string]> = [
      ['plants.detailPage.snooze.skipCycle', {}, 'Saltar esta vez', 'Skip cycle'],
      [
        'notifications.overdueAlertBody',
        { task: 'Regar' },
        'Regar: cuando puedas.',
        'Regar is ready whenever you are.',
      ],
      [
        'nativePush.registerTimeout',
        {},
        'No pudimos activar las notificaciones a tiempo. Vuelve a intentarlo.',
        'We couldn’t turn on notifications in time. Try again.',
      ],
      [
        'petSafety.page.metaTitle',
        {},
        '¿Es segura esta planta para las mascotas? — Comprobador de toxicidad para gatos y perros',
        'Is This Plant Safe for Pets? — Cat & Dog Toxicity Checker',
      ],
    ];
    for (const [key, opts, es, en] of rows) {
      await i18n.changeLanguage('es');
      expect(i18n.t(key, opts), key).toBe(es);
      await i18n.changeLanguage('en');
      expect(i18n.t(key, opts), key).toBe(en);
    }
  });

  it('the English that used to be written in the code is gone from it', () => {
    expect(source('features/plants/PlantDetailPage.tsx')).not.toContain("'Skip cycle'");
    expect(source('features/dashboard/ClimateCard.tsx')).not.toContain('OpenWeatherMap key');
    expect(source('features/dashboard/ClimateCard.tsx')).toContain(
      "t('household.climateUnavailable')"
    );
    expect(source('hooks/useOverdueAlerts.ts')).not.toContain('is ready whenever you are');
    expect(source('services/nativePush.ts')).not.toContain('Timed out waiting');
    expect(source('features/sitter/SitPage.tsx')).not.toContain('as done`');
  });

  it('the pet-safe tab title and share text follow the page language; the JSON-LD stays English', () => {
    const page = source('features/petsafe/PetSafePage.tsx');
    expect(page).toContain("title: t('petSafety.page.metaTitle')");
    expect(page).toContain("description: t('petSafety.page.metaDescription')");
    // The structured data says `inLanguage: 'en'`, and the English catalog
    // must keep saying exactly what it says.
    const constant = (name: string) => new RegExp(`const ${name} =\\s*'([^']*)'`).exec(page)?.[1];
    expect(i18n.getFixedT('en')('petSafety.page.metaTitle')).toBe(constant('PAGE_TITLE'));
    expect(i18n.getFixedT('en')('petSafety.page.metaDescription')).toBe(
      constant('PAGE_DESCRIPTION')
    );
  });
});
