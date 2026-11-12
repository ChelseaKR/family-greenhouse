/**
 * The public scan page is where a stranger-to-the-app acts on what we tell
 * them, so the two things pinned hardest here are (1) a failed care-history
 * read says "couldn't load care history" and NEVER "never watered", and
 * (2) a completion is attributed to the name they typed. The PIN states and
 * the revoked-label state are covered too — they are what a household sees
 * after rotating a leaked label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ScanTagPage } from '@/features/tags/ScanTagPage';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import {
  publicTagService,
  TagInactiveError,
  TagLockedError,
  TagPinError,
  type TagView,
} from '@/services/plantTagService';

vi.mock('@/services/plantTagService', async () => {
  const actual = await vi.importActual<typeof import('@/services/plantTagService')>(
    '@/services/plantTagService'
  );
  return {
    ...actual,
    publicTagService: { getView: vi.fn(), completeTask: vi.fn() },
  };
});

const getView = vi.mocked(publicTagService.getView);
const completeTask = vi.mocked(publicTagService.completeTask);
const TOKEN = 'a3f9'.repeat(16);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/tag/${TOKEN}`]}>
      <Routes>
        <Route path="/tag/:token" element={<ScanTagPage />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const dueWater = {
  taskId: 't1',
  taskType: 'water',
  dueDate: new Date(Date.now() - 3_600_000).toISOString(),
  overdue: true,
};

function view(overrides: Partial<TagView> = {}): TagView {
  return {
    plantName: 'Monstera',
    species: 'Monstera deliciosa',
    careNote: 'We bottom-water this one.',
    careNoteSource: 'rule',
    history: {
      status: 'ok',
      lastCare: null,
      lastWatered: {
        taskType: 'water',
        completedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        completedByName: 'Dad',
        viaTag: false,
      },
    },
    tasks: [dueWater],
    ...overrides,
  };
}

describe('ScanTagPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('answers "who last watered this" without an account', async () => {
    getView.mockResolvedValue(view());
    renderPage();

    expect(await screen.findByRole('heading', { level: 1, name: 'Monstera' })).toBeInTheDocument();
    expect(screen.getByTestId('last-care')).toHaveTextContent('Last watered 2 days ago by Dad.');
    // The plant's house rule travels with the label.
    expect(screen.getByText('We bottom-water this one.')).toBeInTheDocument();
    expect(getView).toHaveBeenCalledWith(TOKEN, undefined, expect.anything());
  });

  it('shows no house-rule section when the household wrote no rule', async () => {
    getView.mockResolvedValue(view({ careNote: null, careNoteSource: null }));
    renderPage();

    expect(await screen.findByRole('heading', { level: 1, name: 'Monstera' })).toBeInTheDocument();
    expect(screen.queryByText('How this household does it')).not.toBeInTheDocument();
  });

  it('says the care history could not be loaded — never "never watered"', async () => {
    getView.mockResolvedValue(view({ history: { status: 'unavailable' } }));
    renderPage();

    const line = await screen.findByTestId('last-care');
    expect(line).toHaveTextContent(/couldn’t load care history/i);
    expect(line).not.toHaveTextContent(/nothing has been logged/i);
    // The rest of the page still works — the plant is still identifiable.
    expect(screen.getByRole('heading', { level: 1, name: 'Monstera' })).toBeInTheDocument();
  });

  it('distinguishes a genuinely empty history from a failed read', async () => {
    getView.mockResolvedValue(
      view({ history: { status: 'ok', lastCare: null, lastWatered: null } })
    );
    renderPage();

    expect(await screen.findByTestId('last-care')).toHaveTextContent(
      'Nothing has been logged for this plant yet.'
    );
  });

  it('completes the due task under the typed name and thanks them by it', async () => {
    getView.mockResolvedValue(view());
    completeTask.mockResolvedValue({
      taskId: 't1',
      taskType: 'water',
      dueDate: new Date().toISOString(),
      completedByName: 'Grandma',
      alreadyDone: false,
    });
    renderPage();

    await userEvent.type(await screen.findByLabelText(/Who shall we say did it\?/), 'Grandma');
    await userEvent.click(
      screen.getByRole('button', { name: 'I just did this Water the Monstera' })
    );

    expect(await screen.findByText('Thank you, Grandma!')).toBeInTheDocument();
    expect(completeTask).toHaveBeenCalledWith({
      token: TOKEN,
      taskId: 't1',
      displayName: 'Grandma',
      expectedNextDue: dueWater.dueDate,
      pin: undefined,
    });
    // The name is remembered on this device so it is typed once, not weekly.
    expect(localStorage.getItem('fg.tagDisplayName')).toBe('Grandma');
  });

  it('asks for a name before completing anything', async () => {
    getView.mockResolvedValue(view());
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'I just did this Water the Monstera' })
    );
    expect(
      await screen.findByText(/Pop a name in first so the household knows who to thank/)
    ).toBeInTheDocument();
    expect(completeTask).not.toHaveBeenCalled();
  });

  it('shows a friendly message for a revoked label rather than an error', async () => {
    getView.mockRejectedValue(new TagInactiveError());
    renderPage();

    expect(await screen.findByText('This label isn’t active any more')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /I just did this/ })).not.toBeInTheDocument();
  });

  it('asks for the household PIN, retries with it, and flags a wrong one', async () => {
    getView.mockRejectedValueOnce(new TagPinError('required'));
    renderPage();

    expect(await screen.findByText('This household uses a PIN')).toBeInTheDocument();
    const field = screen.getByLabelText('PIN');

    // A wrong PIN comes back labelled as wrong, not as a generic failure.
    getView.mockRejectedValueOnce(new TagPinError('wrong'));
    await userEvent.type(field, '0000');
    await userEvent.click(screen.getByRole('button', { name: 'Open the plant' }));
    expect(await screen.findByText('That PIN isn’t right. Have another go.')).toBeInTheDocument();

    getView.mockResolvedValueOnce(view());
    await userEvent.clear(screen.getByLabelText('PIN'));
    await userEvent.type(screen.getByLabelText('PIN'), '4321');
    await userEvent.click(screen.getByRole('button', { name: 'Open the plant' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Monstera' })).toBeInTheDocument();
    expect(getView).toHaveBeenLastCalledWith(TOKEN, '4321', undefined);

    // Once unlocked, the PIN rides along with the completion too.
    completeTask.mockResolvedValue({
      taskId: 't1',
      taskType: 'water',
      dueDate: new Date().toISOString(),
      completedByName: 'Grandma',
      alreadyDone: false,
    });
    await userEvent.type(screen.getByLabelText(/Who shall we say did it\?/), 'Grandma');
    await userEvent.click(
      screen.getByRole('button', { name: 'I just did this Water the Monstera' })
    );
    await waitFor(() =>
      expect(completeTask).toHaveBeenCalledWith(expect.objectContaining({ pin: '4321' }))
    );
  });

  it('reports a locked label as locked, not as a wrong PIN', async () => {
    getView.mockRejectedValue(
      new TagLockedError(new Date(Date.now() + 15 * 60 * 1000).toISOString())
    );
    renderPage();

    expect(await screen.findByText('This label is locked for a bit')).toBeInTheDocument();
    expect(screen.queryByLabelText('PIN')).not.toBeInTheDocument();
  });

  it('keeps the task actionable when the completion itself fails', async () => {
    getView.mockResolvedValue(view());
    completeTask.mockRejectedValue(new Error('network'));
    renderPage();

    await userEvent.type(await screen.findByLabelText(/Who shall we say did it\?/), 'Grandma');
    await userEvent.click(
      screen.getByRole('button', { name: 'I just did this Water the Monstera' })
    );

    expect(await screen.findByText('We couldn’t record that')).toBeInTheDocument();
    expect(
      screen.getByText('Nothing was logged. Please tap again in a moment.')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'I just did this Water the Monstera' })
    ).toBeEnabled();
  });

  it('says so plainly when nothing is due', async () => {
    getView.mockResolvedValue(view({ tasks: [] }));
    renderPage();

    expect(
      await screen.findByText('Nothing needs doing right now — thanks for checking on it!')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /I just did this/ })).not.toBeInTheDocument();
  });

  // A plant with more than one task due used to offer several buttons all
  // named "I just did this", and completing one dropped focus to <body> as
  // its row left the list. Each button now carries its row's task in its
  // name, and focus goes where the sitter page sends it: the next task, or
  // the thanks when nothing is left.
  describe('after Done', () => {
    const dueFeed = {
      taskId: 't2',
      taskType: 'fertilize',
      dueDate: new Date(Date.now() + 3_600_000).toISOString(),
      overdue: false,
    };
    const saved = (taskId: string, taskType: string) => ({
      taskId,
      taskType,
      dueDate: new Date().toISOString(),
      completedByName: 'Grandma',
      alreadyDone: false,
    });

    it('names each Done button after its own task', async () => {
      getView.mockResolvedValue(view({ tasks: [dueWater, dueFeed] }));
      renderPage();

      // The visible words stay first in the name, so "click I just did this"
      // still works by voice.
      expect(
        await screen.findByRole('button', { name: 'I just did this Water the Monstera' })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'I just did this Fertilize the Monstera' })
      ).toBeInTheDocument();
      const names = screen
        .getAllByRole('button', { name: /I just did this/ })
        .map((button) => button.textContent);
      // Same visible label on both: only the accessible name tells them apart.
      expect(names).toEqual(['I just did this', 'I just did this']);
    });

    describe('in Spanish', () => {
      afterEach(async () => {
        await i18n.changeLanguage('en');
      });

      it('names each button in Spanish, from the Spanish already on the page', async () => {
        await ensureLanguageCatalog('es');
        await i18n.changeLanguage('es');
        getView.mockResolvedValue(view({ tasks: [dueWater, dueFeed] }));
        renderPage();

        expect(
          await screen.findByRole('button', { name: 'Acabo de hacerlo Regar: Monstera' })
        ).toBeInTheDocument();
        expect(
          screen.getByRole('button', { name: 'Acabo de hacerlo Fertilizar: Monstera' })
        ).toBeInTheDocument();
      });
    });

    it('moves focus to the next task', async () => {
      getView.mockResolvedValue(view({ tasks: [dueWater, dueFeed] }));
      completeTask.mockResolvedValue(saved('t1', 'water'));
      const user = userEvent.setup();
      renderPage();

      await user.type(await screen.findByLabelText(/Who shall we say did it\?/), 'Grandma');
      await user.click(screen.getByRole('button', { name: /Water the Monstera/ }));

      expect(await screen.findByText('Thank you, Grandma!')).toBeInTheDocument();
      const next = screen.getByRole('button', { name: 'I just did this Fertilize the Monstera' });
      await waitFor(() => expect(document.activeElement).toBe(next));
    });

    it('moves focus to the thanks when that was the last task', async () => {
      getView.mockResolvedValue(view());
      completeTask.mockResolvedValue(saved('t1', 'water'));
      const user = userEvent.setup();
      renderPage();

      await user.type(await screen.findByLabelText(/Who shall we say did it\?/), 'Grandma');
      await user.click(screen.getByRole('button', { name: /Water the Monstera/ }));

      const thanks = await screen.findByText('Thank you, Grandma!');
      await waitFor(() => {
        // `<body>` contains everything, so "contains the thanks" alone would
        // pass on exactly the bug this asserts against.
        expect(document.activeElement).not.toBe(document.body);
        expect(document.activeElement).toHaveAttribute('tabindex', '-1');
        expect(document.activeElement?.contains(thanks)).toBe(true);
      });
    });

    it('does not move focus when a name is still needed', async () => {
      getView.mockResolvedValue(view({ tasks: [dueWater, dueFeed] }));
      const user = userEvent.setup();
      renderPage();

      const done = await screen.findByRole('button', { name: /Water the Monstera/ });
      await user.click(done);

      expect(await screen.findByText(/Pop a name in first/)).toBeInTheDocument();
      expect(completeTask).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(done);
    });
  });
});
