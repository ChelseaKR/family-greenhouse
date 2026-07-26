import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from '@/features/chat/ChatPage';
import { billingService } from '@/services/billingService';
import { chatService } from '@/services/chatService';

vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

vi.mock('@/services/billingService', () => ({
  billingService: {
    getCurrentSubscription: vi.fn(),
  },
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
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.mocked(chatService.getBudget).mockResolvedValue({
      inputTokensUsed: 0,
      outputTokensUsed: 0,
      inputTokensCap: 1000,
      outputTokensCap: 1000,
      costUsd: 0,
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

  it('renders the composer for an existing Garden household', async () => {
    vi.mocked(billingService.getCurrentSubscription).mockResolvedValue({
      planId: 'garden',
    });
    renderPage();

    expect(await screen.findByLabelText('Chat message')).toBeInTheDocument();
    expect(chatService.getBudget).toHaveBeenCalledOnce();
  });
});
