import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  composeTrialLifecycleEmail,
  daysLeft,
  formatEndDate,
  type TrialEmailContext,
} from '../../../src/services/trialLifecycleEmailCopy.js';
import { PLANS } from '../../../src/models/plans.js';
import type { TrialFacts } from '../../../src/services/trialLifecycleFacts.js';

const ok = (value: number) => ({ status: 'ok' as const, value });
const FACTS: TrialFacts = {
  plantsAdded: ok(6),
  tasksCompleted: ok(11),
  plantsNow: ok(6),
  membersNow: ok(2),
};
const ENDS = '2026-10-15T10:00:00.000Z';

function ctx(over: Partial<TrialEmailContext> = {}): TrialEmailContext {
  return {
    kind: 'trial_day10',
    locale: 'en',
    recipientName: 'Sam',
    endsAt: ENDS,
    now: new Date('2026-10-11T17:30:00.000Z'),
    timeZone: 'America/Los_Angeles',
    facts: FACTS,
    unsubscribeUrl: 'https://api.familygreenhouse.net/notifications/email/unsubscribe?t=tok',
    ...over,
  };
}

const BANNED = [
  /last chance/i,
  /hurry/i,
  /act now/i,
  /don'?t miss/i,
  /limited time/i,
  /expires? (soon|today)/i,
  /discount/i,
  /promo/i,
  /coupon/i,
  /% off/i,
  /\bsave\b/i,
  /exclusive/i,
  /only \d+ (days?|hours?) left/i,
  /!/,
];

describe('day 10', () => {
  const email = composeTrialLifecycleEmail(ctx());

  it('says how long is left, and the date in the recipient’s zone', () => {
    expect(email.subject).toBe('Your Garden trial ends in 4 days');
    expect(email.text).toContain('October 15, 2026');
    expect(email.html).toContain('October 15, 2026');
    expect(email.preheader).toContain('Nothing is charged');
  });

  it('uses the singular for one day left', () => {
    const one = composeTrialLifecycleEmail(ctx({ now: new Date('2026-10-14T12:00:00.000Z') }));
    expect(one.subject).toBe('Your Garden trial ends in 1 day');
  });

  it('is honest about caps, not deletions, with figures from the plan catalog', () => {
    const plants = PLANS.seedling.limits.plants as number;
    const members = PLANS.seedling.limits.members as number;
    expect(email.text).toContain(`Seedling holds up to ${plants} active plants`);
    expect(email.text).toContain(`up to ${members} in a household`);
    expect(email.text).toContain('Everything you have made stays');
    expect(email.text).toContain('nothing will be charged');
    expect(email.text).not.toMatch(/delet(e|ed|ion)s? (your|all|them)/i);
  });

  it('prints the plan price from the catalog, once, and no code', () => {
    const price = `$${PLANS.garden.monthlyPrice}`;
    expect(email.text.split(price).length - 1).toBe(1);
    expect(email.text).toContain('Settings');
  });

  it('shows the counts it read', () => {
    expect(email.text).toContain('You added 6 plants.');
    expect(email.text).toContain('Your household marked 11 care tasks done.');
  });
});

describe('day 14', () => {
  const email = composeTrialLifecycleEmail(ctx({ kind: 'trial_day14' }));
  it('says the household is back on Seedling and that nothing was deleted', () => {
    expect(email.subject).toBe('You are back on Seedling, and nothing was deleted');
    expect(email.text).toContain('now on Seedling');
    expect(email.text).toMatch(/nothing was deleted/i);
    expect(email.text).toContain('is still in your household');
    expect(email.text).toContain('No card was on file, and nothing was charged');
  });
  it('states an over-cap household keeps everything, with its own counts', () => {
    // Created after the 2026-10-23 cut: Seedling's caps are 8 and 2 (ADR 0040).
    const over = composeTrialLifecycleEmail(
      ctx({
        kind: 'trial_day14',
        householdCreatedAt: '2026-11-02T10:00:00.000Z',
        facts: { ...FACTS, plantsNow: ok(9), membersNow: ok(3) },
      })
    );
    expect(over.text).toContain('Seedling holds up to 8 active plants');
    expect(over.text).toContain('You have 9 active plants, more than Seedling’s 8. They all stay.');
    expect(over.text).toContain(
      'Your household has 3 people, more than Seedling’s 2. They all stay.'
    );
    expect(email.text).not.toContain('more than Seedling');
  });
  it('names the grandfathered caps to a household created before the cut (ADR 0040)', () => {
    const facts = { ...FACTS, plantsNow: ok(9), membersNow: ok(3) };
    const before = composeTrialLifecycleEmail(
      ctx({ kind: 'trial_day14', householdCreatedAt: '2026-10-01T10:00:00.000Z', facts })
    );
    // 9 plants and 3 people are inside 20 and 3: nothing is over.
    expect(before.text).toContain('Seedling holds up to 20 active plants');
    expect(before.text).not.toContain('more than Seedling');
    const over = composeTrialLifecycleEmail(
      ctx({
        kind: 'trial_day14',
        householdCreatedAt: '2026-10-01T10:00:00.000Z',
        facts: { ...FACTS, plantsNow: ok(31), membersNow: ok(5) },
      })
    );
    expect(over.text).toContain(
      'You have 31 active plants, more than Seedling’s 20. They all stay.'
    );
    expect(over.text).toContain(
      'Your household has 5 people, more than Seedling’s 3. They all stay.'
    );
  });
  it('does not claim an over-cap state it could not read', () => {
    const unknown = composeTrialLifecycleEmail(
      ctx({
        kind: 'trial_day14',
        facts: {
          ...FACTS,
          plantsNow: { status: 'unavailable' },
          membersNow: { status: 'unavailable' },
        },
      })
    );
    expect(unknown.text).not.toContain('more than Seedling');
  });
});

/**
 * No stacked trials (owner decision 2026-10-23): checkout during the no-card
 * trial ends the Stripe trial on the no-card end date, so the email names that
 * date as the first charge, never "14 more days".
 */
describe('the first charge matches checkout (no stacked trials)', () => {
  it('day 10 names the trial end as the first charge, with the last day to start it', () => {
    const email = composeTrialLifecycleEmail(ctx());
    // ENDS is 2026-10-15T10:00Z; minus 48h30m is 2026-10-13T09:30Z, which is
    // October 13 in Los Angeles.
    expect(email.text).toContain(
      'If you start it before October 13, 2026, you add a card then, and your first charge would be on October 15, 2026, the day the trial ends.'
    );
    expect(email.text).not.toMatch(/14 (more|free) days|another 14/i);
  });

  it('day 10 sent inside the minimum lead says the charge is the day you start', () => {
    const late = composeTrialLifecycleEmail(ctx({ now: new Date('2026-10-14T00:00:00.000Z') }));
    expect(late.text).toContain('the first charge is the day you start it');
    expect(late.text).not.toContain('your first charge would be on');
  });

  it('day 14 says the first charge is the day Garden starts', () => {
    const email = composeTrialLifecycleEmail(ctx({ kind: 'trial_day14' }));
    expect(email.text).toContain('If you would like Garden back');
    expect(email.text).toContain('the first charge is the day you start it');
    expect(email.text).not.toContain('your first charge would be on');
  });

  it('says the same in Spanish', () => {
    const d10 = composeTrialLifecycleEmail(ctx({ locale: 'es' }));
    expect(d10.text).toContain(
      'Si lo empiezas antes del 13 de octubre de 2026, añades una tarjeta en ese momento y el primer cobro sería el 15 de octubre de 2026'
    );
    const d14 = composeTrialLifecycleEmail(ctx({ locale: 'es', kind: 'trial_day14' }));
    expect(d14.text).toContain('el primer cobro es el día en que lo empiezas');
  });
});

describe('absence is never rendered as achievement', () => {
  const none: TrialFacts = { ...FACTS, plantsAdded: ok(0), tasksCompleted: ok(0) };
  it('says plainly that no plant has been added, and shows no zero count', () => {
    for (const kind of ['trial_day10', 'trial_day14'] as const) {
      const e = composeTrialLifecycleEmail(ctx({ kind, facts: none }));
      expect(e.text).toContain('You have not added a plant yet.');
      expect(e.html).toContain('You have not added a plant yet.');
      expect(e.text).not.toMatch(/\b0 (plants|care tasks)\b/);
      expect(e.text).not.toContain('marked 0');
      expect(e.text).not.toContain('added 0');
    }
  });
  it('says no task has been marked done when plants exist but nothing was done', () => {
    const e = composeTrialLifecycleEmail(ctx({ facts: { ...FACTS, tasksCompleted: ok(0) } }));
    expect(e.text).toContain('You added 6 plants.');
    expect(e.text).toContain('No care task has been marked done yet.');
    expect(e.text).not.toContain('marked 0');
  });
  it('leaves out a count it could not read and says so, never 0', () => {
    const e = composeTrialLifecycleEmail(
      ctx({
        facts: {
          ...FACTS,
          plantsAdded: { status: 'unavailable' },
          tasksCompleted: { status: 'unavailable' },
        },
      })
    );
    expect(e.text).toContain('We could not load your household’s counts');
    expect(e.text).not.toMatch(/You added/);
    expect(e.text).not.toMatch(/marked \d/);
    expect(e.text).not.toContain('not added a plant');
  });
});

describe('tone', () => {
  it.each([
    ['en', 'trial_day10'],
    ['en', 'trial_day14'],
  ] as const)('%s %s has no urgency language, discounts or exclamation marks', (locale, kind) => {
    const e = composeTrialLifecycleEmail(ctx({ locale, kind }));
    for (const re of BANNED) {
      expect(e.subject).not.toMatch(re);
      expect(e.text).not.toMatch(re);
    }
  });

  it('is American English', () => {
    for (const kind of ['trial_day10', 'trial_day14'] as const) {
      const e = composeTrialLifecycleEmail(ctx({ kind }));
      expect(e.text).not.toMatch(/\b(colour|favour|organis|cancelled|whilst|programme|analyse)/i);
    }
  });
});

describe('structure', () => {
  it('has an HTML and a text part, the preheader hidden in the HTML, and one-click unsubscribe', () => {
    const e = composeTrialLifecycleEmail(ctx());
    expect(e.html).toContain('<!DOCTYPE html>');
    expect(e.html).toContain(e.preheader.replace(/'/g, '&#39;'));
    expect(e.headers).toEqual({
      'List-Unsubscribe':
        '<https://api.familygreenhouse.net/notifications/email/unsubscribe?t=tok>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(e.text).toContain('Unsubscribe from these: https://api.familygreenhouse.net');
    expect(e.html).toContain('Unsubscribe from these');
    expect(e.text).toContain('Reply to this email');
  });

  it('omits the header and the link, and still renders, when there is no unsubscribe URL', () => {
    const e = composeTrialLifecycleEmail(ctx({ unsubscribeUrl: null }));
    expect(e.headers).toBeUndefined();
    expect(e.text).not.toContain('Unsubscribe from these');
  });

  it('escapes a hostile recipient name', () => {
    const e = composeTrialLifecycleEmail(ctx({ recipientName: '<script>alert(1)</script>' }));
    expect(e.html).not.toContain('<script>alert(1)</script>');
    expect(e.html).toContain('&lt;script&gt;');
  });

  it('greets generically without a name', () => {
    expect(composeTrialLifecycleEmail(ctx({ recipientName: null })).text).toContain('Hi there,');
    expect(composeTrialLifecycleEmail(ctx({ recipientName: '  ' })).text).toContain('Hi there,');
  });
});

describe('Spanish', () => {
  it('renders both emails with the same facts and structure', () => {
    const d10 = composeTrialLifecycleEmail(ctx({ locale: 'es' }));
    const d14 = composeTrialLifecycleEmail(ctx({ locale: 'es', kind: 'trial_day14' }));
    expect(d10.subject).toBe('Tu prueba de Garden termina en 4 días');
    expect(d10.text).toContain('15 de octubre de 2026');
    expect(d14.subject).toBe('Has vuelto a Seedling y no se borró nada');
    expect(d10.html).toContain('lang="es"');
    const none = composeTrialLifecycleEmail(
      ctx({ locale: 'es', facts: { ...FACTS, plantsAdded: ok(0) } })
    );
    expect(none.text).toContain('Todavía no has añadido ninguna planta.');
  });
});

describe('helpers', () => {
  it('daysLeft never goes below 1 and rounds up', () => {
    expect(daysLeft(ENDS, new Date('2026-10-11T17:30:00.000Z'))).toBe(4);
    expect(daysLeft(ENDS, new Date('2026-10-15T09:00:00.000Z'))).toBe(1);
    expect(daysLeft(ENDS, new Date('2026-10-20T00:00:00.000Z'))).toBe(1);
  });
  it('formatEndDate falls back to UTC for a zone Intl rejects', () => {
    expect(formatEndDate('en', ENDS, 'Not/AZone')).toBe('October 15, 2026');
  });
});
