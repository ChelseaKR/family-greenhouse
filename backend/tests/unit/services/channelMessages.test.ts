import { describe, expect, it } from 'vitest';
import type { Task } from '../../../src/models/types.js';
import {
  composeDailyDue,
  composeTest,
  composeUpForGrabs,
  DISCORD_CONTENT_LIMIT,
  escapeDiscord,
  escapeSlack,
  MAX_CHANNEL_ITEMS,
  renderDiscord,
  renderForPlatform,
  renderMatrix,
  renderSlack,
  type ChannelRow,
} from '../../../src/services/channelMessages.js';
import {
  channelRowFor,
  dailyDueRows,
  upForGrabsRows,
} from '../../../src/services/householdChannelRun.js';
import { CHANNEL_PLATFORMS, CHANNEL_LOCALES } from '../../../src/models/householdChannel.js';

const NOW = new Date('2026-09-18T15:00:00.000Z'); // 08:00 in Los Angeles
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function row(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    plantName: 'Monstera',
    taskLabel: 'water',
    due: { kind: 'today' },
    unclaimed: false,
    nextDue: at(-HOUR),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The sensitive-field catalogue. Every value here is something the product
// stores about a plant, a task or a person that a family chat must never see.
// ---------------------------------------------------------------------------

const SECRETS = {
  plantNote: 'PRIVATE-NOTE the neighbour’s kid knocked it over, do not tell Ana',
  careRule: 'CARE-RULE bottom-water only',
  taskNote: 'TASK-NOTE spare key is under the mat',
  helpNote: 'HELP-NOTE travelling until Sunday',
  memberEmail: 'sam.private@example.com',
  memberName: 'Samantha Assignee',
  askerName: 'Ana Asker',
  userId: 'user-7f3c-secret',
  sitterUrl: 'https://familygreenhouse.net/sitter/sit_live_token_abc123',
  kioskUrl: 'https://familygreenhouse.net/kiosk/kiosk_live_token_def456',
  tagUrl: 'https://familygreenhouse.net/t/tag_live_token_ghi789',
  shareUrl: 'https://familygreenhouse.net/shared/share_code_jkl012',
  calendarUrl: 'https://api.familygreenhouse.net/calendar/cal_token_mno345/feed.ics',
  imageUrl: 'https://cdn.familygreenhouse.net/plants/p1/photo.jpg',
  phone: '+15551234567',
};

function sensitiveTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    householdId: 'hh-1',
    plantId: 'plant-1',
    // The task's denormalised plant name is deliberately NOT what is shown;
    // the active-plant read is. Stuffing it with a secret proves that.
    plantName: SECRETS.plantNote,
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue: at(-2 * DAY),
    assignedTo: SECRETS.userId,
    assignedToName: SECRETS.memberName,
    assignmentSource: null,
    notes: `${SECRETS.taskNote} ${SECRETS.sitterUrl} ${SECRETS.memberEmail}`,
    helpAskedAt: at(-DAY),
    helpAskedBy: SECRETS.userId,
    helpAskedByName: SECRETS.askerName,
    helpAskedNote: `${SECRETS.helpNote} ${SECRETS.kioskUrl}`,
    helpAskedForDue: at(-2 * DAY),
    escalatedFrom: SECRETS.userId,
    createdBy: SECRETS.userId,
    createdAt: at(-30 * DAY),
    ...overrides,
  };
}

/** Everything a real household can put in front of the composer. */
function sensitiveHousehold() {
  const tasks: Task[] = [
    sensitiveTask(),
    sensitiveTask({
      id: 't2',
      plantId: 'plant-2',
      type: 'custom',
      customType: 'mist leaves',
      assignedTo: null,
      assignedToName: null,
      nextDue: at(3 * DAY),
    }),
    sensitiveTask({
      id: 't3',
      plantId: 'plant-3',
      assignedTo: null,
      assignedToName: null,
      nextDue: at(-HOUR),
    }),
  ];
  const activePlantNames = new Map([
    ['plant-1', 'Monstera'],
    ['plant-2', 'Fern'],
    ['plant-3', 'Snake Plant'],
  ]);
  return { tasks, activePlantNames };
}

function everyPayload(): string[] {
  const { tasks, activePlantNames } = sensitiveHousehold();
  const out: string[] = [];
  for (const locale of CHANNEL_LOCALES) {
    const daily = composeDailyDue(
      dailyDueRows(tasks, activePlantNames, NOW, 'America/Los_Angeles', locale),
      locale
    );
    const weekly = composeUpForGrabs(
      upForGrabsRows(tasks, activePlantNames, NOW, locale),
      locale,
      'America/Los_Angeles'
    );
    const test = composeTest({ dailyDue: true, upForGrabs: true }, locale);
    for (const message of [daily, weekly, test]) {
      expect(message).not.toBeNull();
      for (const platform of CHANNEL_PLATFORMS) {
        out.push(JSON.stringify(renderForPlatform(platform, message!, locale)));
      }
    }
  }
  return out;
}

describe('what a channel post may contain (#674)', () => {
  it('the fixture really does reach every platform and both posts (control)', () => {
    const payloads = everyPayload();
    // 2 locales × 3 messages × 3 platforms.
    expect(payloads).toHaveLength(18);
    // And the rows that should be there ARE there — so the absences below are
    // not an empty payload passing by default.
    const joined = payloads.join('\n');
    expect(joined).toContain('Monstera');
    expect(joined).toContain('Fern');
    expect(joined).toContain('mist leaves');
    expect(joined).toContain('Snake Plant');
  });

  it.each(Object.entries(SECRETS))('never carries %s', (_name, secret) => {
    for (const payload of everyPayload()) {
      expect(payload).not.toContain(secret);
    }
  });

  it('carries no link or token of any kind', () => {
    for (const payload of everyPayload()) {
      expect(payload).not.toMatch(/https?:/i);
      expect(payload).not.toMatch(/familygreenhouse\.net/i);
      expect(payload).not.toMatch(/token/i);
      expect(payload).not.toMatch(/@[a-z0-9-]+\.[a-z]/i); // an email address
    }
  });

  it('builds a row from four task facts and nothing else', () => {
    const { activePlantNames } = sensitiveHousehold();
    const built = channelRowFor(sensitiveTask(), activePlantNames, NOW, 'en');
    expect(Object.keys(built).sort()).toEqual(
      ['due', 'nextDue', 'plantName', 'taskLabel', 'unclaimed'].sort()
    );
    expect(built.plantName).toBe('Monstera');
    expect(built.unclaimed).toBe(false);
  });
});

describe('which tasks each post names', () => {
  const { tasks, activePlantNames } = sensitiveHousehold();

  it('the morning list: due by the end of the channel’s today, or overdue', () => {
    const rows = dailyDueRows(tasks, activePlantNames, NOW, 'America/Los_Angeles', 'en');
    expect(rows.map((r) => r.plantName)).toEqual(['Monstera', 'Snake Plant']);
    // Most urgent first; the unassigned one says so without naming anyone.
    expect(rows[0].due).toEqual({ kind: 'overdue', days: 2 });
    expect(rows[1].unclaimed).toBe(true);
  });

  it('drops a task resting past the reminder’s 14-day far edge', () => {
    const old = sensitiveTask({ id: 'old', nextDue: at(-20 * DAY) });
    const rows = dailyDueRows([old], activePlantNames, NOW, 'UTC', 'en');
    expect(rows).toEqual([]);
  });

  it('never names a plant that is not in the active read', () => {
    const orphan = sensitiveTask({ id: 'o', plantId: 'plant-gone' });
    expect(dailyDueRows([orphan], activePlantNames, NOW, 'UTC', 'en')).toEqual([]);
  });

  it('the weekly post: unassigned and due in (24h, 7d] — the up-for-grabs email’s window', () => {
    const inside = sensitiveTask({
      id: 'in',
      plantId: 'plant-2',
      assignedTo: null,
      nextDue: at(2 * DAY),
    });
    const tooSoon = sensitiveTask({
      id: 'soon',
      plantId: 'plant-2',
      assignedTo: null,
      nextDue: at(12 * HOUR),
    });
    const tooFar = sensitiveTask({
      id: 'far',
      plantId: 'plant-2',
      assignedTo: null,
      nextDue: at(8 * DAY),
    });
    const claimed = sensitiveTask({ id: 'mine', plantId: 'plant-2', nextDue: at(2 * DAY) });
    const rows = upForGrabsRows([tooFar, claimed, tooSoon, inside], activePlantNames, NOW, 'en');
    expect(rows).toHaveLength(1);
    expect(rows[0].nextDue).toBe(inside.nextDue);
  });
});

describe('copy, in both languages', () => {
  it('English morning list', () => {
    const message = composeDailyDue(
      [row({ due: { kind: 'overdue', days: 2 } }), row({ plantName: 'Fern', unclaimed: true })],
      'en'
    )!;
    expect(message.heading).toBe('2 plant-care tasks are due today or overdue:');
    expect(message.items).toEqual([
      'Monstera — water, 2 days overdue',
      'Fern — water, due today (nobody has claimed it)',
    ]);
  });

  it('Spanish morning list — real Spanish, not the English strings', () => {
    const message = composeDailyDue(
      [
        row({ taskLabel: 'regar', due: { kind: 'overdue', days: 1 } }),
        row({ plantName: 'Helecho', taskLabel: 'regar', unclaimed: true }),
      ],
      'es'
    )!;
    expect(message.heading).toBe('Hay 2 tareas de cuidado de plantas para hoy o atrasadas:');
    expect(message.items).toEqual([
      'Monstera — regar, 1 día de retraso',
      'Helecho — regar, para hoy (nadie la ha tomado)',
    ]);
  });

  it('the weekly post dates each task in the channel’s zone and language', () => {
    const due = '2026-09-22T06:00:00.000Z'; // Monday 23:00 in LA, Tuesday in UTC
    const en = composeUpForGrabs(
      [row({ nextDue: due, due: { kind: 'upcoming' } })],
      'en',
      'America/Los_Angeles'
    )!;
    expect(en.heading).toBe('Up for grabs this week — 1 task nobody has claimed yet:');
    expect(en.items[0]).toBe('Monstera — water, due Monday, September 21');
    const es = composeUpForGrabs(
      [row({ taskLabel: 'regar', nextDue: due, due: { kind: 'upcoming' } })],
      'es',
      'UTC'
    )!;
    expect(es.heading).toBe('Sin asignar esta semana: 1 tarea que nadie ha tomado todavía:');
    expect(es.items[0]).toBe('Monstera — regar, para el martes, 22 de septiembre');
  });

  it('says a name or a date could not be read, never prints a blank', () => {
    const message = composeDailyDue(
      [row({ plantName: null, taskLabel: null, due: { kind: 'unknown' } })],
      'en'
    )!;
    expect(message.items[0]).toMatch(
      /^a plant whose name we couldn't load — unnamed care task, due date could not be read/
    );
  });

  it('a quiet day is no post at all, not an empty one', () => {
    expect(composeDailyDue([], 'en')).toBeNull();
    expect(composeUpForGrabs([], 'es', 'UTC')).toBeNull();
  });

  it('caps the list but states the real total', () => {
    const rows = Array.from({ length: MAX_CHANNEL_ITEMS + 4 }, (_, i) =>
      row({ plantName: `Plant ${i}` })
    );
    const message = composeDailyDue(rows, 'en')!;
    expect(message.heading).toBe(
      `${MAX_CHANNEL_ITEMS + 4} plant-care tasks are due today or overdue:`
    );
    expect(message.items).toHaveLength(MAX_CHANNEL_ITEMS);
    expect(message.hidden).toBe(4);
    const text = renderSlack(message, 'en').text as string;
    expect(text).toContain('…and 4 more. Open Family Greenhouse to see the full list.');
  });

  it('the test post names no plant and states what will be posted', () => {
    const en = composeTest({ dailyDue: true, upForGrabs: false }, 'en');
    expect(en.items).toEqual(['Each morning: the plant care that is due today or overdue.']);
    expect(en.note).toBe('Posts here carry plant names, task names and due dates only.');
    const es = composeTest({ dailyDue: false, upForGrabs: false }, 'es');
    expect(es.heading).toBe('Family Greenhouse está conectado a este canal.');
    expect(es.items[0]).toMatch(/^Todavía no hay publicaciones activadas/);
  });
});

describe('per-platform wire format', () => {
  const hostile = composeDailyDue(
    [
      row({ plantName: '@everyone <@123456> **Fern** [click](https://evil.example)' }),
      row({ plantName: '<!channel> & <https://evil.example|click>' }),
      row({ plantName: '@room <script>alert(1)</script>' }),
    ],
    'en'
  )!;

  it('Discord: content + no pings of any kind + no embeds', () => {
    const body = renderDiscord(hostile, 'en');
    expect(Object.keys(body).sort()).toEqual(['allowed_mentions', 'content', 'flags']);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.flags).toBe(4);
    const content = body.content as string;
    expect(content).toMatch(/^\*\*3 plant-care tasks/);
    // Mentions and masked links are escaped, not live.
    expect(content).toContain('\\@everyone');
    expect(content).toContain('\\<\\@123456\\>');
    expect(content).toContain('\\[click\\]\\(https\\://evil.example\\)');
    expect(content).not.toMatch(/(^|[^\\])@everyone/);
  });

  it('Slack: plain text, no mrkdwn, no unfurls, control sequences inert', () => {
    const body = renderSlack(hostile, 'en');
    expect(body).toMatchObject({ mrkdwn: false, unfurl_links: false, unfurl_media: false });
    const text = body.text as string;
    expect(text).toContain('&lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;');
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@123456>');
  });

  it('Matrix: text + escaped html, and @room cannot ping the room', () => {
    const body = renderMatrix(hostile, 'en') as { text: string; html: string };
    expect(Object.keys(body).sort()).toEqual(['html', 'text']);
    expect(body.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body.html).not.toContain('<script>');
    expect(body.html.startsWith('<p><strong>3 plant-care tasks')).toBe(true);
    expect(body.text).not.toMatch(/@room/i);
    expect(body.html).not.toMatch(/@room/i);
    // Still readable: the word joiner is invisible, the words are there.
    expect(body.text).toContain('@⁠room');
  });

  it('Discord: a list that would pass 2,000 characters is cut, and the cut is counted', () => {
    const long = 'x'.repeat(200);
    const rows = Array.from({ length: MAX_CHANNEL_ITEMS }, (_, i) =>
      row({ plantName: `${long}${i}`, taskLabel: long })
    );
    const message = composeDailyDue(rows, 'en')!;
    const content = renderDiscord(message, 'en').content as string;
    expect(content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    const listed = content.split('\n').filter((line) => line.startsWith('• ')).length;
    expect(listed).toBeLessThan(MAX_CHANNEL_ITEMS);
    expect(content).toContain(`…and ${MAX_CHANNEL_ITEMS - listed} more`);
  });

  it('escapers leave ordinary names readable', () => {
    expect(escapeSlack('Fiddle Leaf Fig')).toBe('Fiddle Leaf Fig');
    expect(escapeDiscord('Fiddle Leaf Fig')).toBe('Fiddle Leaf Fig');
  });
});
