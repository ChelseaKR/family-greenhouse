/**
 * Audit 2026-11-08, finding 19: English literals a Spanish reader reaches.
 *
 * Spanish has been reachable since #467/#810, and the plant page still printed
 * "Due:" in front of every task's date and "Never" for a date that is not
 * there, in both languages. Neither went through the catalog: "Never" is a
 * string returned from a function, which the hardcoded-string scanner (JSX
 * text and attributes only) does not read.
 *
 * Each case renders the real component in Spanish and in English, so a key
 * that exists in the Spanish catalog as a copy of the English fails here.
 */
import { ensureLocaleCatalog } from '@/i18n/nonEnglishCatalog';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { PlantDetailPage } from '@/features/plants/PlantDetailPage';
import { CareReportCard } from '@/features/plants/CareReportCard';
import type { PlantWithTasks } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/** A plant with one task that has never been done and no logged completions. */
const PLANT = {
  id: 'p1',
  householdId: 'hh',
  name: 'Pothos',
  species: null,
  location: null,
  imageUrl: null,
  notes: null,
  // No date on the row: the "Added" line falls through to the missing-date
  // word, which is the first literal the audit named.
  createdAt: '',
  createdBy: '',
  updatedAt: '',
  upcomingTasks: [
    {
      id: 't1',
      plantId: 'p1',
      plantName: 'Pothos',
      type: 'water',
      customType: null,
      frequency: 7,
      lastCompleted: null,
      nextDue: '2099-01-01T12:00:00.000Z',
      assignedTo: null,
      assignedToName: null,
      notes: null,
      createdBy: '',
      createdAt: '',
    },
  ],
  recentCompletions: [],
};

function renderDetail(plant: typeof PLANT = PLANT) {
  useAuthStore.setState({ accessToken: 'access-1' });
  server.use(http.get(`${API}/plants/p1`, () => HttpResponse.json(plant)));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants/p1']}>
        <Routes>
          <Route path="/plants/:plantId" element={<PlantDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** The value printed beside a `<dt>` label, by the label's text. */
function valueBeside(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  const value = term.parentElement?.querySelector('dd');
  if (!value) throw new Error(`no value beside "${label}"`);
  return value;
}

describe('the plant page in Spanish', () => {
  beforeAll(async () => {
    // Load the shipped Spanish catalog the way the language picker does.
    await ensureLocaleCatalog(i18n, 'es');
  });
  beforeEach(async () => {
    await i18n.changeLanguage('es');
  });
  afterAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('prints a task’s due date under a Spanish label, not "Due:"', async () => {
    renderDetail();

    const due = await screen.findByText(/^Vence: /);
    // The date itself is still there after the label.
    expect(due).toHaveTextContent(/^Vence: .*2099/);
    expect(screen.queryByText(/Due:/)).not.toBeInTheDocument();
  });

  it('says "Nunca", not "Never", for a date that is not there', async () => {
    renderDetail();

    await screen.findByText(/^Vence: /);
    // The label is Spanish now too; it used to be a hardcoded "Added".
    expect(valueBeside('Añadida')).toHaveTextContent(/^Nunca$/);
    expect(screen.queryByText('Added')).not.toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
  });

  it('says "Nunca", not "Never", for last care on the care report', () => {
    render(<CareReportCard plant={PLANT as unknown as PlantWithTasks} />);

    // The label is Spanish now too; it used to be a hardcoded "Last care".
    const lastCare = valueBeside('Último cuidado');
    expect(within(lastCare).getByText('Nunca')).toBeInTheDocument();
    expect(screen.queryByText('Last care')).not.toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
  });
});

describe('the plant page in English is unchanged', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('still prints "Due:" and "Never"', async () => {
    renderDetail();

    const due = await screen.findByText(/^Due: /);
    expect(due).toHaveTextContent(/^Due: .*2099/);
    expect(valueBeside('Added')).toHaveTextContent(/^Never$/);
    expect(valueBeside('Last care')).toHaveTextContent(/^Never$/);
    expect(screen.queryByText(/Vence:|Nunca/)).not.toBeInTheDocument();
  });
});

/**
 * The interval beside each task (approved 2026-11-18). The singular form held
 * the plural sentence, so a task due every day read "Every 1 days", and the
 * Spanish read "Cada 1 día".
 */
describe('the task interval on the plant page', () => {
  /** The same plant, with its one task due every `frequency` days. */
  const withFrequency = (frequency: number): typeof PLANT => ({
    ...PLANT,
    upcomingTasks: [{ ...PLANT.upcomingTasks[0]!, frequency }],
  });

  beforeAll(async () => {
    await ensureLocaleCatalog(i18n, 'es');
  });
  afterAll(async () => {
    await i18n.changeLanguage('en');
  });

  it.each([
    ['en', 1, 'Every day'],
    ['en', 2, 'Every 2 days'],
    ['en', 7, 'Every 7 days'],
    ['es', 1, 'Cada día'],
    ['es', 2, 'Cada 2 días'],
    ['es', 7, 'Cada 7 días'],
  ] as const)('in %s, a task every %i day(s) reads "%s"', async (language, frequency, text) => {
    await i18n.changeLanguage(language);
    renderDetail(withFrequency(frequency));

    expect(await screen.findByText(text, { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByText(/\b1 days\b|\b1 día\b/)).not.toBeInTheDocument();
  });

  it('holds the approved words in both catalogs', async () => {
    expect(i18n.t('plants.detailPage.everyDays', { lng: 'en', count: 1 })).toBe('Every day');
    expect(i18n.t('plants.detailPage.everyDays', { lng: 'es', count: 1 })).toBe('Cada día');
    // The plural forms are unchanged.
    expect(i18n.t('plants.detailPage.everyDays', { lng: 'en', count: 3 })).toBe('Every 3 days');
    expect(i18n.t('plants.detailPage.everyDays', { lng: 'es', count: 3 })).toBe('Cada 3 días');
  });
});
