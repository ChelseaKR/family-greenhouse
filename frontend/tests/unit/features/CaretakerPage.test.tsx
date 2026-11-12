import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { CaretakerPage } from '@/features/caretaker/CaretakerPage';
import i18n, { ensureLanguageCatalog } from '@/i18n';
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

  // A completed row is removed from the list, and two things leave with it:
  // the focus the row's Done button held (it falls to <body>, so the next
  // task is a whole page of Tab presses away) and any words about what just
  // happened (a polite region announces insertions, never removals). The
  // sitter page already replaces both; this page did neither.
  describe('after Done', () => {
    const second: CaretakerTask = {
      taskId: 't2',
      plantId: 'p2',
      plantName: 'Fern',
      taskType: 'water',
      dueDate: new Date(Date.now() + 86_400_000).toISOString(),
      spaceName: 'Kitchen',
      placementNote: null,
      overdue: false,
    };
    const saved = (task: CaretakerTask) => ({
      taskId: task.taskId,
      plantName: task.plantName,
      taskType: task.taskType,
      dueDate: new Date().toISOString(),
      overdue: false,
      visitRecorded: true,
    });

    it('moves focus to the next task and says what was done', async () => {
      getView.mockResolvedValue({ ...view, tasks: [waterTask, second] });
      completeTask.mockResolvedValue(saved(waterTask));
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: /Water the Monstera/ }));

      const next = await screen.findByRole('button', { name: 'Mark “Water the Fern” as done' });
      await waitFor(() => expect(document.activeElement).toBe(next));
      // The sentence arrives as new content inside the page's own polite
      // region, which is what makes a screen reader say it.
      const said = screen.getByText('Marked as done: Monstera.');
      expect(said.closest('[aria-live="polite"]')).not.toBeNull();
    });

    describe('in Spanish', () => {
      afterEach(async () => {
        await i18n.changeLanguage('en');
      });

      it('says what was done in Spanish', async () => {
        await ensureLanguageCatalog('es');
        await i18n.changeLanguage('es');
        getView.mockResolvedValue({ ...view, tasks: [waterTask, second] });
        completeTask.mockResolvedValue(saved(waterTask));
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByRole('button', { name: /^Marcar .*Monstera/ }));

        expect(await screen.findByText('Marcado como hecho: Monstera.')).toBeInTheDocument();
        expect(screen.queryByText(/Marked as done/)).not.toBeInTheDocument();
      });
    });

    it('goes back to the first task left when the last row in the list is completed', async () => {
      getView.mockResolvedValue({ ...view, tasks: [waterTask, second] });
      completeTask.mockResolvedValue(saved(second));
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: /Water the Fern/ }));

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /Water the Fern/ })).not.toBeInTheDocument()
      );
      const first = screen.getByRole('button', { name: 'Mark “Water the Monstera” as done' });
      await waitFor(() => expect(document.activeElement).toBe(first));
    });

    it('moves focus to the closing summary when that was the last task', async () => {
      getView.mockResolvedValue(view);
      completeTask.mockResolvedValue(saved(waterTask));
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: /Water the Monstera/ }));

      const summaryTitle = await screen.findByText('All caught up — thank you');
      await waitFor(() => {
        // `<body>` contains everything, so "contains the summary" alone would
        // pass on exactly the bug this asserts against.
        expect(document.activeElement).not.toBe(document.body);
        expect(document.activeElement).toHaveAttribute('tabindex', '-1');
        expect(document.activeElement?.contains(summaryTitle)).toBe(true);
      });
    });

    it('says each completion, including a second task for the same plant', async () => {
      // Two tasks on one plant produce the same sentence twice. Text that
      // does not change is not an insertion, so the second one has to arrive
      // as a new node or it is never announced.
      const feed: CaretakerTask = { ...waterTask, taskId: 't3', taskType: 'fertilize' };
      getView.mockResolvedValue({ ...view, tasks: [waterTask, feed] });
      // Keyed on the task rather than queued with `...Once`: `clearAllMocks`
      // does not drain a queue, so a leftover value would answer the next
      // test's call.
      completeTask.mockImplementation(async (_token, taskId) =>
        saved(taskId === feed.taskId ? feed : waterTask)
      );
      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: /Water the Monstera/ }));
      const firstSaid = await screen.findByText('Marked as done: Monstera.');

      await user.click(await screen.findByRole('button', { name: /Feed the Monstera/ }));
      await screen.findByText('All caught up — thank you');
      const secondSaid = screen.getByText('Marked as done: Monstera.');
      expect(secondSaid).not.toBe(firstSaid);
    });

    it('leaves focus on the Done button when the completion did not save', async () => {
      getView.mockResolvedValue({ ...view, tasks: [waterTask, second] });
      completeTask.mockRejectedValue(new Error('network'));
      const user = userEvent.setup();
      renderPage();

      const done = await screen.findByRole('button', { name: /Water the Monstera/ });
      await user.click(done);

      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(document.activeElement).toBe(done);
      expect(screen.queryByText('Marked as done: Monstera.')).not.toBeInTheDocument();
    });
  });
});
