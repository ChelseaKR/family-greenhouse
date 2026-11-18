import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { ensureLocaleCatalog } from '@/i18n/nonEnglishCatalog';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PlantImage } from '@/components/PlantImage';
import { SpeciesCombobox } from '@/components/SpeciesCombobox';
import { CareGuidanceCard } from '@/features/plants/CareGuidanceCard';
import { CareReportCard } from '@/features/plants/CareReportCard';
import { SitPage } from '@/features/sitter/SitPage';
import { getErrorMessage } from '@/services/api';
import type { PlantWithTasks, Task } from '@/services/plantService';
import { sitterService, type SitterView } from '@/services/sitterService';
import { formatDate, formatDueDate } from '@/utils/date';
import { streakLabel } from '@/utils/streaks';

vi.mock('@/services/sitterService', async () => {
  const actual = await vi.importActual<typeof import('@/services/sitterService')>(
    '@/services/sitterService'
  );
  return { ...actual, sitterService: { getView: vi.fn(), completeTask: vi.fn() } };
});

/**
 * Second pass at English on Spanish screens (approved by Chelsea 2026-11-18).
 * These strings were outside the hardcoded-string ratchet's view: defaults in
 * props, ternaries, template literals, toasts, helper return values. Each case
 * renders the real component (or calls the real helper) with the shipped
 * Spanish catalog, and checks the English beside it so neither language
 * borrows the other's text.
 */

const PLANT = {
  id: 'p1',
  householdId: 'hh',
  name: 'Pothos',
  species: null,
  location: null,
  imageUrl: null,
  notes: null,
  createdAt: '',
  createdBy: '',
  updatedAt: '',
  upcomingTasks: [],
  recentCompletions: [],
} as unknown as PlantWithTasks;

const WATER_TASK = {
  id: 't1',
  plantId: 'p1',
  plantName: 'Pothos',
  type: 'water',
  customType: undefined,
  frequency: 7,
  lastCompleted: null,
  nextDue: '2099-01-01T12:00:00.000Z',
} as unknown as Task;

function withQueryClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
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
    cancel: 'Cancelar',
    species: 'Especie',
    speciesPlaceholder: 'p. ej., Monstera deliciosa',
    stockAlt: 'Foto de archivo de Pothos',
    guideTitle: 'Cuidados para Monstera de la sala',
    guideDescription: 'Consejos seleccionados para Monstera deliciosa.',
    completions: 'Tareas completadas (últimas 10)',
    bestStreak: 'Mejor racha (últimas 10)',
  },
  {
    lng: 'en',
    cancel: 'Cancel',
    species: 'Species',
    speciesPlaceholder: 'e.g. Monstera deliciosa',
    stockAlt: 'Stock photo for Pothos',
    guideTitle: 'Caring for Monstera de la sala',
    guideDescription: 'Curated tips for Monstera deliciosa.',
    completions: 'Completions (last 10)',
    bestStreak: 'Best streak (last 10)',
  },
])('shared pieces in $lng', (c) => {
  beforeEach(async () => {
    await i18n.changeLanguage(c.lng);
  });

  it('a confirm dialog with no cancel label of its own uses the catalog word', () => {
    render(
      <ConfirmDialog
        isOpen
        onClose={() => undefined}
        onConfirm={() => undefined}
        title="t"
        message="m"
        confirmLabel="ok"
      />
    );
    expect(screen.getByRole('button', { name: c.cancel })).toBeInTheDocument();
  });

  it('the species field has a label and an example in the page language', () => {
    render(withQueryClient(<SpeciesCombobox value="" onChange={() => undefined} />));
    const field = screen.getByLabelText(c.species);
    expect(field).toHaveAttribute('placeholder', c.speciesPlaceholder);
  });

  it('a species stock photo is described in the page language', () => {
    render(<PlantImage plant={{ name: 'Pothos', imageUrl: null, perenualSpeciesId: 42 }} />);
    expect(screen.getByRole('img', { name: c.stockAlt })).toBeInTheDocument();
  });

  it('the curated care card heading follows the page language', () => {
    render(<CareGuidanceCard species="Monstera deliciosa" plantName="Monstera de la sala" />);
    expect(screen.getByText(c.guideTitle)).toBeInTheDocument();
    expect(screen.getByText(c.guideDescription)).toBeInTheDocument();
  });

  it('the care report names its counts in the page language', () => {
    render(<CareReportCard plant={PLANT} />);
    expect(screen.getByText(c.completions)).toBeInTheDocument();
    expect(screen.getByText(c.bestStreak)).toBeInTheDocument();
  });
});

describe('curated care tips stay English, and say so', () => {
  it('marks each tip lang="en" while its heading is Spanish', async () => {
    await i18n.changeLanguage('es');
    const { container } = render(<CareGuidanceCard species="Monstera deliciosa" />);
    const tips = container.querySelectorAll('dd');
    expect(tips).toHaveLength(4);
    for (const tip of tips) expect(tip.getAttribute('lang')).toBe('en');
    // The labels beside them are the page's language, so they carry no lang.
    for (const term of container.querySelectorAll('dt')) {
      expect(term.hasAttribute('lang')).toBe(false);
    }
    expect(screen.getByText('Luz', { selector: 'dt' })).toBeInTheDocument();
  });
});

describe('helpers that return words', () => {
  it('due labels and the missing-date word', async () => {
    await i18n.changeLanguage('es');
    expect(formatDate(null)).toBe('Nunca');
    expect(formatDueDate('2000-01-01T12:00:00.000Z')).toBe('Atrasada');
    await i18n.changeLanguage('en');
    expect(formatDate(null)).toBe('Never');
    expect(formatDueDate('2000-01-01T12:00:00.000Z')).toBe('Overdue');
  });

  it('a care streak', () => {
    const es = i18n.getFixedT('es');
    const en = i18n.getFixedT('en');
    expect(streakLabel(WATER_TASK, { cycles: 4, truncated: false }, es)).toBe(
      'Racha de 4 ciclos de riego'
    );
    expect(streakLabel(WATER_TASK, { cycles: 4, truncated: true }, es, 10)).toBe(
      'Racha de 4+ ciclos de riego (entre las últimas 10 registradas)'
    );
    expect(streakLabel(WATER_TASK, { cycles: 4, truncated: false }, en)).toBe(
      '4-cycle watering streak'
    );
  });

  it('an error with no message of its own', async () => {
    await i18n.changeLanguage('es');
    expect(getErrorMessage(null)).toBe('Se produjo un error inesperado');
    await i18n.changeLanguage('en');
    expect(getErrorMessage(null)).toBe('An unexpected error occurred');
  });
});

describe('the sitter page in Spanish', () => {
  const view: SitterView = {
    label: 'Las plantas de los García',
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    tasks: [
      {
        taskId: 't1',
        plantName: 'Monstera',
        taskType: 'water',
        dueDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        spaceName: null,
        placementNote: null,
        overdue: true,
      },
    ],
  } as unknown as SitterView;

  it('says what needs doing, in Spanish', async () => {
    await i18n.changeLanguage('es');
    vi.mocked(sitterService.getView).mockResolvedValue(view);
    render(
      <MemoryRouter initialEntries={[`/sit/${'a'.repeat(64)}`]}>
        <Routes>
          <Route path="/sit/:token" element={<SitPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Las plantas de los García: lo que hay que hacer',
      })
    ).toBeInTheDocument();
    expect(screen.getByText('Riega la Monstera')).toBeInTheDocument();
    expect(screen.getByText('Atrasada')).toBeInTheDocument();
    expect(screen.queryByText('Water the Monstera')).not.toBeInTheDocument();
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });

  /**
   * A task with no plant name (approved by Chelsea 2026-11-18, "Use 'tu
   * planta'"): Spanish gets a whole no-name sentence, never the named
   * template with a stand-in ("Riega la tu planta"). English is unchanged.
   */
  const unnamed = (taskId: string, taskType: string) => ({
    taskId,
    plantName: '',
    taskType,
    dueDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    spaceName: null,
    placementNote: null,
    overdue: true,
  });

  it.each([
    [
      'es',
      ['Riega tu planta', 'Abona tu planta', 'Poda tu planta', 'Trasplanta tu planta'],
      'Misting — tu planta',
      ['Riega la tu planta', 'Riega la this plant', 'Water the this plant'],
    ],
    [
      'en',
      [
        'Water the this plant',
        'Feed the this plant',
        'Prune the this plant',
        'Repot the this plant',
      ],
      'Misting — this plant',
      ['Riega tu planta'],
    ],
  ] as const)(
    'in %s, a task with no plant name gets the no-name instruction',
    async (lng, verbs, custom, absent) => {
      await i18n.changeLanguage(lng);
      vi.mocked(sitterService.getView).mockResolvedValue({
        ...view,
        tasks: [
          unnamed('t1', 'water'),
          unnamed('t2', 'fertilize'),
          unnamed('t3', 'prune'),
          unnamed('t4', 'repot'),
          unnamed('t5', 'Misting'),
        ],
      } as unknown as SitterView);
      render(
        <MemoryRouter initialEntries={[`/sit/${'a'.repeat(64)}`]}>
          <Routes>
            <Route path="/sit/:token" element={<SitPage />} />
          </Routes>
        </MemoryRouter>
      );
      for (const text of verbs) expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.getByText(custom)).toBeInTheDocument();
      for (const text of absent) expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
  );
});

describe('approved wording', () => {
  it('pins the approved Spanish beside unchanged English', async () => {
    const es = i18n.getFixedT('es');
    const en = i18n.getFixedT('en');
    const pairs: Array<[string, string, string, Record<string, unknown>?]> = [
      ['household.page.roleAdmin', 'Admin', 'Administrador'],
      ['household.page.makeAdmin', 'Make admin', 'Hacer administrador'],
      ['plants.detailPage.snooze.oneWeek', '1 week', '1 semana'],
      ['tasks.completedToast', 'Task completed', 'Tarea completada'],
      ['statusPage.down', 'We are investigating an issue', 'Estamos investigando un problema'],
      [
        'dashboard.toDoNowDescriptionLater',
        'Overdue and due today — 3 more later this week',
        'Atrasadas y para hoy: 3 más adelante esta semana',
        { count: 3 },
      ],
      [
        'plants.addedWithTasks',
        'Pothos added with 1 care task',
        'Pothos añadida con 1 tarea de cuidado',
        { name: 'Pothos', count: 1 },
      ],
    ];
    for (const [key, english, spanish, options] of pairs) {
      expect(en(key, options)).toBe(english);
      expect(es(key, options)).toBe(spanish);
    }
  });

  it('the three Spanish forms for a million read like the plural form', () => {
    const es = i18n.getFixedT('es');
    expect(es('common.daysAgo', { count: 1_000_000 })).toBe('hace 1000000 días');
    expect(es('plants.lineage.childrenCount', { count: 1_000_000 })).toBe('1000000 esquejes');
    expect(es('chat.proposal.frequency', { count: 1_000_000 })).toBe('Cada 1000000 días');
  });
});
