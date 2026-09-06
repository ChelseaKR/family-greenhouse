import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { CaretakerPage } from '@/features/caretaker/CaretakerPage';
import {
  caretakerVisitService,
  CaretakerLinkInactiveError,
  type CaretakerTask,
  type CaretakerView,
} from '@/services/caretakerVisitService';

vi.mock('@/services/caretakerVisitService', async () => {
  const actual = await vi.importActual<typeof import('@/services/caretakerVisitService')>(
    '@/services/caretakerVisitService'
  );
  return {
    ...actual,
    caretakerVisitService: {
      getView: vi.fn(),
      completeTask: vi.fn(),
      addNote: vi.fn(),
      addPhoto: vi.fn(),
    },
  };
});

const getView = vi.mocked(caretakerVisitService.getView);
const completeTask = vi.mocked(caretakerVisitService.completeTask);
const addNote = vi.mocked(caretakerVisitService.addNote);

function renderPage(token = 'a'.repeat(64)) {
  return render(
    <MemoryRouter initialEntries={[`/caretaker/${token}`]}>
      <Routes>
        <Route path="/caretaker/:token" element={<CaretakerPage />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const waterTask: CaretakerTask = {
  taskId: 't1',
  plantId: 'p1',
  plantName: 'Monstera',
  taskType: 'water',
  dueDate: new Date(Date.now() - 1000).toISOString(),
  spaceName: 'Living Room',
  placementNote: 'east window, top shelf',
  overdue: true,
};

const view: CaretakerView = {
  caretakerName: 'Dana',
  startsAt: new Date(Date.now() - 86_400_000).toISOString(),
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  permissions: ['task.complete', 'photo.add', 'note.add'],
  tasks: [waterTask],
};

describe('CaretakerPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('greets the caretaker by name and says their actions are on the record', async () => {
    getView.mockResolvedValue(view);
    renderPage();

    expect(await screen.findByText('Hello Dana — here’s what needs doing')).toBeInTheDocument();
    // Being logged under a name is the feature; the person doing the work
    // should be told so rather than discovering it later.
    expect(screen.getByText(/logged under your name/)).toBeInTheDocument();
    expect(screen.getByText('Water the Monstera')).toBeInTheDocument();
    expect(screen.getByText('Living Room · east window, top shelf')).toBeInTheDocument();
  });

  it('shows a friendly message for an expired or revoked seat', async () => {
    getView.mockRejectedValue(new CaretakerLinkInactiveError());
    renderPage();

    expect(await screen.findByText('This caretaker link is no longer active')).toBeInTheDocument();
    expect(screen.queryByText(/what needs doing/)).not.toBeInTheDocument();
  });

  it('distinguishes a failed load from an inactive link', async () => {
    getView.mockRejectedValue(new Error('network'));
    renderPage();

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    // An "all caught up" screen here would be a lie about a list we never read.
    expect(screen.queryByText('All caught up — thank you')).not.toBeInTheDocument();
  });

  it('completes a task and removes it from the list', async () => {
    getView.mockResolvedValue(view);
    completeTask.mockResolvedValue({
      taskId: 't1',
      plantName: 'Monstera',
      taskType: 'water',
      dueDate: new Date().toISOString(),
      overdue: false,
      visitRecorded: true,
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /Mark .* as done/ }));
    await waitFor(() =>
      expect(completeTask).toHaveBeenCalledWith('a'.repeat(64), 't1', expect.any(String))
    );
    expect(await screen.findByText('All caught up — thank you')).toBeInTheDocument();
    // Earned: this caretaker completed the list, so their name IS on it. The
    // claim is scoped to the schedule rather than to "every plant", because
    // the page only ever knew about the tasks in the window.
    expect(
      screen.getByText(
        'Everything on the schedule has been looked after. The household will see your name on each one.'
      )
    ).toBeInTheDocument();
  });

  it('does not congratulate a caretaker who arrived to an empty list', async () => {
    // A window with nothing scheduled makes `remaining` empty on first paint,
    // which used to render "All caught up — thank you / Every plant has been
    // looked after. The household will see your name on each one." to a paid
    // helper who had not touched anything. The second sentence was flatly
    // false — no completion, so no name on anything — and the helper is the
    // one person who cannot open the household's report to find that out.
    getView.mockResolvedValue({ ...view, tasks: [] });
    renderPage();

    // Positive end-state first, then the claims that must not be on the page.
    expect(await screen.findByText('Nothing due right now')).toBeInTheDocument();
    expect(screen.getByText(/nothing has your name on it yet/)).toBeInTheDocument();
    expect(screen.queryByText('All caught up — thank you')).not.toBeInTheDocument();
    expect(screen.queryByText(/has been looked after/)).not.toBeInTheDocument();
    expect(screen.queryByText(/will see your name on each one/)).not.toBeInTheDocument();
  });

  it('warns when the action saved but its visit line did not', async () => {
    getView.mockResolvedValue(view);
    completeTask.mockResolvedValue({
      taskId: 't1',
      plantName: 'Monstera',
      taskType: 'water',
      dueDate: new Date().toISOString(),
      overdue: false,
      visitRecorded: false,
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /Mark .* as done/ }));
    // The household's report is built from visit records, so a gap in one is
    // said out loud rather than rendered as an ordinary success. The wording
    // is "couldn't confirm" rather than "couldn't be added" because the retry
    // branch now reports `false` too, and there the line may well have been
    // written by the attempt whose response was lost (#604).
    expect(
      await screen.findByText(/couldn’t confirm it reached the visit record/)
    ).toBeInTheDocument();
  });

  it('saves a note and confirms it', async () => {
    getView.mockResolvedValue(view);
    addNote.mockResolvedValue({
      text: 'The fern looks unhappy.',
      at: new Date().toISOString(),
      visitRecorded: true,
    });
    renderPage();

    const box = await screen.findByLabelText('Anything the household should know?');
    await userEvent.type(box, 'The fern looks unhappy.');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() =>
      expect(addNote).toHaveBeenCalledWith('a'.repeat(64), 'The fern looks unhappy.')
    );
    expect(await screen.findByText('Note saved')).toBeInTheDocument();
  });

  it('says a note failed to save rather than clearing the box as if it worked', async () => {
    getView.mockResolvedValue(view);
    addNote.mockRejectedValue(new Error('network'));
    renderPage();

    const box = await screen.findByLabelText('Anything the household should know?');
    await userEvent.type(box, 'Something to pass on.');
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }));

    expect(await screen.findByText(/note didn’t save/)).toBeInTheDocument();
    expect(box).toHaveValue('Something to pass on.');
  });
});
