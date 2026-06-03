import { describe, expect, it } from 'vitest';
import { authService } from '@/services/authService';
import { useAuthStore } from '@/store/authStore';
import { server, handlers } from '../../msw/server';

describe('authService', () => {
  it('login returns the user/tokens payload', async () => {
    server.use(handlers.authLoginOk);
    const res = await authService.login({
      email: 'test@example.com',
      password: 'password123',
    });
    expect(res.user.email).toBe('test@example.com');
    expect(res.accessToken).toBe('access-1');
  });

  it('login surfaces 401 as a thrown error', async () => {
    server.use(handlers.authLoginOk);
    await expect(
      authService.login({ email: 'test@example.com', password: 'wrong' })
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('getCurrentUser sends bearer token from the store', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(handlers.authMe);
    const me = await authService.getCurrentUser();
    expect(me.id).toBe('u1');
  });
});
