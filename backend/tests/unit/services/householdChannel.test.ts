import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../../src/models/types.js';
import type { HouseholdChannelRecord } from '../../../src/models/householdChannel.js';

/**
 * The household chat channel's behaviour over time (#674): when it posts
 * (the #343/#809 quiet-hours timing), that it posts once, and what repeated
 * failures do to it. The store is an in-memory fake with the real store's
 * semantics — conditional reserve, finalize, release, and outcome writes that
 * refuse a replaced or deleted channel — so these tests exercise the policy,
 * and `householdChannelStore.test.ts` pins the DynamoDB shapes separately.
 */

const mem = vi.hoisted(() => ({
  channels: new Map<string, Record<string, unknown>>(),
  markers: new Map<
    string,
    { status: 'sending' | 'sent'; reservationId: string; leaseUntil: number }
  >(),
  seq: 0,
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

vi.mock('../../../src/services/householdChannelStore.js', () => {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const markerKey = (hh: string, kind: string, period: string) => `${hh}|${kind}|${period}`;
  return {
    getChannel: vi.fn(async (hh: string) =>
      mem.channels.has(hh) ? clone(mem.channels.get(hh)) : null
    ),
    saveChannel: vi.fn(async (record: Record<string, unknown>, expect: string | null) => {
      const existing = mem.channels.get(record.householdId as string);
      if (expect === null ? existing : existing?.updatedAt !== expect) return 'conflict';
      mem.channels.set(record.householdId as string, clone(record));
      return 'saved';
    }),
    deleteChannel: vi.fn(async (hh: string) => mem.channels.delete(hh)),
    listChannels: vi.fn(async () => [...mem.channels.values()].map(clone)),
    applyOutcome: vi.fn(async (hh: string, urlVersion: string, patch: Record<string, unknown>) => {
      const existing = mem.channels.get(hh);
      if (!existing || existing.urlVersion !== urlVersion) return 'stale';
      mem.channels.set(hh, { ...existing, ...clone(patch) });
      return 'applied';
    }),
    postAlreadyHandled: vi.fn(async (hh: string, kind: string, period: string, now: Date) => {
      const m = mem.markers.get(markerKey(hh, kind, period));
      if (!m) return false;
      return m.status === 'sent' || m.leaseUntil > now.getTime();
    }),
    reservePost: vi.fn(async (hh: string, kind: string, period: string, now: Date) => {
      const key = markerKey(hh, kind, period);
      const m = mem.markers.get(key);
      if (m && (m.status === 'sent' || m.leaseUntil > now.getTime())) return null;
      const reservationId = `r${++mem.seq}`;
      mem.markers.set(key, {
        status: 'sending',
        reservationId,
        leaseUntil: now.getTime() + 300_000,
      });
      return reservationId;
    }),
    finalizePost: vi.fn(async (hh: string, kind: string, period: string, id: string) => {
      const m = mem.markers.get(markerKey(hh, kind, period));
      if (m && m.reservationId === id) m.status = 'sent';
    }),
    releasePost: vi.fn(async (hh: string, kind: string, period: string, id: string) => {
      const key = markerKey(hh, kind, period);
      if (mem.markers.get(key)?.reservationId === id) mem.markers.delete(key);
    }),
  };
});

vi.mock('../../../src/services/scheduledFanOut.js', () => ({
  fanOutHouseholds: vi.fn(
    async (_job: string, ids: string[], handle: (id: string) => Promise<void>) => {
      for (const id of ids) await handle(id);
      return { total: ids.length, attempted: ids.length, truncated: false };
    }
  ),
}));

vi.mock('../../../src/services/taskService.js', () => ({ getTasksDueBy: vi.fn() }));
vi.mock('../../../src/services/plantService.js', () => ({ getPlants: vi.fn() }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DISCORD =
  'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklmnopqrstuvwx';

function channel(overrides: Partial<HouseholdChannelRecord> = {}): HouseholdChannelRecord {
  return {
    householdId: 'hh-1',
    platform: 'discord',
    sealedUrl: 'sealed-ciphertext',
    urlVersion: 'v1',
    host: 'discord.com',
    last4: 'uvwx',
    events: { dailyDue: true, upForGrabs: false },
    quietStart: '',
    quietEnd: '',
    timezone: 'America/New_York',
    locale: 'en',
    status: 'active',
    disabledReason: null,
    consecutiveFailures: 0,
    consecutiveClientErrors: 0,
    nextAttemptAt: null,
    lastFailure: null,
    lastDeliveredAt: null,
    lastTestAt: null,
    connectedBy: 'u-admin',
    connectedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    householdId: 'hh-1',
    plantId: 'p1',
    plantName: 'Monstera',
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue: '2026-09-17T12:00:00.000Z',
    assignedTo: 'u1',
    assignedToName: 'Sam',
    assignmentSource: null,
    notes: 'private note',
    createdBy: 'u1',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const deps = {
  open: vi.fn(async () => DISCORD),
  post: vi.fn(async () => ({ ok: true as const, httpStatus: 204 })),
};

async function load() {
  const run = await import('../../../src/services/householdChannelRun.js');
  const svc = await import('../../../src/services/householdChannel.js');
  const tasks = await import('../../../src/services/taskService.js');
  const plants = await import('../../../src/services/plantService.js');
  return { run, svc, tasks, plants };
}

function stored(): HouseholdChannelRecord {
  return mem.channels.get('hh-1') as unknown as HouseholdChannelRecord;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mem.channels.clear();
  mem.markers.clear();
  deps.open.mockResolvedValue(DISCORD);
  deps.post.mockResolvedValue({ ok: true, httpStatus: 204 });
  const { tasks, plants } = await load();
  vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
    task({ id: 'overdue', nextDue: '2026-09-17T12:00:00.000Z' }),
    task({ id: 'claimable', plantId: 'p2', assignedTo: null, nextDue: '2026-09-21T12:00:00.000Z' }),
  ]);
  vi.mocked(plants.getPlants).mockResolvedValue([
    { id: 'p1', name: 'Monstera' },
    { id: 'p2', name: 'Fern' },
  ] as never);
});

describe('when the morning list goes out — the #343 / #809 rule, on the channel’s clock', () => {
  it('holds before 08:00 local with no quiet hours, and posts at 08:00', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel() as never);
    // 07:59 and 08:00 in New York (EDT, UTC-4).
    expect(await run.visitChannel(stored(), new Date('2026-09-18T11:59:00Z'), deps)).toBe('held');
    expect(deps.post).not.toHaveBeenCalled();
    expect(await run.visitChannel(stored(), new Date('2026-09-18T12:00:00Z'), deps)).toBe('posted');
    expect(deps.post).toHaveBeenCalledTimes(1);
  });

  it('with quiet hours set, posts when they END, not at 08:00', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel({ quietStart: '22:00', quietEnd: '06:30' }) as never);
    expect(await run.visitChannel(stored(), new Date('2026-09-18T10:29:00Z'), deps)).toBe('held');
    expect(await run.visitChannel(stored(), new Date('2026-09-18T10:30:00Z'), deps)).toBe('posted');
  });

  it('a late window holds past 08:00 until it ends', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel({ quietStart: '07:00', quietEnd: '09:30' }) as never);
    // 08:00 local: inside quiet hours.
    expect(await run.visitChannel(stored(), new Date('2026-09-18T12:00:00Z'), deps)).toBe('held');
    expect(await run.visitChannel(stored(), new Date('2026-09-18T13:30:00Z'), deps)).toBe('posted');
  });

  it('nothing is posted inside quiet hours later the same day either', async () => {
    const { run } = await load();
    mem.channels.set(
      'hh-1',
      channel({
        quietStart: '22:00',
        quietEnd: '06:30',
        events: { dailyDue: false, upForGrabs: true },
      }) as never
    );
    // 23:00 local: after delivery time, but quiet hours have started again.
    expect(await run.visitChannel(stored(), new Date('2026-09-19T03:00:00Z'), deps)).toBe('held');
    expect(deps.post).not.toHaveBeenCalled();
  });

  it('is evaluated in the CHANNEL’s zone, not UTC', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel({ timezone: 'Asia/Tokyo' }) as never);
    // 12:00 UTC is 21:00 in Tokyo → past 08:00, posts.
    expect(await run.visitChannel(stored(), new Date('2026-09-18T12:00:00Z'), deps)).toBe('posted');
  });
});

describe('once, and only once', () => {
  it('a second run the same local day does not post again', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel() as never);
    await run.runHouseholdChannels(new Date('2026-09-18T12:05:00Z'), {}, deps);
    await run.runHouseholdChannels(new Date('2026-09-18T13:05:00Z'), {}, deps);
    await run.runHouseholdChannels(new Date('2026-09-18T13:05:00Z'), {}, deps); // EventBridge retry
    expect(deps.post).toHaveBeenCalledTimes(1);
  });

  it('posts again the next local day', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel() as never);
    await run.runHouseholdChannels(new Date('2026-09-18T12:05:00Z'), {}, deps);
    await run.runHouseholdChannels(new Date('2026-09-19T12:05:00Z'), {}, deps);
    expect(deps.post).toHaveBeenCalledTimes(2);
  });

  it('the weekly up-for-grabs post goes out once per ISO week, and only names unclaimed work', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel({ events: { dailyDue: false, upForGrabs: true } }) as never);
    await run.runHouseholdChannels(new Date('2026-09-18T12:05:00Z'), {}, deps);
    await run.runHouseholdChannels(new Date('2026-09-19T12:05:00Z'), {}, deps);
    expect(deps.post).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(deps.post.mock.calls[0][2]);
    expect(body).toContain('Up for grabs this week');
    expect(body).toContain('Fern');
    expect(body).not.toContain('Monstera');
    // Next ISO week, with something unclaimed further out again.
    const { tasks } = await load();
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([
      task({ id: 'later', plantId: 'p2', assignedTo: null, nextDue: '2026-09-24T12:00:00.000Z' }),
    ]);
    await run.runHouseholdChannels(new Date('2026-09-21T12:05:00Z'), {}, deps);
    expect(deps.post).toHaveBeenCalledTimes(2);
  });

  it('a day with nothing due posts nothing and marks nothing', async () => {
    const { run, tasks } = await load();
    vi.mocked(tasks.getTasksDueBy).mockResolvedValue([]);
    mem.channels.set('hh-1', channel() as never);
    expect(await run.visitChannel(stored(), new Date('2026-09-18T12:05:00Z'), deps)).toBe(
      'nothing_due'
    );
    expect(mem.markers.size).toBe(0);
  });

  it('tasks due but an EMPTY active-plant read is unknown — no post, no marker', async () => {
    const { run, plants } = await load();
    vi.mocked(plants.getPlants).mockResolvedValue([]);
    mem.channels.set('hh-1', channel() as never);
    expect(await run.visitChannel(stored(), new Date('2026-09-18T12:05:00Z'), deps)).toBe(
      'unknown'
    );
    expect(deps.post).not.toHaveBeenCalled();
    expect(mem.markers.size).toBe(0);
  });

  it('a failed task read throws into the run and is counted, not summarised as calm', async () => {
    const { run, tasks } = await load();
    vi.mocked(tasks.getTasksDueBy).mockRejectedValue(new Error('ddb down'));
    mem.channels.set('hh-1', channel() as never);
    const summary = await run.runHouseholdChannels(new Date('2026-09-18T12:05:00Z'), {}, deps);
    expect(summary).toMatchObject({ channels: 1, failed: 1, posted: 0 });
  });

  it('a disconnected channel is not visited on the next run', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel() as never);
    mem.channels.delete('hh-1');
    const summary = await run.runHouseholdChannels(new Date('2026-09-18T12:05:00Z'), {}, deps);
    expect(summary.channels).toBe(0);
    expect(deps.post).not.toHaveBeenCalled();
  });
});

describe('failure: back off, then stop — never a retry storm', () => {
  const clientError = {
    ok: false as const,
    kind: 'client' as const,
    httpStatus: 404,
    retryAfterSeconds: null,
  };

  it('a failed post releases the day, backs off an hour, and retries after it', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel() as never);
    deps.post.mockResolvedValueOnce({
      ok: false,
      kind: 'server',
      httpStatus: 502,
      retryAfterSeconds: null,
    });
    const t0 = new Date('2026-09-18T12:05:00Z');
    expect(await run.visitChannel(stored(), t0, deps)).toBe('failed_delivery');
    expect(stored().consecutiveFailures).toBe(1);
    expect(stored().nextAttemptAt).toBe(new Date(t0.getTime() + HOUR).toISOString());
    expect(mem.markers.size).toBe(0);
    // Half an hour later: still backing off, no request made.
    expect(await run.visitChannel(stored(), new Date(t0.getTime() + HOUR / 2), deps)).toBe(
      'backing_off'
    );
    expect(deps.post).toHaveBeenCalledTimes(1);
    // After the backoff: posts, and the streak resets.
    expect(await run.visitChannel(stored(), new Date(t0.getTime() + HOUR), deps)).toBe('posted');
    expect(stored()).toMatchObject({
      consecutiveFailures: 0,
      lastFailure: null,
      nextAttemptAt: null,
    });
  });

  it('one failed post ends the channel’s hour — the second post is not attempted', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel({ events: { dailyDue: true, upForGrabs: true } }) as never);
    deps.post.mockResolvedValueOnce(clientError);
    await run.visitChannel(stored(), new Date('2026-09-18T12:05:00Z'), deps);
    expect(deps.post).toHaveBeenCalledTimes(1);
  });

  it('disables after three consecutive 4xx and tells the admin why', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel() as never);
    deps.post.mockResolvedValue(clientError);
    let now = new Date('2026-09-18T12:05:00Z').getTime();
    for (let i = 0; i < 3; i += 1) {
      expect(await run.visitChannel(stored(), new Date(now), deps)).toBe('failed_delivery');
      now = Date.parse(stored().nextAttemptAt!) + 1;
    }
    expect(stored()).toMatchObject({
      status: 'disabled',
      disabledReason: 'repeated_client_errors',
      consecutiveClientErrors: 3,
      lastFailure: { kind: 'client', httpStatus: 404 },
    });
    // And stays quiet — no fourth request, whatever the clock says.
    expect(await run.visitChannel(stored(), new Date(now + 7 * DAY), deps)).toBe('disabled');
    expect(deps.post).toHaveBeenCalledTimes(3);
  });

  it('a 429 backs off (honouring Retry-After) but does not count towards disabling', async () => {
    const { svc } = await load();
    const now = new Date('2026-09-18T12:05:00Z');
    const patch = svc.failurePatch(
      { consecutiveFailures: 0, consecutiveClientErrors: 2 },
      { ok: false, kind: 'rate_limited', httpStatus: 429, retryAfterSeconds: 3 * 60 * 60 },
      now
    );
    expect(patch.status).toBeUndefined();
    expect(patch.consecutiveClientErrors).toBe(2);
    expect(patch.nextAttemptAt).toBe(new Date(now.getTime() + 3 * HOUR).toISOString());
  });

  it('an answer from a private address disables at once', async () => {
    const { svc } = await load();
    const patch = svc.failurePatch(
      { consecutiveFailures: 0, consecutiveClientErrors: 0 },
      { ok: false, kind: 'blocked', httpStatus: null, retryAfterSeconds: null },
      new Date()
    );
    expect(patch).toMatchObject({ status: 'disabled', disabledReason: 'blocked_address' });
  });

  it('redirects count as refusals and name themselves', async () => {
    const { svc } = await load();
    const patch = svc.failurePatch(
      { consecutiveFailures: 2, consecutiveClientErrors: 2 },
      { ok: false, kind: 'redirect', httpStatus: 302, retryAfterSeconds: null },
      new Date()
    );
    expect(patch).toMatchObject({ status: 'disabled', disabledReason: 'redirect' });
  });

  it('a server error breaks a 4xx streak; ten failures of any kind disable', async () => {
    const { svc } = await load();
    const server = {
      ok: false as const,
      kind: 'server' as const,
      httpStatus: 503,
      retryAfterSeconds: null,
    };
    expect(
      svc.failurePatch({ consecutiveFailures: 2, consecutiveClientErrors: 2 }, server, new Date())
    ).toMatchObject({ consecutiveClientErrors: 0 });
    expect(
      svc.failurePatch({ consecutiveFailures: 9, consecutiveClientErrors: 0 }, server, new Date())
    ).toMatchObject({ status: 'disabled', disabledReason: 'repeated_failures' });
    // Negative control: nine is not ten.
    expect(
      svc.failurePatch({ consecutiveFailures: 8, consecutiveClientErrors: 0 }, server, new Date())
        .status
    ).toBeUndefined();
  });

  it('a failure recorded against a replaced address is discarded', async () => {
    const { svc } = await load();
    mem.channels.set('hh-1', channel({ urlVersion: 'v2' }) as never);
    const applied = await svc.recordOutcome(channel({ urlVersion: 'v1' }), clientError, new Date());
    expect(applied).toBeNull();
    expect(stored().consecutiveClientErrors).toBe(0);
  });

  it('an address KMS cannot open is a failed attempt, not a crash, and is never posted', async () => {
    const { run } = await load();
    mem.channels.set('hh-1', channel() as never);
    deps.open.mockRejectedValueOnce(
      Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' })
    );
    expect(await run.visitChannel(stored(), new Date('2026-09-18T12:05:00Z'), deps)).toBe(
      'failed_delivery'
    );
    expect(deps.post).not.toHaveBeenCalled();
    expect(stored().lastFailure).toMatchObject({ kind: 'unsealable' });
  });
});

describe('connecting a channel', () => {
  const input = {
    platform: 'discord' as const,
    url: DISCORD,
    events: { dailyDue: true, upForGrabs: true },
    quietStart: '',
    quietEnd: '',
    timezone: 'America/New_York',
    locale: 'es' as const,
  };
  const saveDeps = {
    seal: vi.fn(async () => 'kms-ciphertext'),
    checkHost: vi.fn(async () => 'public' as const),
  };

  beforeEach(() => {
    saveDeps.seal.mockClear();
    saveDeps.checkHost.mockReset().mockResolvedValue('public');
  });

  it('seals the address and stores only ciphertext, host and last four', async () => {
    const { svc } = await load();
    const result = await svc.saveChannel('hh-1', 'u-admin', input, new Date(), saveDeps);
    expect(result.status).toBe('saved');
    expect(saveDeps.seal).toHaveBeenCalledWith('hh-1', DISCORD);
    const row = JSON.stringify(stored());
    expect(row).toContain('kms-ciphertext');
    expect(row).not.toContain('AbCdEfGhIjKlMnOp');
    expect(stored()).toMatchObject({ host: 'discord.com', last4: 'uvwx', status: 'active' });
  });

  it('refuses an address whose host resolves privately, before it reaches KMS', async () => {
    const { svc } = await load();
    saveDeps.checkHost.mockResolvedValue('blocked' as never);
    const result = await svc.saveChannel('hh-1', 'u-admin', input, new Date(), saveDeps);
    expect(result).toEqual({ status: 'invalid_url', problem: 'private_host' });
    expect(saveDeps.seal).not.toHaveBeenCalled();
    expect(mem.channels.size).toBe(0);
  });

  it('says "could not find it" rather than "private" when DNS fails', async () => {
    const { svc } = await load();
    saveDeps.checkHost.mockResolvedValue('unresolvable' as never);
    expect(await svc.saveChannel('hh-1', 'u-admin', input, new Date(), saveDeps)).toEqual({
      status: 'invalid_url',
      problem: 'unresolvable',
    });
  });

  it('refuses a structurally wrong address without resolving it', async () => {
    const { svc } = await load();
    const result = await svc.saveChannel(
      'hh-1',
      'u-admin',
      { ...input, url: 'https://discord.com.evil.example/api/webhooks/1/x' },
      new Date(),
      saveDeps
    );
    expect(result).toEqual({ status: 'invalid_url', problem: 'wrong_host' });
    expect(saveDeps.checkHost).not.toHaveBeenCalled();
  });

  it('requires the address to connect, or to change platform', async () => {
    const { svc } = await load();
    const noUrl = { ...input, url: undefined };
    expect(await svc.saveChannel('hh-1', 'u', noUrl, new Date(), saveDeps)).toEqual({
      status: 'invalid_url',
      problem: 'url_required',
    });
    mem.channels.set('hh-1', channel() as never);
    expect(
      await svc.saveChannel('hh-1', 'u', { ...noUrl, platform: 'slack' }, new Date(), saveDeps)
    ).toEqual({ status: 'invalid_url', problem: 'url_required' });
  });

  it('a settings-only save keeps a disabled channel disabled', async () => {
    const { svc } = await load();
    mem.channels.set(
      'hh-1',
      channel({ status: 'disabled', disabledReason: 'repeated_client_errors' }) as never
    );
    const result = await svc.saveChannel(
      'hh-1',
      'u',
      { ...input, url: undefined },
      new Date(),
      saveDeps
    );
    expect(result.status).toBe('saved');
    expect(stored()).toMatchObject({
      status: 'disabled',
      locale: 'es',
      sealedUrl: 'sealed-ciphertext',
    });
    expect(saveDeps.seal).not.toHaveBeenCalled();
  });

  it('re-entering the address starts a clean slate', async () => {
    const { svc } = await load();
    mem.channels.set(
      'hh-1',
      channel({
        status: 'disabled',
        disabledReason: 'repeated_client_errors',
        consecutiveClientErrors: 3,
      }) as never
    );
    await svc.saveChannel('hh-1', 'u', input, new Date(), saveDeps);
    expect(stored()).toMatchObject({
      status: 'active',
      disabledReason: null,
      consecutiveClientErrors: 0,
    });
    expect(stored().urlVersion).not.toBe('v1');
  });

  it('refuses a zone Intl does not know', async () => {
    const { svc } = await load();
    expect(
      await svc.saveChannel(
        'hh-1',
        'u',
        { ...input, timezone: 'Mars/Olympus' },
        new Date(),
        saveDeps
      )
    ).toEqual({ status: 'invalid_timezone' });
  });
});

describe('the test post', () => {
  it('re-enables a disconnected channel when it lands', async () => {
    const { svc } = await load();
    mem.channels.set(
      'hh-1',
      channel({
        status: 'disabled',
        disabledReason: 'repeated_client_errors',
        consecutiveClientErrors: 3,
      }) as never
    );
    const result = await svc.sendTestPost('hh-1', new Date('2026-09-18T03:00:00Z'), deps);
    expect(result.status).toBe('sent');
    expect(stored()).toMatchObject({ status: 'active', consecutiveClientErrors: 0 });
    // Quiet hours and the 08:00 floor do not apply to a button press.
    expect(deps.post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deps.post.mock.calls[0][2])).toContain('Family Greenhouse is connected');
  });

  it('a failed test changes nothing but the cooldown, and says why', async () => {
    const { svc } = await load();
    mem.channels.set('hh-1', channel() as never);
    deps.post.mockResolvedValueOnce({
      ok: false,
      kind: 'client',
      httpStatus: 404,
      retryAfterSeconds: null,
    });
    const result = await svc.sendTestPost('hh-1', new Date('2026-09-18T12:00:00Z'), deps);
    expect(result).toMatchObject({ status: 'failed', kind: 'client', httpStatus: 404 });
    expect(stored()).toMatchObject({ status: 'active', consecutiveClientErrors: 0 });
  });

  it('two presses inside the cooldown post once', async () => {
    const { svc } = await load();
    mem.channels.set('hh-1', channel() as never);
    const t = new Date('2026-09-18T12:00:00Z');
    expect((await svc.sendTestPost('hh-1', t, deps)).status).toBe('sent');
    const second = await svc.sendTestPost('hh-1', new Date(t.getTime() + 5_000), deps);
    expect(second).toMatchObject({ status: 'cooldown', retryAfterSeconds: 25 });
    expect(deps.post).toHaveBeenCalledTimes(1);
  });

  it('with no channel there is nothing to test', async () => {
    const { svc } = await load();
    expect(await svc.sendTestPost('hh-1', new Date(), deps)).toEqual({ status: 'none' });
  });
});
