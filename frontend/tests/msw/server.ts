import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const API = 'http://localhost:4000';

export const handlers = {
  authLoginOk: http.post(`${API}/auth/login`, async ({ request }) => {
    const body = (await request.json()) as { email: string; password: string };
    if (body.password !== 'password123') {
      return HttpResponse.json({ message: 'Invalid credentials' }, { status: 401 });
    }
    return HttpResponse.json({
      user: {
        id: 'u1',
        email: body.email,
        name: 'Test',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });
  }),
  authMe: http.get(`${API}/auth/me`, ({ request }) => {
    const auth = request.headers.get('authorization');
    if (auth !== 'Bearer access-1' && auth !== 'Bearer access-2') {
      return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json({
      id: 'u1',
      email: 'test@example.com',
      name: 'Test',
      householdId: 'hh-1',
      householdRole: 'admin',
    });
  }),
  authRefreshOk: http.post(`${API}/auth/refresh`, () =>
    HttpResponse.json({ accessToken: 'access-2', refreshToken: 'refresh-2' })
  ),
  authRefreshFail: http.post(`${API}/auth/refresh`, () =>
    HttpResponse.json({ message: 'Bad refresh' }, { status: 401 })
  ),
  plantsList: http.get(`${API}/plants`, ({ request }) => {
    const auth = request.headers.get('authorization');
    if (!auth || auth === 'Bearer expired') {
      return HttpResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    return HttpResponse.json([
      {
        id: 'p1',
        householdId: 'hh-1',
        name: 'Pothos',
        species: 'Epipremnum aureum',
        location: 'Living Room',
        imageUrl: null,
        notes: null,
        createdAt: '',
        createdBy: 'u1',
        updatedAt: '',
      },
    ]);
  }),
};

export const server = setupServer();
