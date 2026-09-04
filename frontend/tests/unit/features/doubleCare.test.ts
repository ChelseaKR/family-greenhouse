import { describe, expect, it } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import i18n from '@/i18n';
import { describeDuplicate, describeElapsed, readDuplicateCare } from '@/features/tasks/doubleCare';

const duplicate = {
  completionId: 'c-sam',
  completedAt: '2026-09-03T08:00:00.000Z',
  completedBy: 'user-sam',
  completedByName: 'Sam',
  taskId: 't1',
  taskType: 'water',
  sameTask: true,
  windowHours: 24,
};

function axiosError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, undefined, {
    status,
    statusText: '',
    headers: {},
    config,
    data,
  });
}

describe('readDuplicateCare', () => {
  it('recognises the 409 DUPLICATE_CARE contract', () => {
    const details = readDuplicateCare(
      axiosError(409, {
        message: 'Sam already logged water for Fern.',
        details: { code: 'DUPLICATE_CARE', plantName: 'Fern', duplicate },
      })
    );
    expect(details).toEqual({ code: 'DUPLICATE_CARE', plantName: 'Fern', duplicate });
  });

  it('leaves any other 409 (e.g. a lost claim race) as an ordinary error', () => {
    expect(readDuplicateCare(axiosError(409, { message: 'Already claimed' }))).toBeNull();
  });

  it('ignores a DUPLICATE_CARE body missing the fields the prompt needs', () => {
    expect(
      readDuplicateCare(
        axiosError(409, {
          message: 'x',
          details: { code: 'DUPLICATE_CARE', duplicate: { completionId: 'c' } },
        })
      )
    ).toBeNull();
  });

  it('ignores non-409s and non-axios errors', () => {
    expect(
      readDuplicateCare(
        axiosError(400, { details: { code: 'DUPLICATE_CARE', plantName: 'F', duplicate } })
      )
    ).toBeNull();
    expect(readDuplicateCare(new Error('nope'))).toBeNull();
  });
});

describe('describeElapsed', () => {
  const now = new Date('2026-09-03T12:00:00.000Z');

  it('rounds to the coarsest useful unit', () => {
    expect(describeElapsed('2026-09-03T11:59:40.000Z', now)).toEqual({ unit: 'now' });
    expect(describeElapsed('2026-09-03T11:35:00.000Z', now)).toEqual({
      unit: 'minutes',
      count: 25,
    });
    expect(describeElapsed('2026-09-03T08:00:00.000Z', now)).toEqual({ unit: 'hours', count: 4 });
    expect(describeElapsed('2026-08-31T12:00:00.000Z', now)).toEqual({ unit: 'days', count: 3 });
  });

  it('is null for an unparseable instant rather than a made-up one', () => {
    expect(describeElapsed('yesterday-ish', now)).toBeNull();
  });
});

describe('describeDuplicate', () => {
  it('words the notice from the catalog', () => {
    const t = i18n.getFixedT('en');
    const text = describeDuplicate(
      { code: 'DUPLICATE_CARE', plantName: 'Fern', duplicate },
      (key, options) => t(key, options as never)
    );
    expect(text).toMatch(/^Sam logged Water for Fern .* ago\. Log it anyway\?$/);
  });

  it('falls back to the raw custom care type and a generic plant', () => {
    const t = i18n.getFixedT('en');
    const text = describeDuplicate(
      {
        code: 'DUPLICATE_CARE',
        plantName: '',
        duplicate: { ...duplicate, taskType: 'Misting', completedAt: 'bad' },
      },
      (key, options) => t(key, options as never)
    );
    expect(text).toBe('Sam logged Misting for a plant . Log it anyway?'.replace(' .', ' .'));
  });
});
