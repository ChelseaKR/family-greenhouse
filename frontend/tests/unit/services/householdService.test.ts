/**
 * Household membership, invites, and sitter links. The sitter-link contract is
 * the sensitive one: the token is returned exactly once, by create, and never
 * appears in the management listing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { householdService, listMyHouseholds } from '@/services/householdService';
import { track } from '@/services/analytics';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

vi.mock('@/services/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analytics')>();
  return { ...actual, track: vi.fn() };
});

const API = 'http://localhost:4000';

const household = {
  id: 'hh-1',
  name: 'Greenhouse',
  createdAt: '2026-01-01',
  createdBy: 'u1',
};

describe('householdService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ accessToken: 'access-1' });
  });

  it('getHousehold returns members without email addresses', async () => {
    server.use(
      http.get(`${API}/households/hh-1`, () =>
        HttpResponse.json({
          ...household,
          members: [{ userId: 'u1', name: 'Chelsea', role: 'admin', joinedAt: '2026-01-01' }],
        })
      )
    );

    const result = await householdService.getHousehold('hh-1');

    expect(result.members[0]).toEqual({
      userId: 'u1',
      name: 'Chelsea',
      role: 'admin',
      joinedAt: '2026-01-01',
    });
    expect(JSON.stringify(result)).not.toContain('@');
  });

  it('createHousehold posts the name', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/households`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(household);
      })
    );

    await expect(householdService.createHousehold({ name: 'Greenhouse' })).resolves.toMatchObject({
      id: 'hh-1',
    });
    expect(body).toEqual({ name: 'Greenhouse' });
  });

  it('createInvite tracks the invite and returns the shareable URL', async () => {
    server.use(
      http.post(`${API}/households/hh-1/invites`, () =>
        HttpResponse.json({
          code: 'abc123',
          expiresAt: '2026-08-10',
          url: 'https://familygreenhouse.net/join/abc123',
        })
      )
    );

    const invite = await householdService.createInvite('hh-1');

    expect(invite.url).toContain('abc123');
    expect(track).toHaveBeenCalledWith('invite_sent');
  });

  it('validates and redeems an invite code', async () => {
    server.use(
      http.get(`${API}/households/invites/abc123`, () =>
        HttpResponse.json({ household, valid: true })
      ),
      http.post(`${API}/households/join/abc123`, () => HttpResponse.json(household))
    );

    await expect(householdService.validateInvite('abc123')).resolves.toMatchObject({ valid: true });
    await expect(householdService.joinWithInvite('abc123')).resolves.toMatchObject({ id: 'hh-1' });
  });

  it('joinHousehold posts the invite code to the household route', async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/households/hh-1/join`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(household);
      })
    );

    await householdService.joinHousehold('hh-1', { inviteCode: 'abc123' });

    expect(body).toEqual({ inviteCode: 'abc123' });
  });

  it('removeMember and updateMemberRole target the member sub-resource', async () => {
    let roleBody: unknown;
    let removed = false;
    server.use(
      http.delete(`${API}/households/hh-1/members/u2`, () => {
        removed = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.put(`${API}/households/hh-1/members/u2/role`, async ({ request }) => {
        roleBody = await request.json();
        return HttpResponse.json({
          userId: 'u2',
          name: 'Sam',
          role: 'admin',
          joinedAt: '2026-02-01',
        });
      })
    );

    await expect(householdService.updateMemberRole('hh-1', 'u2', 'admin')).resolves.toMatchObject({
      role: 'admin',
    });
    await householdService.removeMember('hh-1', 'u2');

    expect(roleBody).toEqual({ role: 'admin' });
    expect(removed).toBe(true);
  });

  it('exposes the sitter token only on create, never in the listing', async () => {
    server.use(
      http.post(`${API}/households/hh-1/sitter-links`, () =>
        HttpResponse.json({
          id: 'sl-1',
          householdId: 'hh-1',
          createdBy: 'u1',
          createdAt: '',
          startsAt: '2026-08-10',
          expiresAt: '2026-08-20',
          status: 'active',
          label: 'Neighbor',
          token: 'secret-token',
          url: 'https://familygreenhouse.net/sit/secret-token',
        })
      ),
      http.get(`${API}/households/hh-1/sitter-links`, () =>
        HttpResponse.json([
          {
            id: 'sl-1',
            householdId: 'hh-1',
            createdBy: 'u1',
            createdAt: '',
            startsAt: '2026-08-10',
            expiresAt: '2026-08-20',
            status: 'active',
            label: 'Neighbor',
          },
        ])
      )
    );

    const created = await householdService.createSitterLink('hh-1', {
      expiresAt: '2026-08-20',
      label: 'Neighbor',
    });
    const listed = await householdService.listSitterLinks('hh-1');

    expect(created.token).toBe('secret-token');
    expect(listed[0]).not.toHaveProperty('token');
  });

  it('revokeSitterLink deletes the link by id', async () => {
    let revoked = false;
    server.use(
      http.delete(`${API}/households/hh-1/sitter-links/sl-1`, () => {
        revoked = true;
        return new HttpResponse(null, { status: 204 });
      })
    );

    await householdService.revokeSitterLink('hh-1', 'sl-1');

    expect(revoked).toBe(true);
  });

  it('sends explicit limits and windows on the reporting routes', async () => {
    const urls: string[] = [];
    server.use(
      http.get(`${API}/households/hh-1/activity`, ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json([]);
      }),
      http.get(`${API}/households/hh-1/analytics/daily`, ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json({ days: 30, series: [] });
      }),
      http.get(`${API}/households/hh-1/year-in-review`, ({ request }) => {
        urls.push(request.url);
        return HttpResponse.json({
          year: 2026,
          totalCompletions: 4,
          byMember: [],
          byTaskType: [],
          topPlants: [],
        });
      })
    );

    await householdService.getActivity('hh-1');
    await householdService.getActivity('hh-1', 10);
    await householdService.getDailyAnalytics('hh-1');
    await householdService.getYearInReview('hh-1', 2026);

    expect(urls[0]).toContain('limit=50');
    expect(urls[1]).toContain('limit=10');
    expect(urls[2]).toContain('days=30');
    expect(urls[3]).toContain('year=2026');
  });
});

describe('emailInvite', () => {
  it('posts the address and the inviter language, and reports the real outcome', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    let body: unknown = null;
    server.use(
      http.post(`${API}/households/hh-1/invites/email`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          {
            code: 'ABC',
            expiresAt: '2099-01-01T00:00:00.000Z',
            url: 'http://localhost:3000/join/ABC',
            status: 'accepted',
          },
          { status: 201 }
        );
      })
    );

    const result = await householdService.emailInvite('hh-1', 'friend@example.com', 'es');

    expect(body).toEqual({ email: 'friend@example.com', locale: 'es' });
    expect(result.status).toBe('accepted');
    // The link always comes back so the caller can fall back to copy-and-paste.
    expect(result.url).toBe('http://localhost:3000/join/ABC');
    expect(vi.mocked(track)).toHaveBeenCalledWith('invite_sent');
  });

  it('omits locale entirely when the caller does not supply one', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    let body: unknown = null;
    server.use(
      http.post(`${API}/households/hh-1/invites/email`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { code: 'A', expiresAt: '', url: 'u', status: 'accepted' },
          { status: 201 }
        );
      })
    );

    await householdService.emailInvite('hh-1', 'friend@example.com');

    expect(body).toEqual({ email: 'friend@example.com' });
  });

  it('passes a non-delivery status through instead of throwing', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(
      http.post(`${API}/households/hh-1/invites/email`, () =>
        HttpResponse.json(
          { code: 'A', expiresAt: '', url: 'u', status: 'unavailable' },
          { status: 201 }
        )
      )
    );

    await expect(householdService.emailInvite('hh-1', 'friend@example.com')).resolves.toMatchObject(
      { status: 'unavailable' }
    );
  });
});

describe('listMyHouseholds', () => {
  it('reads the caller memberships, not a single household', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([
          { householdId: 'hh-1', name: 'Greenhouse', role: 'admin', joinedAt: '2026-01-01' },
        ])
      )
    );

    await expect(listMyHouseholds()).resolves.toHaveLength(1);
  });
});
