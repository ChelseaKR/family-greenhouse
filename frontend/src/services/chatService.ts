import { api } from './api';

export interface ChatMessage {
  timestamp: string;
  role: 'user' | 'assistant';
  content: Array<{ type: string; text?: string; name?: string }>;
}

export type TaskType = 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';

export interface ProposedReminderTask {
  plantId: string;
  plantName: string;
  type: TaskType;
  frequencyDays: number;
  rationale?: string | null;
}

export interface SendMessageResponse {
  conversationId: string;
  assistantText: string;
  /** Reminder tasks the bot proposed this turn. Render as Confirm/Cancel
   *  cards; confirmation calls POST /tasks separately. */
  proposals: ProposedReminderTask[];
  budgetRemaining: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface BudgetSnapshot {
  yearMonth: string;
  inputTokensUsed: number;
  outputTokensUsed: number;
  inputTokensCap: number;
  outputTokensCap: number;
  costUsd: number;
}

export const chatService = {
  async sendMessage(message: string, conversationId?: string): Promise<SendMessageResponse> {
    const response = await api.post<SendMessageResponse>('/chat/messages', {
      message,
      conversationId,
    });
    return response.data;
  },

  async getConversation(conversationId: string): Promise<ChatMessage[]> {
    const response = await api.get<ChatMessage[]>(`/chat/conversations/${conversationId}/messages`);
    return response.data;
  },

  async getBudget(): Promise<BudgetSnapshot> {
    const response = await api.get<BudgetSnapshot>('/chat/budget');
    return response.data;
  },
};
