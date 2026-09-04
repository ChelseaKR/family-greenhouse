import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { CaretakerSeatsCard } from '@/features/household/CaretakerSeatsCard';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const DAY = 24 * 60 * 60 * 1000;

/**
 * Three things this card must get right, all of them about not lying to the
 * household:
 *
 *   - A FAILED read of the seat list must not render as "no caretakers". This
 *     is the only screen with a Revoke control, so an empty-looking list hides
 *     the one thing that stops a live credential.
 *   - A FAILED read of the PLAN must not render as "your plan doesn't include
 *     caretaker seats" (ADR 0010). Entitlement is read from the catalog's
 *     `features.caretakerSeats`, never from a hardcoded tier name, and the
 *     unknown case says it is unknown.
 *   - The permission surface is printed on screen, including what a caretaker
 *     cannot do, so the household is not asked to take the limits on faith.
 */
const plansBody = (caretakerSeats: boolean) => ({
  paymentsAvailable: true,
  commercialHold: { active: false, effectiveDate: '2026-09-01' },
  plans: [
    {
      id: 'greenhouse',
      name: 'Greenhouse',
      description: '',
      maxPlants: 5000,
      maxMembers: null,
      features: { caretakerSeats },
    },
  ],
});

/** `plan`: 'on' | 'off' | 'fail' (catalog unreachable) | 'noFlag' (older
 *  catalog published before `features.caretakerSeats` existed). */
function renderCard(seats: unknown[] | 'fail', plan: 'on' | 'off' | 'fail' | 'noFlag' = 'on') {
  server.use(
    http.get(`${API}/households/hh-1/caretakers`, () =>
      seats === 'fail' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(seats)
    ),
    http.get(`${API}/billing/me`, () => HttpResponse.json({ planId: 'greenhouse' })),
    http.get(`${API}/billing/plans`, () => {
      if (plan === 'fail') return new HttpResponse(null, { status: 500 });
      if (plan === 'noFlag')
        return HttpResponse.json({
          paymentsAvailable: true,
          commercialHold: { active: false, effectiveDate: '2026-09-01' },
          plans: [
            {
              id: 'greenhouse',
              name: 'Greenhouse',
              description: '',
              maxPlants: 5000,
              maxMembers: null,
            },
          ],
        });
      return HttpResponse.json(plansBody(plan === 'on'));
    })
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CaretakerSeatsCard householdId="hh-1" />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('CaretakerSeatsCard', () => {
  it('states the whole permission surface, including the limits', async () => {
    renderCard([]);
    expect(await screen.findByText('What a caretaker can do')).toBeInTheDocument();
    expect(screen.getByText('Tick off the tasks that are due')).toBeInTheDocument();
    expect(screen.getByText('Add a photo to a plant')).toBeInTheDocument();
    expect(screen.getByText('Leave a note about the visit')).toBeInTheDocument();
    expect(screen.getByText(/cannot edit plants/)).toBeInTheDocument();
  });

  it('lists live seats by name with a revoke control', async () => {
    renderCard([
      { id: 's1', name: 'Dana', status: 'active', startsAt: iso(-DAY), expiresAt: iso(DAY) },
      { id: 's2', name: 'Gone', status: 'revoked', startsAt: iso(-DAY), expiresAt: iso(DAY) },
    ]);

    expect(await screen.findByText('Dana')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke — Dana' })).toBeInTheDocument();
    // A revoked seat grants nothing; re-listing it with a live-looking control
    // is noise the household already acted on.
    expect(screen.queryByRole('button', { name: 'Revoke — Gone' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says "none yet" only when the read actually succeeded and was empty', async () => {
    renderCard([]);
    expect(await screen.findByText('No caretaker seats yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says the seats could not be loaded instead of implying there are none', async () => {
    renderCard('fail');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn’t load your caretaker seats/i);
    expect(screen.queryByText('No caretaker seats yet.')).not.toBeInTheDocument();
  });

  it('hides the create form off-plan but keeps the list and revoke path', async () => {
    renderCard(
      [{ id: 's1', name: 'Dana', status: 'active', startsAt: iso(-DAY), expiresAt: iso(DAY) }],
      'off'
    );

    expect(await screen.findByText('Caretaker seats come with Greenhouse')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create caretaker seat' })).not.toBeInTheDocument();
    // Trapping a live credential behind a paywall would be a security bug.
    expect(await screen.findByRole('button', { name: 'Revoke — Dana' })).toBeInTheDocument();
  });

  // NEGATIVE CONTROLS for the entitlement read. An unreadable plan is not an
  // absent entitlement — saying "comes with Greenhouse" to a household that
  // already pays for Greenhouse is the same class of lie as rendering a failed
  // seat read as "no caretakers".
  it('says the plan could not be checked instead of claiming it is not included', async () => {
    renderCard(
      [{ id: 's1', name: 'Dana', status: 'active', startsAt: iso(-DAY), expiresAt: iso(DAY) }],
      'fail'
    );

    expect(
      await screen.findByText(/couldn’t check whether caretaker seats are included/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('Caretaker seats come with Greenhouse')).not.toBeInTheDocument();
    // Neither offered nor implied: unknown means we do not guess in either
    // direction, and the revoke path survives regardless.
    expect(screen.queryByRole('button', { name: 'Create caretaker seat' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Revoke — Dana' })).toBeInTheDocument();
  });

  it('treats a catalog with no caretakerSeats flag as unknown, not as off', async () => {
    renderCard([], 'noFlag');

    expect(
      await screen.findByText(/couldn’t check whether caretaker seats are included/i)
    ).toBeInTheDocument();
    expect(screen.queryByText('Caretaker seats come with Greenhouse')).not.toBeInTheDocument();
  });

  it('offers the create form when the catalog says the tier includes seats', async () => {
    renderCard([], 'on');

    expect(
      await screen.findByRole('button', { name: 'Create caretaker seat' })
    ).toBeInTheDocument();
    expect(screen.queryByText('Caretaker seats come with Greenhouse')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/couldn’t check whether caretaker seats are included/i)
    ).not.toBeInTheDocument();
  });
});
