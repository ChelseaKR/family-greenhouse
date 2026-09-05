import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from '@/features/chat/ChatPage';
import { billingService } from '@/services/billingService';
import { chatService } from '@/services/chatService';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

vi.mock('@/services/billingService', () => ({
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

    expect(
      await screen.findByRole('heading', {
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
            plants: { total: 112, included: 40, unmatched: 62, truncated: 10, cap: 100 },
            tasks: { total: 9, included: 9, unmatched: 0, truncated: 0, cap: 100 },
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
});
