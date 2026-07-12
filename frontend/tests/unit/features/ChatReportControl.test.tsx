import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReportResponseControl } from '@/features/chat/ReportResponseControl';

vi.mock('@/services/chatService', async () => {
  const actual =
    await vi.importActual<typeof import('@/services/chatService')>('@/services/chatService');
  return {
    ...actual,
    chatService: { ...actual.chatService, reportResponse: vi.fn() },
  };
});

describe('AI response reporting', () => {
  it('collects a reason and sends the flagged response in-app', async () => {
    const { chatService } = await import('@/services/chatService');
    vi.mocked(chatService.reportResponse).mockResolvedValueOnce({
      accepted: true,
      reportId: 'report-1',
    });
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ReportResponseControl
          conversationId="550e8400-e29b-41d4-a716-446655440000"
          responseText="Use twice as much pesticide."
        />
      </QueryClientProvider>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Report response' }));
    await user.selectOptions(screen.getByLabelText('What went wrong?'), 'unsafe');
    await user.type(screen.getByLabelText('Details (optional)'), 'This dosage seems dangerous.');
    await user.click(screen.getByRole('button', { name: 'Submit report' }));

    await waitFor(() =>
      expect(chatService.reportResponse).toHaveBeenCalledWith({
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        responseText: 'Use twice as much pesticide.',
        reason: 'unsafe',
        details: 'This dosage seems dangerous.',
      })
    );
    expect(await screen.findByText('Response reported. Thank you.')).toBeInTheDocument();
  });
});
