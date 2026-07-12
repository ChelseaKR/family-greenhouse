import { api, buildAuthHeaders } from './api';
import { useAuthStore } from '@/store/authStore';

/** One content block in a persisted chat message (mirrors the backend's
 *  Anthropic-shaped blocks: text / tool_use / tool_result). */
export interface ChatContentBlock {
  type: string;
  text?: string;
  /** tool_use blocks */
  name?: string;
  /** tool_result blocks */
  tool_use_id?: string;
  /** tool_result payload — JSON-stringified tool output. */
  content?: string;
  /** citation blocks persisted by the Sprout integration */
  title?: string;
  url?: string;
  source?: string;
  fetch_date?: string;
}

export interface ChatMessage {
  timestamp: string;
  role: 'user' | 'assistant';
  content: ChatContentBlock[];
}

export type TaskType = 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';

/** Server-validated reminder proposal (propose_reminder_task tool output).
 *  Creating the actual task is ALWAYS a separate, user-confirmed POST /tasks. */
export interface ProposedReminderTask {
  proposalId: string;
  plantId: string;
  plantName: string;
  type: TaskType;
  customType?: string | null;
  frequencyDays: number;
  assignedTo?: string | null;
  assigneeName?: string | null;
  note?: string | null;
  rationale?: string | null;
}

export interface SendMessageResponse {
  conversationId: string;
  assistantText: string;
  /** Reminder tasks the bot proposed this turn. Render as confirm cards;
   *  confirmation calls POST /tasks separately. */
  proposals: ProposedReminderTask[];
  budgetRemaining: {
    inputTokens: number;
    outputTokens: number;
  };
  provider?: 'sprout' | 'bedrock';
  citations?: Array<{
    title: string;
    url: string;
    source: string;
    fetch_date: string;
  }>;
}

export interface BudgetSnapshot {
  yearMonth: string;
  inputTokensUsed: number;
  outputTokensUsed: number;
  inputTokensCap: number;
  outputTokensCap: number;
  costUsd: number;
}

export type ChatReportReason = 'incorrect' | 'unsafe' | 'offensive' | 'other';

/** SSE events emitted by the streaming chat endpoint (mirrors the backend's
 *  ChatStreamEvent, plus the terminal error event). */
export type ChatStreamEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_start'; name: string }
  | { type: 'proposal'; proposal: ProposedReminderTask }
  | { type: 'done'; result: SendMessageResponse }
  | { type: 'error'; message: string; statusCode?: number };

/**
 * Streaming is opt-in via VITE_CHAT_STREAM_URL (the Lambda Function URL, or
 * the local mock's /chat/messages/stream). Unset → the sync POST is used and
 * behavior is unchanged.
 */
export function getChatStreamUrl(): string | null {
  const url = import.meta.env.VITE_CHAT_STREAM_URL as string | undefined;
  return url && url.trim().length > 0 ? url.trim() : null;
}

/**
 * Re-hydrate a proposal from a persisted tool_result block (GET conversation
 * returns content blocks verbatim). Returns null for anything that isn't a
 * successful propose_reminder_task result, including invalid proposals —
 * those never get a card.
 */
export function parseProposalBlock(block: ChatContentBlock): ProposedReminderTask | null {
  if (block.type !== 'tool_result' || typeof block.content !== 'string') return null;
  try {
    const parsed = JSON.parse(block.content) as {
      status?: string;
      proposal?: ProposedReminderTask;
    };
    if (parsed.status !== 'proposed' || !parsed.proposal) return null;
    const p = parsed.proposal;
    if (!p.plantId || !p.plantName || !p.type || !p.frequencyDays) return null;
    return p;
  } catch {
    // Non-JSON tool_result (plain-text tool error) — not a proposal.
    return null;
  }
}

export const chatService = {
  async reportResponse(input: {
    conversationId: string;
    responseText: string;
    reason: ChatReportReason;
    details?: string;
  }): Promise<{ accepted: true; reportId: string }> {
    const response = await api.post<{ accepted: true; reportId: string }>('/chat/messages', {
      action: 'report',
      ...input,
    });
    return response.data;
  },

  async sendMessage(
    message: string,
    conversationId?: string,
    turnId?: string
  ): Promise<SendMessageResponse> {
    const response = await api.post<SendMessageResponse>('/chat/messages', {
      message,
      conversationId,
      turnId,
    });
    return response.data;
  },

  /**
   * Streamed variant of sendMessage. POSTs to the configured stream URL and
   * parses `data: <json>\n\n` SSE frames, invoking `onEvent` per event.
   * Resolves with the terminal `done` result; throws on HTTP failure, an
   * `error` event, or a stream that ends without `done` — callers fall back
   * to the sync endpoint on ANY throw.
   */
  async streamMessage(
    message: string,
    conversationId: string | undefined,
    onEvent?: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
    turnId?: string
  ): Promise<SendMessageResponse> {
    const url = getChatStreamUrl();
    if (!url) throw new Error('Chat streaming is not configured');

    // Same auth scheme as the axios instance — shared via buildAuthHeaders so
    // the ID-token/access-token fallback and household pin can't drift.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(useAuthStore.getState()),
    };

    // `signal` aborts the in-flight POST when the caller unmounts, so an
    // abandoned turn stops reading instead of running to completion. The reader
    // loop below rejects with an AbortError, which the caller treats as a
    // cancellation (no sync fallback) rather than a stream failure.
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, conversationId, turnId }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Chat stream failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: SendMessageResponse | null = null;

    const handleFrame = (frame: string) => {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let event: ChatStreamEvent;
        try {
          event = JSON.parse(line.slice(5).trim()) as ChatStreamEvent;
        } catch {
          // A single malformed frame (e.g. a partial line, keep-alive
          // comment, or upstream hiccup) shouldn't abort the whole stream
          // and force the sync-endpoint fallback. Skip it. Only a terminal
          // `error` event or a stream that ends without `done` throws.
          continue;
        }
        if (event.type === 'error') {
          throw new Error(event.message || 'Chat stream failed');
        }
        if (event.type === 'done') result = event.result;
        onEvent?.(event);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleFrame(frame);
        sep = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) handleFrame(buffer);

    if (!result) {
      throw new Error('Chat stream ended without a result');
    }
    return result;
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
