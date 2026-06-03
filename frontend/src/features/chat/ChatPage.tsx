import { useState, useRef, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PaperAirplaneIcon,
  SparklesIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  chatService,
  type BudgetSnapshot,
  type ProposedReminderTask,
} from '@/services/chatService';
import { taskService } from '@/services/taskService';
import { getErrorMessage } from '@/services/api';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Reminder proposals attached to this assistant turn (only on assistant
   *  messages, and only when the bot called `propose_reminder_task`). */
  proposals?: ProposedReminderTask[];
}

/**
 * Plant care chat — Bedrock-backed Claude with read-only tool access to the
 * user's plants/tasks/climate, RAG over a bundled plant-care corpus, and
 * a propose-reminder-task tool that surfaces Confirm/Cancel cards inline.
 *
 * Synchronous send (3–8s typical for a tool-use turn). See
 * docs/chat-rag-design.md for the full design.
 */
export function ChatPage() {
  useDocumentTitle('Plant Care Chat');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [confirmedProposalKeys, setConfirmedProposalKeys] = useState<Set<string>>(new Set());
  const [dismissedProposalKeys, setDismissedProposalKeys] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();

  const budgetQuery = useQuery<BudgetSnapshot>({
    queryKey: ['chat-budget'],
    queryFn: () => chatService.getBudget(),
    staleTime: 60_000,
  });

  const sendMutation = useMutation({
    mutationFn: (message: string) => chatService.sendMessage(message, conversationId),
    onSuccess: (data) => {
      setConversationId(data.conversationId);
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: data.assistantText,
          proposals: data.proposals?.length ? data.proposals : undefined,
        },
      ]);
      budgetQuery.refetch();
    },
    onError: (err) => {
      setError(getErrorMessage(err));
    },
  });

  const confirmProposalMutation = useMutation({
    mutationFn: async (proposal: ProposedReminderTask) =>
      taskService.createTask({
        plantId: proposal.plantId,
        type: proposal.type,
        frequency: proposal.frequencyDays,
      }),
    onSuccess: () => {
      // Invalidate tasks so the Tasks page reflects the new reminder.
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['upcoming-tasks'] });
    },
    onError: (err) => {
      setError(getErrorMessage(err));
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sendMutation.isPending]);

  function handleSend(): void {
    const trimmed = input.trim();
    if (!trimmed || sendMutation.isPending) return;
    setError(null);
    setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', text: trimmed }]);
    setInput('');
    sendMutation.mutate(trimmed);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function proposalKey(messageId: string, idx: number): string {
    return `${messageId}#${idx}`;
  }

  function handleConfirmProposal(
    messageId: string,
    idx: number,
    proposal: ProposedReminderTask
  ): void {
    setConfirmedProposalKeys((s) => new Set(s).add(proposalKey(messageId, idx)));
    confirmProposalMutation.mutate(proposal);
  }

  function handleDismissProposal(messageId: string, idx: number): void {
    setDismissedProposalKeys((s) => new Set(s).add(proposalKey(messageId, idx)));
  }

  const budget = budgetQuery.data;
  const budgetPct =
    budget && budget.inputTokensCap > 0
      ? Math.min(100, Math.round((budget.inputTokensUsed / budget.inputTokensCap) * 100))
      : 0;
  const lowBudget = budgetPct >= 80;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="px-4 sm:px-6 lg:px-8 pt-4 pb-2 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
              <SparklesIcon className="h-6 w-6 text-primary-600" />
              Plant care chat
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Ask about your plants, tasks, or local climate. Answers are based on your household's
              actual data and a curated plant-care knowledge base.
            </p>
          </div>
          {budget && (
            <div
              className="text-right text-xs text-gray-500"
              title={`${budgetPct}% of monthly chat budget used`}
            >
              {budgetPct}% used this month
              <div className="w-32 h-1.5 bg-gray-200 rounded mt-1 overflow-hidden">
                <div
                  className={`h-full ${lowBudget ? 'bg-amber-500' : 'bg-primary-600'}`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-4 space-y-4">
        {messages.length === 0 && (
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
            <div className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-xl rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                  m.role === 'user' ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-900'
                }`}
              >
                {m.text}
              </div>
            </div>
            {m.role === 'assistant' && m.proposals && m.proposals.length > 0 && (
              <div className="mt-2 space-y-2 max-w-xl">
                {m.proposals.map((p, idx) => {
                  const key = proposalKey(m.id, idx);
                  const confirmed = confirmedProposalKeys.has(key);
                  const dismissed = dismissedProposalKeys.has(key);
                  if (dismissed) return null;
                  return (
                    <div
                      key={key}
                      className="border border-primary-200 bg-primary-50 rounded-lg p-3 text-sm"
                    >
                      <div className="font-medium text-gray-900">
                        {confirmed ? '✓ Reminder created: ' : 'Suggested reminder: '}
                        {p.type === 'custom' ? 'Custom task' : p.type} for {p.plantName}
                      </div>
                      <div className="text-gray-600 mt-0.5">
                        Every {p.frequencyDays} day{p.frequencyDays === 1 ? '' : 's'}
                        {p.rationale ? ` — ${p.rationale}` : ''}
                      </div>
                      {!confirmed && (
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleConfirmProposal(m.id, idx, p)}
                            disabled={confirmProposalMutation.isPending}
                            className="rounded bg-primary-600 text-white px-3 py-1 text-xs font-medium hover:bg-primary-700 disabled:bg-gray-300 flex items-center gap-1"
                          >
                            <CheckCircleIcon className="h-4 w-4" />
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDismissProposal(m.id, idx)}
                            className="rounded text-gray-600 px-2 py-1 text-xs hover:bg-gray-100 flex items-center gap-1"
                          >
                            <XMarkIcon className="h-4 w-4" />
                            Dismiss
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {sendMutation.isPending && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-900 rounded-2xl px-4 py-3 text-sm">
              <span className="inline-flex gap-1">
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" />
                <span
                  className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
                  style={{ animationDelay: '120ms' }}
                />
                <span
                  className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
                  style={{ animationDelay: '240ms' }}
                />
              </span>
            </div>
          </div>
        )}
        {error && (
          <div className="flex justify-start">
            <div className="max-w-xl rounded-lg bg-red-50 text-red-900 px-3 py-2 text-sm flex items-start gap-2">
              <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your plants..."
            disabled={sendMutation.isPending}
            rows={1}
            className="flex-1 resize-none border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-gray-50"
            aria-label="Chat message"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || sendMutation.isPending}
            className="rounded-lg bg-primary-600 text-white px-3 py-2 hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            aria-label="Send"
          >
            <PaperAirplaneIcon className="h-5 w-5" />
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          AI-generated — verify before acting. Refuses pesticide / dosage advice. Reminder
          suggestions wait for your confirm before being created.
        </p>
      </div>
    </div>
  );
}
