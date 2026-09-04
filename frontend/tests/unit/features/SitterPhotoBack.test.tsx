/**
 * Sitter photo-back panel. The server owns every limit; these tests pin what
 * the PAGE must not get wrong: hiding the panel only on a settled "not
 * included", never on a failed status read; surfacing the server's refusal
 * verbatim; and falling back to the page's "link is closed" screen when the
 * window shuts mid-visit.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SitterPhotoBack } from '@/features/sitter/SitterPhotoBack';
import { decodedBytes } from '@/features/sitter/sitterPhotoPrep';
import { SitterLinkInactiveError, type SitterTask } from '@/services/sitterService';
import { SitterPhotoRefusedError, sitterPhotoService } from '@/services/sitterPhotoService';

vi.mock('@/services/sitterPhotoService', async () => {
  const actual = await vi.importActual<typeof import('@/services/sitterPhotoService')>(
    '@/services/sitterPhotoService'
  );
  return { ...actual, sitterPhotoService: { getStatus: vi.fn(), upload: vi.fn() } };
});
vi.mock('@/utils/image', () => ({
  // The canvas pipeline doesn't exist in jsdom; hand back a tiny blob.
  downscaleImage: vi.fn(async () => new Blob(['tiny'], { type: 'image/webp' })),
}));

const getStatus = vi.mocked(sitterPhotoService.getStatus);
const upload = vi.mocked(sitterPhotoService.upload);

const TOKEN = 'a'.repeat(64);
const tasks: SitterTask[] = [
  {
    taskId: 't1',
    plantName: 'Monstera',
    taskType: 'water',
    dueDate: new Date().toISOString(),
    spaceName: null,
    placementNote: null,
    overdue: false,
  },
];

function renderPanel(onLinkInactive = vi.fn()) {
  render(<SitterPhotoBack token={TOKEN} tasks={tasks} onLinkInactive={onLinkInactive} />);
  return onLinkInactive;
}

async function pickAPhoto() {
  const file = new File(['bytes'], 'leaf.jpg', { type: 'image/jpeg' });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, file);
  // Shrinking the photo is async, and the Send button reads "Loading..." until
  // it finishes. Wait for the preview so the click below can't race it.
  await screen.findByAltText('The photo you picked');
}

describe('SitterPhotoBack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStatus.mockResolvedValue({ enabled: true, max: 60, used: 2, remaining: 58 });
  });

  it('offers the control and reports how much of the cap is left', async () => {
    renderPanel();
    expect(await screen.findByText('Send a photo home')).toBeInTheDocument();
    expect(screen.getByText('58 photos left on this link')).toBeInTheDocument();
  });

  it('hides itself only when the plan settled as not including photo-back', async () => {
    getStatus.mockResolvedValue({ enabled: false, max: 60, used: null, remaining: null });
    renderPanel();
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(screen.queryByText('Send a photo home')).not.toBeInTheDocument();
  });

  it('keeps the panel and says the count is unknown when the status read FAILS', async () => {
    // A failed read is not "photo-back is off" and not "0 of 60 used".
    getStatus.mockRejectedValue(new Error('network'));
    renderPanel();
    expect(await screen.findByText('Send a photo home')).toBeInTheDocument();
    expect(screen.getByText(/couldn’t check how many photos are left/)).toBeInTheDocument();
    expect(screen.queryByText(/photos left on this link/)).not.toBeInTheDocument();
  });

  it('sends a chosen photo for a chosen plant and confirms it', async () => {
    upload.mockResolvedValue({
      photoId: 'ph1',
      plantName: 'Monstera',
      caption: null,
      uploadedAt: new Date().toISOString(),
      used: 3,
      remaining: 57,
    });
    renderPanel();
    await screen.findByText('Send a photo home');

    await userEvent.selectOptions(screen.getByLabelText('Which plant is it?'), 't1');
    await pickAPhoto();
    await userEvent.type(screen.getByLabelText('Add a note (optional)'), 'Perky');
    await userEvent.click(screen.getByRole('button', { name: 'Send photo' }));

    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(upload).toHaveBeenCalledWith(TOKEN, {
      taskId: 't1',
      image: expect.stringContaining('data:'),
      caption: 'Perky',
    });
    expect(await screen.findByText('Sent 1 photo. Thank you!')).toBeInTheDocument();
    expect(screen.getByText('57 photos left on this link')).toBeInTheDocument();
  });

  it('shows the server’s refusal verbatim (cap reached, too large, not an image)', async () => {
    upload.mockRejectedValue(
      new SitterPhotoRefusedError(409, 'This link has reached its 60-photo limit.')
    );
    renderPanel();
    await screen.findByText('Send a photo home');
    await userEvent.selectOptions(screen.getByLabelText('Which plant is it?'), 't1');
    await pickAPhoto();
    await userEvent.click(screen.getByRole('button', { name: 'Send photo' }));

    expect(
      await screen.findByText('This link has reached its 60-photo limit.')
    ).toBeInTheDocument();
  });

  it('falls back to the page’s closed-link screen when the window shuts mid-visit', async () => {
    upload.mockRejectedValue(new SitterLinkInactiveError());
    const onLinkInactive = renderPanel();
    await screen.findByText('Send a photo home');
    await userEvent.selectOptions(screen.getByLabelText('Which plant is it?'), 't1');
    await pickAPhoto();
    await userEvent.click(screen.getByRole('button', { name: 'Send photo' }));

    await waitFor(() => expect(onLinkInactive).toHaveBeenCalled());
  });

  it('refuses a non-image file before it reaches the network', async () => {
    renderPanel();
    await screen.findByText('Send a photo home');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    // applyAccept: false so the browser-level accept filter doesn't swallow
    // the pick — the guard under test is ours, not the input's.
    await userEvent.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }), {
      applyAccept: false,
    });

    expect(await screen.findByText(/isn’t an image/)).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('decodedBytes', () => {
  it('measures the decoded size of a data URL, allowing for padding', () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const url = `data:image/png;base64,${bytes.toString('base64')}`;
    expect(decodedBytes(url)).toBe(5);
  });
});
