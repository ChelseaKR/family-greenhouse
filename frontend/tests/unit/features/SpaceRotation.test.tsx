import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpaceRotationControl } from '@/features/plants/SpaceRotationControl';
import { buildSpaceOverviewGroups } from '@/features/plants/spaceOverview';
import type { HouseholdMember } from '@/services/householdService';
import type { Plant, PlantSpace } from '@/services/plantService';

const members: HouseholdMember[] = [
  { userId: 'sam', name: 'Sam', role: 'admin', joinedAt: '' },
  { userId: 'priya', name: 'Priya', role: 'member', joinedAt: '' },
];

function space(over: Partial<PlantSpace> = {}): PlantSpace {
  return {
    id: 'balcony',
    householdId: 'hh',
    name: 'Balcony',
    environment: 'outside',
    createdAt: '',
    createdBy: 'sam',
    updatedAt: '',
    ...over,
  };
}

const rotation = {
  memberIds: ['sam', 'priya'],
  cadence: 'weekly' as const,
  anchor: '2026-06-01T00:00:00.000Z',
};

describe('SpaceRotationControl', () => {
  it('shows the server’s derived turn rather than recomputing one', async () => {
    render(
      <SpaceRotationControl
        space={space({ rotation, rotationTurn: { turnUserId: 'priya', turnName: 'Priya' } })}
        members={members}
        isPending={false}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByText('Priya’s turn')).toBeInTheDocument();
  });

  it('says so when everyone in the rotation is away, instead of showing nobody', () => {
    render(
      <SpaceRotationControl
        space={space({ rotation, rotationTurn: { turnUserId: null, turnName: null } })}
        members={members}
        isPending={false}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByText('Rotation paused — everyone in it is away')).toBeInTheDocument();
  });

  it('refuses to save a rotation of one, and saves a valid one', async () => {
    const onSave = vi.fn();
    render(
      <SpaceRotationControl space={space()} members={members} isPending={false} onSave={onSave} />
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit the care rotation for Balcony' })
    );
    await userEvent.click(screen.getByLabelText('Sam'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/Pick at least two people/)).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Priya'));
    await userEvent.selectOptions(screen.getByLabelText('Change over'), 'monthly');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ memberIds: ['sam', 'priya'], cadence: 'monthly' });
  });

  it('offers stopping only once a rotation exists, and clears it with null', async () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <SpaceRotationControl space={space()} members={members} isPending={false} onSave={onSave} />
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit the care rotation for Balcony' })
    );
    expect(screen.queryByRole('button', { name: 'Stop rotating' })).not.toBeInTheDocument();
    // Close the editor so the rerender starts from the collapsed state again.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    rerender(
      <SpaceRotationControl
        space={space({ rotation, rotationTurn: { turnUserId: 'sam', turnName: 'Sam' } })}
        members={members}
        isPending={false}
        onSave={onSave}
      />
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Edit the care rotation for Balcony' })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Stop rotating' }));
    expect(onSave).toHaveBeenCalledWith(null);
  });
});

describe('spaceOverview rotation state', () => {
  const plants: Plant[] = [
    {
      id: 'p1',
      householdId: 'hh',
      name: 'Fern',
      species: null,
      location: null,
      spaceId: 'balcony',
      imageUrl: null,
      notes: null,
      status: 'active',
      tags: [],
      createdAt: '',
      createdBy: 'sam',
      updatedAt: '',
    } as unknown as Plant,
  ];

  it('carries the turn onto the space card, and distinguishes "no rotation" from "nobody available"', () => {
    const withTurn = buildSpaceOverviewGroups(
      plants,
      [space({ rotation, rotationTurn: { turnUserId: 'priya', turnName: 'Priya' } })],
      [],
      members
    );
    expect(withTurn[0].rotation).toEqual({ turnName: 'Priya' });

    const everyoneAway = buildSpaceOverviewGroups(
      plants,
      [space({ rotation, rotationTurn: { turnUserId: null, turnName: null } })],
      [],
      members
    );
    // A rotation that exists but has nobody available: present, turn unknown.
    expect(everyoneAway[0].rotation).toEqual({ turnName: null });

    const noRotation = buildSpaceOverviewGroups(plants, [space()], [], members);
    expect(noRotation[0].rotation).toBeNull();
  });
});
