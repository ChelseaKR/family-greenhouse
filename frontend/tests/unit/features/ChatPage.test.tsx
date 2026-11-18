import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from '@/features/chat/ChatPage';
import { billingService } from '@/services/billingService';
import { chatService } from '@/services/chatService';
import { useAuthStore } from '@/store/authStore';
import enCatalog from '@/i18n/locales/en/translation.json';
import esCatalog from '@/i18n/locales/es/translation.json';

vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

vi.mock('@/services/billingService', async () => ({
  // The real tier resolver: the page gates on it (ADR 0027).
  effectivePlanId: (
    await vi.importActual<typeof import('@/services/billingService')>('@/services/billingService')
  ).effectivePlanId,
  billingService: {
    getCurrentSubscription: vi.fn(),
    // The locked-feature card reads the catalog to say which plan includes
    // chat and whether payments are open.
    listPlans: vi.fn(),
  },
}));

vi.mock('@/services/householdService', () => ({
  householdService: {
    getHousehold: vi.fn(),
  },
  listMyHouseholds: vi.fn(),
}));

vi.mock('@/services/chatService', () => ({
  getChatStreamUrl: () => null,
  chatService: {
    getBudget: vi.fn(),
    getConversation: vi.fn(),
    sendMessage: vi.fn(),
    streamMessage: vi.fn(),
  },
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ChatPage plan availability', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.mocked(chatService.getBudget).mockResolvedValue({
      inputTokensUsed: 0,
      outputTokensUsed: 0,
      inputTokensCap: 1000,
      outputTokensCap: 1000,
      costUsd: 0,
    });
    vi.mocked(billingService.listPlans).mockResolvedValue({
      paymentsAvailable: true,
      commercialHold: { active: false, effectiveDate: '2026-09-01' },
      plans: [
        { id: 'seedling', name: 'Seedling', description: '', maxPlants: 10, maxMembers: 6 },
        {
          id: 'garden',
          name: 'Garden',
          description: '',
          maxPlants: 500,
          maxMembers: 6,
          monthlyPrice: 4.99,
        },
        {
          id: 'greenhouse',
          name: 'Greenhouse',
          description: '',
          maxPlants: 5000,
          maxMembers: 50,
          monthlyPrice: 9.99,
        },
      ],
    });
    const { householdService, listMyHouseholds } = await import('@/services/householdService');
    vi.mocked(householdService.getHousehold).mockResolvedValue({
      id: 'hh-1',
      name: 'Home',
      createdAt: '',
      createdBy: 'u-admin',
      members: [
        { userId: 'u-admin', name: 'Maria', role: 'admin', joinedAt: '' },
        { userId: 'u-1', name: 'Sam', role: 'member', joinedAt: '' },
      ],
    });
    vi.mocked(listMyHouseholds).mockResolvedValue([
      { householdId: 'hh-1', name: 'Home', role: 'member', joinedAt: '' },
    ]);
    useAuthStore.setState({
      user: {
        id: 'u-1',
        email: 'sam@example.com',
        name: 'Sam',
        householdId: 'hh-1',
        householdRole: 'member',
      },
    });
  });

  it('shows an honest unavailable state instead of a dead composer for Seedling', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'seedling',
    });
    renderPage();

    // Level one: the locked card is the whole page, and as an h2 it left the
    // page with no top-level heading.
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Plant care chat isn’t available on Seedling',
      })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Chat message')).not.toBeInTheDocument();
    expect(chatService.getBudget).not.toHaveBeenCalled();
  });

  it('renders the Seedling gate LOCKED, not hidden: a member sees the plan and can ask the admin', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'seedling',
    });
    renderPage();

    expect(await screen.findByTestId('locked-included')).toHaveTextContent(/Included with Garden/);
    expect(await screen.findByRole('button', { name: 'Ask Maria to upgrade' })).toBeInTheDocument();
  });

  it('renders the composer for an existing Garden household', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'garden',
    });
    renderPage();

    expect(await screen.findByLabelText('Chat message')).toBeInTheDocument();
    expect(chatService.getBudget).toHaveBeenCalledOnce();
  });

  it('says under the message box that suggested reminders wait for a confirmation', async () => {
    // Approved 2026-11-18. The third sentence read "Reminder suggestions wait
    // for your confirm before being created", with "confirm" as a noun. The
    // first two sentences are unchanged.
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'garden',
    });
    renderPage();

    expect(
      await screen.findByText(
        'AI-generated — verify before acting. Refuses pesticide / dosage advice. Suggested reminders are created only after you confirm them.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/your confirm before/)).not.toBeInTheDocument();
  });

  it('says the same in Spanish, with the word the reminder card uses', () => {
    expect(esCatalog.chat.page.disclaimer).toBe(
      'Generado por IA: verifícalo antes de actuar. No da consejos sobre pesticidas ni dosis. Los recordatorios sugeridos solo se crean cuando los confirmas.'
    );
    // "Suggested reminder" / "Recordatorio sugerido" is the card's own title.
    expect(enCatalog.chat.proposal.suggested.startsWith('Suggested reminder')).toBe(true);
    expect(esCatalog.chat.proposal.suggested.startsWith('Recordatorio sugerido')).toBe(true);
    expect(enCatalog.chat.page.disclaimer.includes('your confirm before')).toBe(false);
  });

  it('renders the composer for a household on the no-card Garden trial (ADR 0027)', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'seedling',
      noCardTrial: { state: 'active', endsAt: '2999-01-01T00:00:00.000Z' },
    });
    renderPage();

    expect(await screen.findByLabelText('Chat message')).toBeInTheDocument();
  });

  it('shows the unavailable state again once the no-card trial has ended (ADR 0027)', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'seedling',
      noCardTrial: { state: 'ended', endsAt: '2026-01-01T00:00:00.000Z' },
    });
    renderPage();

    expect(
      await screen.findByRole('heading', { name: 'Plant care chat isn’t available on Seedling' })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Chat message')).not.toBeInTheDocument();
  });

  // Guideline 5.1.2(i): in the apps, the question goes to Amazon Bedrock only
  // after a yes on this device. "Not now" keeps the question in the box.
  it('in the app, asks before the first question goes to Amazon Bedrock', async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    try {
      vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({ planId: 'garden' });
      vi.mocked(chatService.sendMessage).mockResolvedValue({
        response: 'Water when the top inch is dry.',
        conversationId: 'conv-1',
      } as never);
      renderPage();
      const box = await screen.findByLabelText('Chat message');
      fireEvent.change(box, { target: { value: 'How often should I water a pothos?' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      expect(await screen.findByRole('dialog')).toHaveTextContent(
        'Send your question to Amazon Bedrock?'
      );
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(chatService.sendMessage).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Chat message')).toHaveValue(
        'How often should I water a pothos?'
      );

      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
      await waitFor(() =>
        expect(chatService.sendMessage).toHaveBeenCalledWith(
          'How often should I water a pothos?',
          undefined,
          expect.any(String)
        )
      );
    } finally {
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
      localStorage.clear();
    }
  });

  /**
   * #579: Sprout's `disclosure` is a required field of the answer contract and
   * was dropped in `runChatTurn`, so it reached no one. It is persisted with
   * the answer now; this is the assertion that it actually reaches the DOM,
   * rather than merely existing in a type.
   */
  it('shows the Sprout disclosure that came back with a replayed answer', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({ planId: 'garden' });
    sessionStorage.setItem('chat:conversationId:hh-1', 'conv-1');
    vi.mocked(chatService.getConversation).mockResolvedValue([
      {
        timestamp: '2026-07-12T00:00:00Z',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Pothos is toxic to cats.' },
          { type: 'disclosure', text: 'General information, not veterinary advice.' },
          {
            type: 'coverage',
            plants: {
              total: 112,
              included: 40,
              unmatched: 62,
              truncated: 10,
              cap: 100,
              complete: false,
            },
            tasks: { total: 9, included: 9, unmatched: 0, truncated: 0, cap: 100, complete: true },
            partial: true,
          },
        ],
      },
    ]);
    renderPage();

    expect(
      await screen.findByText('General information, not veterinary advice.')
    ).toBeInTheDocument();
    // The answer and its disclosure stay separate elements: the disclosure is
    // Sprout's statement ABOUT the answer, not part of what it said.
    expect(screen.getByText('Pothos is toxic to cats.')).not.toContainElement(
      screen.getByText('General information, not veterinary advice.')
    );
    sessionStorage.removeItem('chat:conversationId:hh-1');
  });

  describe('for a screen reader and a keyboard', () => {
    // A reply that waits until the test lets it through.
    function holdReply() {
      let finish: () => void = () => {};
      vi.mocked(chatService.sendMessage).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({
                conversationId: 'conv-9',
                assistantText: 'You have three plants.',
                proposals: [],
              } as unknown as Awaited<ReturnType<typeof chatService.sendMessage>>);
          })
      );
      return () => finish();
    }

    async function ask(question: string) {
      vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({ planId: 'garden' });
      renderPage();
      const box = await screen.findByLabelText('Chat message');
      box.focus();
      fireEvent.change(box, { target: { value: question } });
      fireEvent.keyDown(box, { key: 'Enter' });
      return box;
    }

    it('puts the conversation in a log named after the page, so a reply is read out', async () => {
      const finish = holdReply();
      await ask('What plants do I have?');

      // Plain divs before: a question went out and nothing was announced back.
      const log = screen.getByRole('log', { name: 'Plant care chat' });
      finish();
      await waitFor(() => expect(log).toHaveTextContent('You have three plants.'));
    });

    it('says who is speaking, which only the bubble side and colour showed', async () => {
      const finish = holdReply();
      await ask('What plants do I have?');
      const log = screen.getByRole('log');
      expect(log).toHaveTextContent('You: What plants do I have?');

      finish();
      await waitFor(() => expect(log).toHaveTextContent('Plant care chat: You have three plants.'));
    });

    it('says once that a reply is on its way, from a region that is always there', async () => {
      const finish = holdReply();
      await ask('What plants do I have?');

      // It was an aria-label on an element with no text that only existed
      // while the dots were showing. A live region reads text, not labels.
      const status = screen.getByRole('status');
      await waitFor(() => expect(status).toHaveTextContent('Plant care chat is replying'));
      expect(screen.getByRole('log')).not.toContainElement(status);
      finish();
      await waitFor(() => expect(status).toBeEmptyDOMElement());
    });

    it('leaves the keyboard in the message box while the reply comes back', async () => {
      const finish = holdReply();
      const box = await ask('What plants do I have?');

      // Disabled, it could not hold focus: every question sent the keyboard
      // user back to the top of the page.
      await waitFor(() => expect(screen.getByRole('status')).not.toBeEmptyDOMElement());
      expect(box).not.toBeDisabled();
      expect(box).toHaveFocus();
      // One question at a time all the same.
      fireEvent.change(box, { target: { value: 'And a second one' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(chatService.sendMessage).toHaveBeenCalledTimes(1);
      finish();
      await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('You have three'));
      expect(box).toHaveFocus();
    });
  });
});
