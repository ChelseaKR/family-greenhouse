import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleDriftHint } from '@/features/plants/ScheduleDriftHint';
import type { ScheduleDrift } from '@/services/taskService';

const base: ScheduleDrift = {
  taskId: 't1',
  scheduledIntervalDays: 7,
  completionsConsidered: 5,
  requiredCompletions: 4,
  drift: {
    medianIntervalDays: 11,
    driftPct: 0.571,
    suggestedFrequency: 11,
    exceedsThreshold: true,
  },
  reason: null,
};

describe('ScheduleDriftHint', () => {
  it('renders the suggestion and fires the one-tap match', async () => {
    const onMatch = vi.fn();
    render(<ScheduleDriftHint drift={base} onMatch={onMatch} isMatching={false} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'You do this about every 11 days, but it’s scheduled every 7 days.'
    );
    await userEvent.click(screen.getByRole('button', { name: /match schedule to reality/i }));
    expect(onMatch).toHaveBeenCalledTimes(1);
  });

  it('uses the singular for a one-day interval', () => {
    render(
      <ScheduleDriftHint
        drift={{
          ...base,
          scheduledIntervalDays: 1,
          drift: { ...base.drift!, suggestedFrequency: 2 },
        }}
        onMatch={() => {}}
        isMatching={false}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'You do this about every 2 days, but it’s scheduled every day.'
    );
  });

  it('renders nothing below the threshold, for drift: null, and before the read lands', () => {
    const { container: aligned } = render(
      <ScheduleDriftHint
        drift={{ ...base, drift: { ...base.drift!, exceedsThreshold: false } }}
        onMatch={() => {}}
        isMatching={false}
      />
    );
    expect(aligned).toBeEmptyDOMElement();

    const { container: insufficient } = render(
      <ScheduleDriftHint
        drift={{
          ...base,
          completionsConsidered: 2,
          drift: null,
          reason: 'insufficient_completions',
        }}
        onMatch={() => {}}
        isMatching={false}
      />
    );
    expect(insufficient).toBeEmptyDOMElement();

    const { container: pending } = render(
      <ScheduleDriftHint drift={undefined} onMatch={() => {}} isMatching={false} />
    );
    expect(pending).toBeEmptyDOMElement();
  });
});
