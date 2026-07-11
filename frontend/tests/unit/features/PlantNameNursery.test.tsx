import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PlantNameNursery } from '@/features/plants/PlantNameNursery';

describe('PlantNameNursery', () => {
  it('lets someone choose a vibe, reroll, and use a suggestion', async () => {
    const user = userEvent.setup();
    const onUseName = vi.fn();
    render(<PlantNameNursery species="Boston fern" onUseName={onUseName} />);

    await user.click(screen.getByRole('button', { name: 'Name this plant for me' }));
    expect(screen.getByRole('region', { name: 'Plant name nursery' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Punny/ }));
    const firstSuggestion = screen.getByText('Ready for adoption').nextElementSibling?.textContent;
    expect(firstSuggestion).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Another one' }));
    await user.click(screen.getByRole('button', { name: 'Use this name' }));

    expect(onUseName).toHaveBeenCalledTimes(1);
    expect(onUseName).toHaveBeenCalledWith(expect.any(String));
    expect(screen.queryByRole('region', { name: 'Plant name nursery' })).not.toBeInTheDocument();
  });

  it('can be closed without overwriting the form name', async () => {
    const user = userEvent.setup();
    const onUseName = vi.fn();
    render(<PlantNameNursery species="" onUseName={onUseName} />);

    await user.click(screen.getByRole('button', { name: 'Name this plant for me' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onUseName).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Name this plant for me' })).toBeInTheDocument();
  });
});
