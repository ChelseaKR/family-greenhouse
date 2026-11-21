import { useState, useRef, useEffect, useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
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
import { useThirdPartyConsent } from '@/hooks/useThirdPartyConsent';
import { ProposalCard } from './ProposalCard';
import { historyToDisplayMessages, type DisplayMessage } from './chatHistory';
import { ReportResponseControl } from './ReportResponseControl';
import { billingService, effectivePlanId } from '@/services/billingService';
import { Alert } from '@/components/Alert';
import { Card, CardHeader } from '@/components/Card';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { LockedFeature } from '@/components/LockedFeature';

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
  const { t } = useTranslation();
  useDocumentTitle(t('chat.page.documentTitle'));
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const bedrockConsent = useThirdPartyConsent('chat');
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
  const subscriptionQuery = useQuery({
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: Boolean(householdId),
    staleTime: 60_000,
  });
  // The tier whose features apply now, so a no-card Garden trial counts; not
  // merely the plan on file (ADR 0027).
  // Names the conversation log after the page heading.
  const headingId = useId();
  // Spoken by the status region while a reply is on its way.
  const replyingLabel = t('chat.page.replying');
  const chatPlanId = effectivePlanId(subscriptionQuery.data);
  const chatAvailable = chatPlanId === 'garden' || chatPlanId === 'greenhouse';

  // Per-household, per-tab conversation continuity: remember the thread id in
  // sessionStorage and replay its history (including proposal cards) on
  // reload. A fresh tab still starts a fresh conversation.
  const storageKey = chatAvailable && householdId ? `chat:conversationId:${householdId}` : null;

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
    enabled: chatAvailable,
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
        disclosure: data.disclosure?.trim() ? data.disclosure.trim() : undefined,
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
    // In the apps, nothing goes to Bedrock before a yes on this device
    // (Guideline 5.1.2(i)). "Not now" leaves the question in the box.
    bedrockConsent.run(() => {
      setError(null);
      setMessages((prev) => [...prev, { id: `user-${Date.now()}`, role: 'user', text: trimmed }]);
      setInput('');
      void deliver(trimmed);
      setTimeout(() => inputRef.current?.focus(), 0);
    });
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

  if (subscriptionQuery.isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center" role="status">
        <LoadingSpinner size="lg" />
        <span className="sr-only">{t('chat.availabilityChecking')}</span>
      </div>
    );
  }

  if (subscriptionQuery.isError) {
    return (
      <Card>
        <CardHeader
          as="h1"
          title={t('chat.page.title')}
          description={t('chat.page.errorDescription')}
        />
        <Alert variant="warning">{t('chat.availabilityCheckFailed')}</Alert>
      </Card>
    );
  }

  if (!chatAvailable) {
    // Locked, not hidden (brief §7d): the member sees what chat is, which
    // plan includes it, and can ask the admins for it in one tap. Admins get
    // the change-plan link instead.
    return (
      <LockedFeature feature="chat" title={t('chat.seedlingUnavailableTitle')} headingAs="h1">
        {t('chat.seedlingUnavailableDescription')}
      </LockedFeature>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col lg:h-dvh native-frame:h-dvh!">
      <div className="px-4 sm:px-6 lg:px-8 pt-4 pb-2 border-b border-primary-100/80">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 id={headingId} className="font-serif text-2xl text-ink flex items-center gap-2">
              <SparklesIcon className="h-6 w-6 text-primary-600" />
              {t('chat.page.title')}
            </h1>
            <p className="text-sm text-gray-600 mt-1">{t('chat.page.intro')}</p>
          </div>
          {budget && (
            <div
              className="w-full text-left text-xs text-gray-600 sm:w-auto sm:text-right"
              title={t('chat.page.budgetTitle', { percent: budgetPct })}
            >
              {t('chat.page.budgetUsed', { percent: budgetPct })}
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-gray-200 sm:w-32">
                <div
                  className={`h-full ${lowBudget ? 'bg-amber-500' : 'bg-primary-600'}`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* role="log": a reply appended here is read out, once, when it lands.
          The conversation used to be plain divs, so a screen-reader user sent
          a question and heard nothing back (WCAG 4.1.3). */}
      <div
        ref={scrollRef}
        role="log"
        aria-labelledby={headingId}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6 lg:px-8"
      >
        {messages.length === 0 && !isSending && (
          <div className="max-w-md mx-auto text-center text-sm text-gray-500 mt-12">
            <p>{t('chat.page.tryAsking')}</p>
            <ul className="mt-3 space-y-1">
              <li>{t('chat.page.example1')}</li>
              <li>{t('chat.page.example2')}</li>
              <li>{t('chat.page.example3')}</li>
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
                    {/* PROPOSED WORDING. Who said what was carried only by
                        which side the bubble sits on and its colour, so in
                        the log a question and its answer ran together
                        (WCAG 1.3.1). */}
                    <span className="sr-only">
                      {m.role === 'user' ? t('chat.speakerYou') : t('chat.speakerAssistant')}
                      {': '}
                    </span>
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
            {m.role === 'assistant' && m.disclosure && (
              // Sprout's own disclosure, verbatim. It is a required field of
              // the answer contract and was being dropped before it reached
              // anyone (#579); this app writes none of its words, so there is
              // no wording decision here — only whether the sentence Sprout
              // already wrote is shown at all. The label is ours and is
              // translated; the disclosure itself arrives in the language the
              // question was asked in.
              //
              // role="note" rather than a bare <p>: <p> maps to role
              // `paragraph`, which does not support an accessible name, so an
              // aria-label on it is ignored and the label never reaches a
              // screen reader. `note` supports naming, and is what this is.
              <p
                role="note"
                className="mt-2 max-w-xl text-xs text-gray-600 italic"
                aria-label={t('chat.disclosureLabel')}
              >
                {m.disclosure}
              </p>
            )}
            {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
              <ul
                className="mt-2 max-w-xl space-y-1 text-xs text-gray-600"
                aria-label={t('chat.page.sources')}
              >
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
        {/* The reply while it streams is for the eyes only. It is rewritten
            many times a second, and a live region would read each fragment;
            the finished message above is what gets announced. */}
        {isSending && streamingText && (
          <div className="flex justify-start" aria-hidden="true">
            <div className="max-w-xl rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap bg-parchment text-gray-900">
              {streamingText}
            </div>
          </div>
        )}
        {isSending && !streamingText && (
          <div className="flex justify-start">
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
              <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-primary-100/80 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 lg:px-8 native-frame:pb-3!">
        {/* Always in the document and outside the log, so "replying" is said
            once when a question is sent. It used to be an aria-label on a
            status element that only existed while the dots were showing, with
            no text in it: there was nothing for a live region to read. */}
        <p className="sr-only" role="status">
          {isSending ? replyingLabel : ''}
        </p>
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('chat.page.placeholder')}
            // Not disabled while a reply is on its way: a disabled field
            // cannot hold focus, so sending a question threw the keyboard
            // user to the top of the page, every time (WCAG 2.4.3).
            // handleSend refuses a second send until this one is back.
            rows={1}
            className="min-h-[44px] min-w-0 flex-1 resize-none rounded-lg border border-primary-500 px-3 py-3 text-base focus:border-primary-500 focus:ring-2 focus:ring-primary-500 disabled:bg-parchment/60 sm:text-sm"
            aria-label={t('chat.page.messageLabel')}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-lg bg-primary-700 px-3 py-2 text-white hover:bg-primary-800 forced-colors:border disabled:cursor-not-allowed disabled:bg-primary-200"
            aria-label={t('chat.page.send')}
          >
            <PaperAirplaneIcon className="h-5 w-5" />
          </button>
        </div>
        {bedrockConsent.dialog}
        <p className="text-xs text-gray-600 mt-1">{t('chat.page.disclaimer')}</p>
      </div>
    </div>
  );
}
