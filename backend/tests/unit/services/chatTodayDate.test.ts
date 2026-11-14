/**
 * #889: the care assistant is told today's date.
 *
 * Before this, nothing in a turn said what day it was. The household tools
 * return absolute dates, so the model placed "now" from its training data and
 * called a task that was four days overdue "this weekend".
 *
 * Three things are pinned here, each of which the fix could get wrong while
 * still "sending a date":
 *   - WHICH day: the household's calendar day, which is not the UTC day for a
 *     few hours of every evening in the Americas. Every fixture sits in those
 *     hours, the only place a wrong zone can show.
 *   - UNKNOWN is said as unknown: no zone, or a failed read, sends the UTC
 *     date labeled as UTC, never a UTC date passed off as the household's.
 *   - WHERE it goes: outside everything the prompt cache covers. The system
 *     prompt and the conversation stay byte-identical from one day to the
 *     next (tests/unit/services/chatBedrock.test.ts pins the payload side).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/chat/bedrock.js');
vi.mock('../../../src/services/chat/corpus.js');
vi.mock('../../../src/services/sprout.js', () => ({
  askSprout: vi.fn(),
  isSproutIntegrationEnabled: vi.fn(() => false),
}));
vi.mock('../../../src/services/chat/persistence.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/chat/persistence.js')>(
    '../../../src/services/chat/persistence.js'
  );
  return {
    ...actual,
    newConversationId: vi.fn(() => 'conv-1'),
    appendMessage: vi.fn(async () => undefined),
    appendMessagePair: vi.fn(async () => undefined),
    appendTurnUserMessage: vi.fn(async () => undefined),
    getConversation: vi.fn(async () => []),
    reserveBudget: vi.fn(
      async (_hh: string, reserve: { inputTokens: number; outputTokens: number }) => ({
        householdId: 'hh-1',
        yearMonth: '2026-03',
        inputTokens: reserve.inputTokens,
        outputTokens: reserve.outputTokens,
        costUsd: 0,
      })
    ),
    incrementBudget: vi.fn(async () => undefined),
    reconcileTurnBudget: vi.fn(async () => undefined),
  };
});
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/climate.js');
vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(async () => ({ planId: 'garden' })),
}));

import {
  runChatTurn,
  streamChatTurn,
  todayNote,
  SYSTEM_PROMPT,
} from '../../../src/services/chat/index.js';
import {
  invokeChatModel,
  invokeChatModelStream,
  type BedrockChatResponse,
  type BedrockStreamDelta,
} from '../../../src/services/chat/bedrock.js';
import {
  appendMessage,
  appendMessagePair,
  getConversation,
} from '../../../src/services/chat/persistence.js';
import * as householdService from '../../../src/services/householdService.js';
import * as plantService from '../../../src/services/plantService.js';
import { logger } from '../../../src/utils/logger.js';

/**
 * 02:30 UTC on Monday 9 March 2026. In Los Angeles it is still 19:30 on
 * Sunday the 8th; in Tokyo it is already 11:30 on Monday. A date computed in
 * the wrong zone is a different DAY here, and a different weekday.
 */
const EVENING_IN_THE_AMERICAS = new Date('2026-03-09T02:30:00.000Z');

const answer: BedrockChatResponse = {
  content: [{ type: 'text', text: 'The fern is two days overdue.' }],
  stopReason: 'end_turn',
  inputTokens: 100,
  outputTokens: 20,
  costUsd: 0.0006,
} as BedrockChatResponse;

function household(timezone: string) {
  return { id: 'hh-1', name: 'Home', timezone } as never;
}

function callArgs(n = 0) {
  return vi.mocked(invokeChatModel).mock.calls[n][0] as {
    system: string;
    messages: unknown[];
    uncachedContext?: string;
  };
}

async function ask(message = 'What is due this weekend?') {
  return runChatTurn({ userId: 'u1', householdId: 'hh-1', message });
}

beforeEach(() => {
  // Reset, not clear: several tests install a standing household or history,
  // and none of that may reach the next test.
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EVENING_IN_THE_AMERICAS);
  vi.mocked(invokeChatModel).mockResolvedValue(answer);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('todayNote', () => {
  it('the fixture instant is a different calendar day in Los Angeles than in UTC', () => {
    const day = (timeZone: string) =>
      new Intl.DateTimeFormat('en-CA', { timeZone }).format(EVENING_IN_THE_AMERICAS);
    expect(day('UTC')).toBe('2026-03-09');
    expect(day('America/Los_Angeles')).toBe('2026-03-08');
  });

  it('gives the household’s calendar day, weekday and zone', () => {
    const note = todayNote(EVENING_IN_THE_AMERICAS, 'America/Los_Angeles');
    expect(note).toContain('Sunday, 2026-03-08');
    expect(note).toContain('America/Los_Angeles');
    expect(note).not.toContain('2026-03-09');
    expect(note).not.toContain('Monday');
    // East of UTC the day runs ahead instead.
    const tokyo = todayNote(new Date('2026-03-08T16:00:00.000Z'), 'Asia/Tokyo');
    expect(tokyo).toContain('Monday, 2026-03-09');
  });

  it('pins the exact wording, so a change to what the model reads is a deliberate one', () => {
    expect(todayNote(EVENING_IN_THE_AMERICAS, 'America/Los_Angeles')).toBe(
      "[Note from the Family Greenhouse app, not written by the user] Today is Sunday, 2026-03-08, in the household's time zone (America/Los_Angeles)."
    );
    expect(todayNote(EVENING_IN_THE_AMERICAS, '')).toBe(
      "[Note from the Family Greenhouse app, not written by the user] Today is Monday, 2026-03-09, in UTC. The household's time zone is not known, so where the user is it may be the day before or the day after."
    );
  });

  it.each([
    ['never set', ''],
    ['absent', undefined],
    ['not a string', 42],
    ['a zone the runtime does not know', 'Mars/Olympus_Mons'],
  ])('says UTC, and says the zone is not known, when it is %s', (_label, zone) => {
    const note = todayNote(EVENING_IN_THE_AMERICAS, zone);
    expect(note).toContain('Monday, 2026-03-09, in UTC');
    expect(note).toMatch(/time zone is not known/);
    // The absent case never borrows the wording of the known one.
    expect(note).not.toContain("in the household's time zone");
  });

  it('a household that CHOSE UTC is told so as its own zone, not as "unknown"', () => {
    const note = todayNote(EVENING_IN_THE_AMERICAS, 'UTC');
    expect(note).toContain("in the household's time zone (UTC)");
    expect(note).not.toMatch(/not known/);
  });
});

describe('a chat turn tells the model today’s date', () => {
  it('sends the household’s day with the call, where the model can read it', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue(household('America/Los_Angeles'));

    await ask();

    expect(householdService.getHousehold).toHaveBeenCalledWith('hh-1');
    expect(callArgs().uncachedContext).toBe(
      todayNote(EVENING_IN_THE_AMERICAS, 'America/Los_Angeles')
    );
    expect(callArgs().uncachedContext).toContain('Sunday, 2026-03-08');
  });

  it('falls back to UTC, labeled as UTC, for a household with no zone', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue(household(''));
    await ask();
    expect(callArgs().uncachedContext).toContain('Monday, 2026-03-09, in UTC');
    expect(callArgs().uncachedContext).toMatch(/time zone is not known/);
  });

  it('still answers when the household read fails: UTC, said as unknown, and logged', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    vi.mocked(householdService.getHousehold).mockRejectedValue(new Error('ddb down'));

    const result = await ask();

    expect(result.assistantText).toBe('The fern is two days overdue.');
    expect(callArgs().uncachedContext).toContain('Monday, 2026-03-09, in UTC');
    expect(callArgs().uncachedContext).toMatch(/time zone is not known/);
    expect(warn.mock.calls.map((c) => c[1])).toContain('chat_household_timezone_read_failed');
    warn.mockRestore();
  });

  it('keeps the date out of everything the prompt cache covers', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue(household('America/Los_Angeles'));
    vi.mocked(getConversation).mockResolvedValue([
      {
        conversationId: 'conv-1',
        timestamp: EVENING_IN_THE_AMERICAS.toISOString(),
        role: 'user',
        content: [{ type: 'text', text: 'What is due this weekend?' }],
      },
    ]);

    await ask();
    const monday = callArgs(0);

    // A day later, the same question in the same conversation.
    vi.setSystemTime(new Date('2026-03-10T02:30:00.000Z'));
    await ask();
    const tuesday = callArgs(1);

    // The date did change between the two calls…
    expect(monday.uncachedContext).toContain('2026-03-08');
    expect(tuesday.uncachedContext).toContain('2026-03-09');
    // …and nothing the cache hashes did. `system` is the constant, to the byte.
    expect(monday.system).toBe(SYSTEM_PROMPT);
    expect(tuesday.system).toBe(SYSTEM_PROMPT);
    expect(tuesday.messages).toEqual(monday.messages);
    for (const call of [monday, tuesday]) {
      const cached = JSON.stringify([call.system, call.messages]);
      expect(cached).not.toMatch(/2026-03-0\d/);
      expect(cached).not.toMatch(/Sunday|Monday/);
    }
  });

  it('the system prompt tells the model to use the note, and carries no date itself', () => {
    expect(SYSTEM_PROMPT).toMatch(/note from the app/i);
    expect(SYSTEM_PROMPT).toMatch(/today's date/i);
    expect(SYSTEM_PROMPT).toMatch(/Never\s+work\s+out\s+today's\s+date\s+from\s+memory/);
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(SYSTEM_PROMPT).not.toMatch(/\b20\d\d\b/);
  });

  it('gives every call of a tool loop the same date, read once, and persists none of it', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue(household('America/Los_Angeles'));
    vi.mocked(plantService.getPlants).mockResolvedValue([]);
    vi.mocked(invokeChatModel)
      .mockReset()
      .mockImplementationOnce(async () => {
        // Midnight passes in Los Angeles while the tool runs.
        vi.setSystemTime(new Date('2026-03-09T07:30:00.000Z'));
        return {
          content: [{ type: 'tool_use', id: 'tu-1', name: 'list_household_plants', input: {} }],
          stopReason: 'tool_use',
          inputTokens: 200,
          outputTokens: 30,
          costUsd: 0.001,
        } as BedrockChatResponse;
      })
      .mockResolvedValueOnce(answer);

    await ask('list my plants');

    expect(invokeChatModel).toHaveBeenCalledTimes(2);
    expect(callArgs(0).uncachedContext).toContain('Sunday, 2026-03-08');
    // One turn, one "today": the answer cannot straddle two dates.
    expect(callArgs(1).uncachedContext).toBe(callArgs(0).uncachedContext);
    expect(householdService.getHousehold).toHaveBeenCalledTimes(1);

    // Nothing stored carries the note, so a later turn never replays a stale
    // date as if the user had said it.
    const stored = JSON.stringify([
      vi.mocked(appendMessage).mock.calls,
      vi.mocked(appendMessagePair).mock.calls,
    ]);
    expect(stored).not.toContain('Note from the Family Greenhouse app');
    expect(stored).not.toContain('2026-03-08');
  });

  it('sends it on the streaming path too', async () => {
    vi.mocked(householdService.getHousehold).mockResolvedValue(household('America/Los_Angeles'));
    vi.mocked(invokeChatModelStream).mockReturnValueOnce(
      (async function* (): AsyncGenerator<BedrockStreamDelta, BedrockChatResponse> {
        yield { type: 'text_delta' as const, text: 'The fern is two days overdue.' };
        return answer;
      })()
    );

    const gen = streamChatTurn({ userId: 'u1', householdId: 'hh-1', message: 'What is due?' });
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
    }

    const args = vi.mocked(invokeChatModelStream).mock.calls[0][0] as {
      system: string;
      uncachedContext?: string;
    };
    expect(args.uncachedContext).toContain('Sunday, 2026-03-08');
    expect(args.system).toBe(SYSTEM_PROMPT);
  });
});
