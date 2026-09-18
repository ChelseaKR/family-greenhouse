import { describe, expect, it } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { predictedRosterRefusal, readLeaveRefusal } from '@/features/household/leaveHousehold';

function axios409(data: unknown, status = 409): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError('refused', 'ERR_BAD_REQUEST', { headers }, null, {
    status,
    statusText: '',
    headers: {},
    config: { headers },
    data,
  });
}

describe('readLeaveRefusal (#686)', () => {
  it.each(['LAST_MEMBER', 'LAST_ADMIN', 'BILLING_ACK_REQUIRED'])('recognises %s', (code) => {
    expect(readLeaveRefusal(axios409({ message: 'x', details: { code } }))).toBe(code);
  });

  it('treats anything else as an ordinary error', () => {
    expect(
      readLeaveRefusal(axios409({ message: 'x', details: { code: 'SOMETHING_NEW' } }))
    ).toBeNull();
    expect(readLeaveRefusal(axios409({ message: 'x' }))).toBeNull();
    expect(readLeaveRefusal(axios409({ details: { code: 'LAST_ADMIN' } }, 403))).toBeNull();
    expect(readLeaveRefusal(new Error('network'))).toBeNull();
  });
});

describe('predictedRosterRefusal', () => {
  it('predicts the only member and the only admin, and nothing else', () => {
    expect(predictedRosterRefusal('u1', [{ userId: 'u1', role: 'admin' }])).toBe('LAST_MEMBER');
    expect(
      predictedRosterRefusal('u1', [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'member' },
      ])
    ).toBe('LAST_ADMIN');
    expect(
      predictedRosterRefusal('u2', [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'member' },
      ])
    ).toBeNull();
    expect(
      predictedRosterRefusal('u1', [
        { userId: 'u1', role: 'admin' },
        { userId: 'u2', role: 'admin' },
      ])
    ).toBeNull();
  });

  it('predicts nothing before the user is known', () => {
    expect(predictedRosterRefusal(null, [{ userId: 'u1', role: 'admin' }])).toBeNull();
  });
});
