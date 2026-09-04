import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ConfirmDialog } from '@/components/ConfirmDialog';

/**
 * The two properties axe cannot see (#444).
 *
 * `ConfirmDialog` stands between the user and every irreversible action in the
 * app — account deletion, plant deletion, API-key revocation. A missing
 * `aria-describedby` is not an axe violation (descriptions are optional) and
 * initial focus placement has no axe rule at all, so both defects shipped
 * through a suite that opens this dialog and scans it. These are the
 * hand-written assertions that catch them.
 */
const MESSAGE =
  'This permanently removes the plant and all its tasks and history. This cannot be undone.';

function setup(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      title="Delete plant"
      message={MESSAGE}
      confirmLabel="Delete"
      cancelLabel="Cancel"
      {...props}
    />
  );
  return { onClose, onConfirm };
}

describe('ConfirmDialog accessibility', () => {
  it('associates the consequences with the dialog via aria-describedby', async () => {
    setup();

    const dialog = await screen.findByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    // Every id in the list must resolve, and together they must carry the
    // message — the sentence that says what is about to be destroyed.
    const described = describedBy!
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    expect(described).toHaveLength(describedBy!.split(/\s+/).length);
    expect(described.map((el) => el.textContent).join(' ')).toContain(MESSAGE);
  });

  it('opens with focus on Cancel, not on the destructive button', async () => {
    setup({ variant: 'danger' });

    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Delete' }));
  });

  it('still puts focus on the cancel control for the non-destructive variant', async () => {
    setup({ variant: 'primary', confirmLabel: 'Continue', cancelLabel: 'Not now' });

    const cancel = await screen.findByRole('button', { name: 'Not now' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
  });
});
