import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
  chatService,
  getChatStreamUrl,
  parseProposalBlock,
  type ChatStreamEvent,
  type SendMessageResponse,
} from '@/services/chatService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const STREAM_URL = 'https://stream.example.test/chat';

const doneResult: SendMessageResponse = {
  conversationId: 'c1',
  assistantText: 'Water it weekly.',
  proposals: [],
  budgetRemaining: { inputTokens: 100, outputTokens: 50 },
};

/** Minimal stand-in for the fetch Response the stream reader consumes: the
 *  service only touches `ok`, `status`, and `body.getReader()`. */
function streamResponse(chunks: string[], init?: { ok?: boolean; status?: number }) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: encoder.encode(chunks[index++]) }
            : { done: true, value: undefined },
      }),
    },
  };
}

function frame(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe('parseProposalBlock', () => {
  const proposal = {
    proposalId: 'pr1',
    plantId: 'p1',
    plantName: 'Pothos',
    type: 'water' as const,
    frequencyDays: 7,
  };

  it('re-hydrates a successful propose_reminder_task result', () => {
    expect(
      parseProposalBlock({
        type: 'tool_result',
        content: JSON.stringify({ status: 'proposed', proposal }),
      })
    ).toEqual(proposal);
  });

  it('ignores blocks that are not tool results or carry no string content', () => {
    expect(parseProposalBlock({ type: 'text', text: 'hello' })).toBeNull();
    expect(parseProposalBlock({ type: 'tool_result' })).toBeNull();
  });

  it('ignores non-JSON tool output instead of throwing', () => {
    expect(parseProposalBlock({ type: 'tool_result', content: 'plant lookup failed' })).toBeNull();
  });

  it('refuses a result whose status is not "proposed" or whose proposal is missing', () => {
    expect(
      parseProposalBlock({ type: 'tool_result', content: JSON.stringify({ status: 'error' }) })
    ).toBeNull();
    expect(
      parseProposalBlock({ type: 'tool_result', content: JSON.stringify({ status: 'proposed' }) })
    ).toBeNull();
  });

  it('refuses an incomplete proposal so a half-formed card never renders', () => {
    for (const missing of ['plantId', 'plantName', 'type', 'frequencyDays'] as const) {
      const partial: Record<string, unknown> = { ...proposal };
      delete partial[missing];
      expect(
        parseProposalBlock({
          type: 'tool_result',
          content: JSON.stringify({ status: 'proposed', proposal: partial }),
        })
      ).toBeNull();
    }
  });
});

describe('getChatStreamUrl', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is null when unset or blank so callers use the sync endpoint', () => {
    vi.stubEnv('VITE_CHAT_STREAM_URL', '');
    expect(getChatStreamUrl()).toBeNull();
    vi.stubEnv('VITE_CHAT_STREAM_URL', '   ');
    expect(getChatStreamUrl()).toBeNull();
  });

  it('trims a configured URL', () => {
    vi.stubEnv('VITE_CHAT_STREAM_URL', `  ${STREAM_URL}  `);
    expect(getChatStreamUrl()).toBe(STREAM_URL);
  });
});

describe('chatService sync endpoints', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'access-1' });
  });

  it('sendMessage posts the message, conversation, and turn id', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/chat/messages`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(doneResult);
      })
    );
    await expect(chatService.sendMessage('hi', 'c1', 't1')).resolves.toEqual(doneResult);
    expect(body).toEqual({ message: 'hi', conversationId: 'c1', turnId: 't1' });
  });

  it('reportResponse posts an explicit report action', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${API}/chat/messages`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ accepted: true, reportId: 'r1' });
      })
    );
    await expect(
      chatService.reportResponse({
        conversationId: 'c1',
        responseText: 'wrong',
        reason: 'incorrect',
      })
    ).resolves.toEqual({ accepted: true, reportId: 'r1' });
    expect(body.action).toBe('report');
    expect(body.reason).toBe('incorrect');
  });

  it('getConversation and getBudget return their payloads', async () => {
    server.use(
      http.get(`${API}/chat/conversations/c1/messages`, () =>
        HttpResponse.json([{ timestamp: '', role: 'user', content: [] }])
      ),
      http.get(`${API}/chat/budget`, () =>
        HttpResponse.json({
          yearMonth: '2026-08',
          inputTokensUsed: 1,
          outputTokensUsed: 2,
          inputTokensCap: 10,
          outputTokensCap: 20,
          costUsd: 0.01,
        })
      )
    );
    await expect(chatService.getConversation('c1')).resolves.toHaveLength(1);
    await expect(chatService.getBudget()).resolves.toMatchObject({ yearMonth: '2026-08' });
  });
});

describe('chatService.streamMessage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_CHAT_STREAM_URL', STREAM_URL);
    useAuthStore.setState({
      idToken: 'id-1',
      accessToken: 'access-1',
      activeHouseholdId: 'hh-2',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('throws when streaming is not configured', async () => {
    vi.stubEnv('VITE_CHAT_STREAM_URL', '');
    await expect(chatService.streamMessage('hi', undefined)).rejects.toThrow(
      'Chat streaming is not configured'
    );
  });

  it('sends the same auth scheme as the axios client', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(streamResponse([frame({ type: 'done', result: doneResult })]));
    vi.stubGlobal('fetch', fetchMock);

    await chatService.streamMessage('hi', 'c1', undefined, undefined, 't1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(STREAM_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer id-1');
    expect(headers['X-Household-Id']).toBe('hh-2');
    expect(JSON.parse(init.body as string)).toEqual({
      message: 'hi',
      conversationId: 'c1',
      turnId: 't1',
    });
  });

  it('emits every event in order and resolves with the terminal result', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          streamResponse([
            frame({ type: 'start', conversationId: 'c1' }),
            frame({ type: 'tool_start', name: 'search_care_knowledge' }),
            frame({ type: 'delta', text: 'Water ' }),
            frame({ type: 'delta', text: 'it weekly.' }),
            frame({ type: 'done', result: doneResult }),
          ])
        )
    );
    const seen: ChatStreamEvent[] = [];

    const result = await chatService.streamMessage('hi', undefined, (event) => seen.push(event));

    expect(result).toEqual(doneResult);
    expect(seen.map((event) => event.type)).toEqual([
      'start',
      'tool_start',
      'delta',
      'delta',
      'done',
    ]);
  });

  it('reassembles frames split across network chunks', async () => {
    const whole =
      frame({ type: 'delta', text: 'split' }) + frame({ type: 'done', result: doneResult });
    const cut = 12;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(streamResponse([whole.slice(0, cut), whole.slice(cut)]))
    );
    const seen: ChatStreamEvent[] = [];

    await expect(
      chatService.streamMessage('hi', undefined, (event) => seen.push(event))
    ).resolves.toEqual(doneResult);
    expect(seen[0]).toEqual({ type: 'delta', text: 'split' });
  });

  it('parses a trailing frame that arrives without its blank-line terminator', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          streamResponse([`data: ${JSON.stringify({ type: 'done', result: doneResult })}`])
        )
    );
    await expect(chatService.streamMessage('hi', undefined)).resolves.toEqual(doneResult);
  });

  it('skips malformed frames and keep-alive comments rather than failing the turn', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          streamResponse([
            ': keep-alive\n\n',
            'data: {not json\n\n',
            frame({ type: 'done', result: doneResult }),
          ])
        )
    );
    const seen: ChatStreamEvent[] = [];

    await expect(
      chatService.streamMessage('hi', undefined, (event) => seen.push(event))
    ).resolves.toEqual(doneResult);
    expect(seen).toHaveLength(1);
  });

  it('throws on a terminal error event', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          streamResponse([frame({ type: 'error', message: 'budget exhausted', statusCode: 429 })])
        )
    );
    await expect(chatService.streamMessage('hi', undefined)).rejects.toThrow('budget exhausted');
  });

  it('throws a generic message when the error event carries none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(streamResponse([frame({ type: 'error', message: '' })]))
    );
    await expect(chatService.streamMessage('hi', undefined)).rejects.toThrow('Chat stream failed');
  });

  it('throws when the stream ends without a done event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(streamResponse([frame({ type: 'delta', text: 'partial' })]))
    );
    await expect(chatService.streamMessage('hi', undefined)).rejects.toThrow(
      'Chat stream ended without a result'
    );
  });

  it('throws on a non-OK response or a body-less response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(streamResponse([], { ok: false, status: 502 }))
    );
    await expect(chatService.streamMessage('hi', undefined)).rejects.toThrow(
      'Chat stream failed (502)'
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }));
    await expect(chatService.streamMessage('hi', undefined)).rejects.toThrow(
      'Chat stream failed (200)'
    );
  });

  it('falls back to the access token when no ID token is persisted', async () => {
    useAuthStore.setState({ idToken: null, accessToken: 'access-1', activeHouseholdId: null });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(streamResponse([frame({ type: 'done', result: doneResult })]));
    vi.stubGlobal('fetch', fetchMock);

    await chatService.streamMessage('hi', undefined);

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer access-1');
    expect(headers).not.toHaveProperty('X-Household-Id');
  });

  it('passes the caller abort signal through to fetch', async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(streamResponse([frame({ type: 'done', result: doneResult })]));
    vi.stubGlobal('fetch', fetchMock);

    await chatService.streamMessage('hi', undefined, undefined, controller.signal);

    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });
});
