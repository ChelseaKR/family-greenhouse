import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PaperAirplaneIcon,
  SparklesIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import {
  chatService,
  getChatStreamUrl,
  type BudgetSnapshot,
  type SendMessageResponse,
} from '@/services/chatService';
import { getErrorMessage } from '@/services/api';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { ProposalCard } from './ProposalCard';
import { historyToDisplayMessages, type DisplayMessage } from './chatHistory';
import { ReportResponseControl } from './ReportResponseControl';

/**
 * Plant care chat — Bedrock-backed Claude with read-only tool access to the
 * user's plants/tasks/climate, RAG over a bundled plant-care corpus, and
 * a propose-reminder-task tool that surfaces confirm cards inline.
 *
 * Send path: synchronous POST by default (3–8s typical for a tool-use turn).
 * When VITE_CHAT_STREAM_URL is set, replies stream incrementally over SSE
 * with automatic fallback to the sync POST on any stream error. See
 * docs/chat-rag-design.md for the full design.
 */
export function ChatPage() {
  useDocumentTitle('Plant Care Chat');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const streamTextRef = useRef('');
  // Aborts the in-flight stream when the user navigates away mid-turn, so the
  // abandoned request stops and we don't fall back to a second (sync) turn.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const householdId = useActiveHouseholdId();
  const streamUrl = getChatStreamUrl();

  // Per-household, per-tab conversation continuity: remember the thread id in
  // sessionStorage and replay its history (including proposal cards) on
  // reload. A fresh tab still starts a fresh conversation.
  const storageKey = householdId ? `chat:conversationId:${householdId}` : null;

  useEffect(() => {
    if (!storageKey) return;
    let cancelled = false;
    const stored = sessionStorage.getItem(storageKey);
    // Household switch (or first mount): reset to that household's thread.
    setMessages([]);
    setConversationId(stored ?? undefined);
    setError(null);
    if (!stored) return;
    chatService
      .getConversation(stored)
      .then((history) => {
        if (!cancelled) setMessages(historyToDisplayMessages(history));
      })
      .catch(() => {
        // Expired/foreign conversation — drop it and start fresh.
        if (!cancelled) {
          sessionStorage.removeItem(storageKey);
          setConversationId(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  const budgetQuery = useQuery<BudgetSnapshot>({
    // The chat budget is household-scoped.
    queryKey: ['chat-budget', householdId],
    queryFn: () => chatService.getBudget(),
    staleTime: 60_000,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isSending, streamingText]);

  function appendAssistant(data: SendMessageResponse, displayText: string): void {
    setConversationId(data.conversationId);
    if (storageKey) sessionStorage.setItem(storageKey, data.conversationId);
    setMessages((prev) => [
      ...prev,
      {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: displayText,
        proposals: data.proposals?.length ? data.proposals : undefined,
        citations: data.citations?.length ? data.citations : undefined,
      },
    ]);
  }

  async function deliver(message: string): Promise<void> {
    setIsSending(true);
    setError(null);
    streamTextRef.current = '';
    setStreamingText('');
    const controller = new AbortController();
    abortRef.current = controller;
    // One idempotency key for this send, shared by the stream attempt AND its
    // sync fallback. If the stream completes server-side but we fall back, the
    // backend recognizes the turnId and replays the stored result instead of
    // running a second (double-charging, duplicate-message) turn.
    const turnId = crypto.randomUUID();
    try {
      if (streamUrl) {
        try {
          const result = await chatService.streamMessage(
            message,
            conversationId,
            (event) => {
              if (event.type === 'delta') {
                streamTextRef.current += event.text;
                setStreamingText(streamTextRef.current);
              }
            },
            controller.signal,
            turnId
          );
          // Prefer the streamed transcript (it may include tool-turn
          // preamble text); the result is authoritative for proposals/ids.
          appendAssistant(result, streamTextRef.current.trim() || result.assistantText);
          budgetQuery.refetch();
          return;
        } catch {
          // A DELIBERATE abort (the user navigated away) must NOT fall back to
          // the sync endpoint: the stream may already be completing server-side
          // (messages persisted, budget charged), so a sync retry would run a
          // whole second turn — double-charging and duplicating the message.
          if (controller.signal.aborted) return;
          // Any genuine stream failure (network, auth, malformed SSE, error
          // event): discard partial output and retry once via the sync endpoint
          // — reusing turnId so a stream that DID finish server-side replays
          // rather than re-runs.
          streamTextRef.current = '';
          setStreamingText('');
        }
      }
      const data = await chatService.sendMessage(message, conversationId, turnId);
      appendAssistant(data, data.assistantText);
      budgetQuery.refetch();
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(getErrorMessage(err));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsSending(false);
        streamTextRef.current = '';
        setStreamingText('');
      }
    }
  }

  function handleSend(): void {
    const trimmed = input.trim();
    if (!trimmed || isSending) return;
    setError(null);
    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', text: trimmed }]);
    setInput('');
    void deliver(trimmed);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const budget = budgetQuery.data;
  const budgetPct =
    budget && budget.inputTokensCap > 0
      ? Math.min(100, Math.round((budget.inputTokensUsed / budget.inputTokensCap) * 100))
      : 0;
  const lowBudget = budgetPct >= 80;

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col lg:h-dvh">
      <div className="px-4 sm:px-6 lg:px-8 pt-4 pb-2 border-b border-primary-100/80">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="font-serif text-2xl text-ink flex items-center gap-2">
              <SparklesIcon className="h-6 w-6 text-primary-600" />
              Plant care chat
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Ask about your plants, tasks, or local climate. Answers are based on your household's
              actual data and a curated plant-care knowledge base.
            </p>
          </div>
          {budget && (
            <div
              className="w-full text-left text-xs text-gray-600 sm:w-auto sm:text-right"
              title={`${budgetPct}% of monthly chat budget used`}
            >
              {budgetPct}% used this month
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-gray-200 sm:w-32">
                <div
                  className={`h-full ${lowBudget ? 'bg-amber-500' : 'bg-primary-600'}`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6 lg:px-8"
      >
        {messages.length === 0 && !isSending && (
          <div className="max-w-md mx-auto text-center text-sm text-gray-500 mt-12">
            <p>Try asking:</p>
            <ul className="mt-3 space-y-1">
              <li>"What plants do I have?"</li>
              <li>"Why does my monstera have brown leaf tips?"</li>
              <li>"Set up a watering schedule for Bertha."</li>
            </ul>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id}>
            {m.text && (
              <div className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className="max-w-xl">
                  <div
                    className={`rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                      m.role === 'user' ? 'bg-primary-700 text-white' : 'bg-parchment text-gray-900'
                    }`}
                  >
                    {m.text}
                  </div>
                  {m.role === 'assistant' && conversationId && (
                    <ReportResponseControl conversationId={conversationId} responseText={m.text} />
                  )}
                </div>
              </div>
            )}
            {m.role === 'assistant' && m.proposals && m.proposals.length > 0 && (
              <div className="mt-2 space-y-2 max-w-xl">
                {m.proposals.map((p, idx) => (
                  <ProposalCard key={p.proposalId ?? `${m.id}#${idx}`} proposal={p} />
                ))}
              </div>
            )}
            {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
              <ul className="mt-2 max-w-xl space-y-1 text-xs text-gray-600" aria-label="Sources">
                {m.citations.map((citation) => (
                  <li key={`${citation.source}:${citation.fetch_date}`}>
                    <a
                      className="underline decoration-primary-300 underline-offset-2 hover:text-primary-800"
                      href={citation.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {citation.title}
                    </a>{' '}
                    <span>({citation.fetch_date})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {isSending && streamingText && (
          <div className="flex justify-start">
            <div className="max-w-xl rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap bg-parchment text-gray-900">
              {streamingText}
            </div>
          </div>
        )}
        {isSending && !streamingText && (
          <div
            className="flex justify-start"
            role="status"
            aria-label="Plant care chat is replying"
          >
            <div className="bg-parchment text-gray-900 rounded-2xl px-4 py-3 text-sm">
              <span className="inline-flex gap-1" aria-hidden="true">
                <span className="w-1.5 h-1.5 bg-primary-300 rounded-full animate-bounce" />
                <span
                  className="w-1.5 h-1.5 bg-primary-300 rounded-full animate-bounce"
                  style={{ animationDelay: '120ms' }}
                />
                <span
                  className="w-1.5 h-1.5 bg-primary-300 rounded-full animate-bounce"
                  style={{ animationDelay: '240ms' }}
                />
              </span>
            </div>
          </div>
        )}
        {error && (
          <div className="flex justify-start" role="alert">
            <div className="max-w-xl rounded-lg bg-red-50 text-red-900 px-3 py-2 text-sm flex items-start gap-2">
              <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-primary-100/80 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 lg:px-8">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your plants..."
            disabled={isSending}
            rows={1}
            className="min-h-[44px] min-w-0 flex-1 resize-none rounded-lg border border-primary-200 px-3 py-3 text-base focus:border-primary-500 focus:ring-2 focus:ring-primary-500 disabled:bg-parchment/60 sm:text-sm"
            aria-label="Chat message"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-lg bg-primary-700 px-3 py-2 text-white hover:bg-primary-800 disabled:cursor-not-allowed disabled:bg-primary-200"
            aria-label="Send"
          >
            <PaperAirplaneIcon className="h-5 w-5" />
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1">
          AI-generated — verify before acting. Refuses pesticide / dosage advice. Reminder
          suggestions wait for your confirm before being created.
        </p>
      </div>
    </div>
  );
}
