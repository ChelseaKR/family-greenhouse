import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RemovePlantDialog } from '@/features/plants/RemovePlantDialog';

function setup() {
  const onClose = vi.fn();
  const onArchive = vi.fn();
  const onDied = vi.fn();
  const onGaveAway = vi.fn();
  const onDelete = vi.fn();
  render(
    <RemovePlantDialog
      isOpen
      plantName="Monstera"
      onClose={onClose}
      onArchive={onArchive}
      onDied={onDied}
      onGaveAway={onGaveAway}
      onDelete={onDelete}
    />
  );
  return { onClose, onArchive, onDied, onGaveAway, onDelete };
}

describe('RemovePlantDialog', () => {
  it('offers a safe archive default plus lifecycle outcomes and permanent deletion', () => {
    setup();
    expect(screen.getByText('Move Monstera out of active care?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /archive for later/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /i gave it away/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /it died/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete permanently/i })).toBeInTheDocument();
  });

  it('routes each choice to the right handler', async () => {
    const user = userEvent.setup();
    const { onArchive, onDied, onGaveAway, onDelete } = setup();

    await user.click(screen.getByRole('button', { name: /archive for later/i }));
    expect(onArchive).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: /it died/i }));
    expect(onDied).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: /i gave it away/i }));
    expect(onGaveAway).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: /delete permanently/i }));
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
