/**
 * The pre-trip gap prompt is the mitigation for the brief's honest risk: a
 * brief is only as good as the household's notes. It must count the gaps
 * truthfully — and, when it could not look, say THAT rather than an
 * all-clear nobody computed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import i18n from '@/i18n';
import { SitterGapPrompt } from '@/features/household/SitterGapPrompt';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function plant(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    householdId: 'hh-1',
    name: 'Monstera',
    species: null,
    location: null,
    placementNote: 'east window',
    imageUrl: null,
    notes: 'Bottom-water this one',
    status: 'active',
    createdAt: '',
    createdBy: 'u1',
    updatedAt: '',
    ...over,
  };
}

function renderPrompt(plants: unknown[] | 'fail') {
  server.use(
    http.get(`${API}/plants`, () =>
      plants === 'fail' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(plants)
    )
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SitterGapPrompt householdId="hh-1" />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('SitterGapPrompt', () => {
  it('names how many plants have no watering note, and links to each one', async () => {
    renderPrompt([
      plant({ id: 'a', name: 'Fern', notes: null }),
      plant({ id: 'b', name: 'Fig', notes: '   ' }),
      plant({ id: 'c', name: 'Aloe' }),
    ]);

    expect(
      await screen.findByText(/2 plants have no watering note — your sitter will be guessing/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fern' })).toHaveAttribute('href', '/plants/a');
    expect(screen.getByRole('link', { name: 'Fig' })).toHaveAttribute('href', '/plants/b');
    expect(screen.queryByRole('link', { name: 'Aloe' })).not.toBeInTheDocument();
  });

  it('counts a structured care rule as a watering note', async () => {
    renderPrompt([plant({ id: 'a', name: 'Fern', notes: null, careRule: 'Bottom-water only' })]);

    expect(await screen.findByText(/Every plant has a care note/)).toBeInTheDocument();
    expect(screen.queryByText(/no watering note/)).not.toBeInTheDocument();
  });

  it('counts missing placement notes separately, in the singular', async () => {
    renderPrompt([plant({ id: 'a', name: 'Fern', placementNote: null })]);

    expect(
      await screen.findByText(/1 plant has no placement note — your sitter has to find it/)
    ).toBeInTheDocument();
  });

  it('truncates a long list rather than printing the whole collection', async () => {
    renderPrompt(
      Array.from({ length: 8 }, (_, i) => plant({ id: `p${i}`, name: `Plant ${i}`, notes: null }))
    );

    expect(await screen.findByText(/8 plants have no watering note/)).toBeInTheDocument();
    expect(screen.getByText('and 3 more')).toBeInTheDocument();
  });

  it('confirms when nothing is missing', async () => {
    renderPrompt([plant()]);
    expect(await screen.findByText(/Your sitter has what they need/)).toBeInTheDocument();
  });

  it('says it could not check when the plant read fails — never "nothing is missing"', async () => {
    renderPrompt('fail');

    expect(
      await screen.findByText(/couldn’t check which plants are missing notes/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Every plant has a care note/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no watering note/)).not.toBeInTheDocument();
  });

  it('renders nothing at all for a household with no plants yet', async () => {
    const { container } = renderPrompt([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
