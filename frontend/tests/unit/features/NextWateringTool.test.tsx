import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

vi.mock('@/config/commercialStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/commercialStatus')>()),
  PUBLIC_REGISTRATION_AVAILABLE: true,
}));

vi.mock('@/services/googleAnalytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/googleAnalytics')>();
  return { ...actual, trackGoogleConversion: vi.fn() };
});

import { trackGoogleConversion } from '@/services/googleAnalytics';
import { NextWateringTool } from '@/features/care/NextWateringTool';

const ZZ = {
  slug: 'zz-plant',
  commonName: 'ZZ plant',
  guideUrl: 'https://familygreenhouse.net/care/zz-plant',
};
const MONSTERA = {
  slug: 'monstera',
  commonName: 'Monstera',
  guideUrl: 'https://familygreenhouse.net/care/monstera',
};

function tool(props: typeof ZZ) {
  return (
    <MemoryRouter>
      <dl>
        <div>
          <NextWateringTool {...props} />
        </div>
      </dl>
    </MemoryRouter>
  );
}

const calls = () => vi.mocked(trackGoogleConversion).mock.calls.map(([c]) => c);

beforeEach(() => {
  // Noon local time on 2026-12-02; only Date is faked, so user events still run.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 11, 2, 12, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(trackGoogleConversion).mockClear();
  vi.restoreAllMocks();
});

describe('NextWateringTool as served', () => {
  it('prerenders exactly the reminder link the row held before, and no tool', () => {
    for (const props of [ZZ, MONSTERA]) {
      const html = renderToString(tool(props));
      expect(html, props.slug).toContain('data-testid="care-glance-cta"');
      expect(html, props.slug).toContain(`href="/register?plant=${props.slug}"`);
      expect(html, props.slug).not.toContain('next-watering');
      expect(html, props.slug).not.toContain('When did you last water it?');
      expect(html, props.slug).not.toContain('no set number of days');
    }
  });
});

describe('NextWateringTool in the browser', () => {
  it('asks when the plant was last watered and dates the soil check from the guide', async () => {
    const user = userEvent.setup();
    render(tool(ZZ));
    expect(screen.queryByTestId('next-watering-result')).toBeNull();
    await user.selectOptions(screen.getByLabelText('When did you last water it?'), 'today');
    const result = screen.getByTestId('next-watering-result');
    expect(result.textContent).toContain('Check the soil around Wednesday, December 16.');
    expect(result.textContent).toContain('“About every 2 weeks in summer”');

    await user.selectOptions(screen.getByLabelText('When did you last water it?'), 'week');
    expect(screen.getByTestId('next-watering-result').textContent).toContain(
      'Check the soil around Wednesday, December 9.'
    );

    await user.selectOptions(screen.getByLabelText('When did you last water it?'), 'two_weeks');
    expect(screen.getByTestId('next-watering-result').textContent).toContain(
      'Check the soil today.'
    );
  });

  it('answers "Not sure" with today and never a date', async () => {
    const user = userEvent.setup();
    render(tool(ZZ));
    await user.selectOptions(screen.getByLabelText('When did you last water it?'), 'unsure');
    const text = screen.getByTestId('next-watering-result').textContent!;
    expect(text).toContain('Check the soil today.');
    expect(text).not.toMatch(/around|December|Wednesday/u);
  });

  it('says in words that a guide gives no number of days, and offers no date or calendar', () => {
    render(tool(MONSTERA));
    expect(screen.getByTestId('next-watering-tool').dataset.state).toBe('no-days');
    expect(screen.getByTestId('next-watering-no-days').textContent).toContain(
      'This guide gives no set number of days for a monstera'
    );
    expect(screen.queryByLabelText('When did you last water it?')).toBeNull();
    expect(screen.queryByTestId('next-watering-calendar')).toBeNull();
    expect(screen.getByTestId('next-watering-tool').textContent).not.toMatch(/\d/u);
    // The one reminder link is still there, once.
    expect(screen.getAllByTestId('care-glance-cta')).toHaveLength(1);
  });

  it('carries the answer to sign-up and counts the click as `tool`', async () => {
    const user = userEvent.setup();
    render(tool(ZZ));
    expect(screen.getByTestId('care-glance-cta').getAttribute('href')).toBe(
      '/register?plant=zz-plant'
    );
    await user.selectOptions(screen.getByLabelText('When did you last water it?'), 'week');
    const link = screen.getByTestId('care-glance-cta');
    expect(link.getAttribute('href')).toBe('/register?plant=zz-plant&last=week');
    expect(screen.getAllByTestId('care-glance-cta')).toHaveLength(1);
    await user.click(link);
    expect(calls()).toEqual([
      { name: 'landing_cta_click', source: 'care_guide', placement: 'tool', plant: 'zz-plant' },
    ]);
  });

  it('saves a repeating calendar event made on the device and counts only the slug', async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    const created = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:fg-test';
    });
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const fetched = vi.spyOn(globalThis, 'fetch');

    render(tool(ZZ));
    await user.selectOptions(screen.getByLabelText('When did you last water it?'), 'today');
    await user.click(screen.getByTestId('next-watering-calendar'));

    expect(created).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(fetched).not.toHaveBeenCalled();
    const ics = await blobs[0]!.text();
    expect(blobs[0]!.type).toBe('text/calendar;charset=utf-8');
    const lines = ics.replace(/\r\n /g, '').split('\r\n');
    expect(lines).toContain('DTSTART;VALUE=DATE:20261216');
    expect(lines).toContain('RRULE:FREQ=DAILY;INTERVAL=14');
    expect(lines).toContain('SUMMARY:Check the soil: ZZ plant');
    expect(lines).toContain('URL:https://familygreenhouse.net/care/zz-plant');
    expect(lines.find((l) => l.startsWith('DESCRIPTION:'))).toContain(
      'https://familygreenhouse.net/care/zz-plant'
    );
    expect(calls()).toEqual([{ name: 'care_calendar_add', plant: 'zz-plant' }]);
    expect(screen.getByTestId('next-watering-result').textContent).toContain('every 14 days');
  });

  it('starts a "Not sure" calendar event today', async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return 'blob:fg-test';
      },
      revokeObjectURL: () => {},
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(tool(ZZ));
    await user.selectOptions(screen.getByLabelText('When did you last water it?'), 'unsure');
    await user.click(screen.getByTestId('next-watering-calendar'));
    expect(await blobs[0]!.text()).toContain('DTSTART;VALUE=DATE:20261202');
  });

  it('says so, and counts nothing, when the browser cannot save a file', async () => {
    const user = userEvent.setup();
    Object.assign(URL, { createObjectURL: undefined });
    render(tool(ZZ));
    await user.selectOptions(screen.getByLabelText('When did you last water it?'), 'today');
    await user.click(screen.getByTestId('next-watering-calendar'));
    expect(screen.getByTestId('next-watering-result').textContent).toContain(
      'couldn’t save the calendar file'
    );
    expect(calls()).toEqual([]);
  });
});
