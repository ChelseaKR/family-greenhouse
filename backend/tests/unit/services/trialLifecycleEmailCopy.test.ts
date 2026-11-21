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
  // Portfolio copy rules: nothing is "unlimited", and Family Greenhouse never
  // says it has no tracking.
  /unlimited/i,
  /ilimitad/i,
  /no tracking/i,
  /sin (seguimiento|rastreo)/i,
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
 * The trial emails are account notices, not offers (owner decision 2026-11-19,
 * ADR 0039 §7 as amended): the dates, what changes and that nothing is
 * deleted. No price, no plans link or button, no line about keeping Garden.
 * The unsubscribe header and link stay.
 */
describe('a notice, not an offer', () => {
  // Every link target in the email's HTML, by plain string splitting.
  const hrefs = (html: string) =>
    html
      .split('href="')
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf('"')));
  // A currency amount in any form Intl or a person would write it:
  // $2.99, US$, 2,99 US$, €, a bare 24.99.
  const CURRENCY = /[$€£]|US\$|\bUSD\b|\d+[.,]\d{2}\b/;
  const PROMO = [
    /see plans/i,
    /ver los planes/i,
    /plan status/i,
    /estado del plan/i,
    /keep garden/i,
    /conservar garden/i,
    /garden back/i,
    /recuperar garden/i,
    /a (month|year)\b/i,
    /al (mes|año)\b/i,
    /first charge/i,
    /primer cobro/i,
    /pricing/i,
    /precios?\b/i,
    /\bsubscri/i,
    /\bsuscri/i,
  ];
  const facts: Record<string, TrialFacts> = {
    usual: FACTS,
    noPlant: { ...FACTS, plantsAdded: ok(0), tasksCompleted: ok(0), plantsNow: ok(0) },
    plantsFromBefore: { ...FACTS, plantsAdded: ok(0), tasksCompleted: ok(0), plantsNow: ok(5) },
    unreadable: {
      plantsAdded: { status: 'unavailable' },
      tasksCompleted: { status: 'unavailable' },
      plantsNow: { status: 'unavailable' },
      membersNow: { status: 'unavailable' },
    },
  };
  const sendTimes = {
    // Early on day 10, and inside checkout's minimum lead, where the old copy
    // switched to a different charge sentence.
    trial_day10: ['2026-10-11T17:30:00.000Z', '2026-10-14T00:00:00.000Z'],
    trial_day14: ['2026-10-16T17:30:00.000Z'],
  } as const;
  const cases = (['en', 'es'] as const).flatMap((locale) =>
    (['trial_day10', 'trial_day14'] as const).flatMap((kind) =>
      Object.keys(facts).flatMap((name) =>
        sendTimes[kind].map((at) => [locale, kind, name, at] as const)
      )
    )
  );
  const compose = (
    locale: 'en' | 'es',
    kind: 'trial_day10' | 'trial_day14',
    name: string,
    at: string
  ) => composeTrialLifecycleEmail(ctx({ locale, kind, now: new Date(at), facts: facts[name] }));

  it.each(cases)('%s %s (%s, at %s) names no price', (locale, kind, name, at) => {
    const e = compose(locale, kind, name, at);
    for (const part of [e.subject, e.preheader, e.text, e.html]) {
      expect(part).not.toMatch(CURRENCY);
    }
  });

  it.each(cases)(
    '%s %s (%s, at %s) has no plans link, plans button or upsell line',
    (locale, kind, name, at) => {
      const e = compose(locale, kind, name, at);
      for (const href of hrefs(e.html)) {
        expect(href).not.toMatch(/billing|pricing|plans?\b|checkout/i);
      }
      for (const re of PROMO) {
        expect(e.subject).not.toMatch(re);
        expect(e.text).not.toMatch(re);
        expect(e.html).not.toMatch(re);
      }
    }
  );

  it.each(cases)(
    '%s %s (%s, at %s) keeps the unsubscribe header and link',
    (locale, kind, name, at) => {
      const e = compose(locale, kind, name, at);
      expect(e.headers).toEqual({
        'List-Unsubscribe':
          '<https://api.familygreenhouse.net/notifications/email/unsubscribe?t=tok>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
      expect(hrefs(e.html)).toContain(
        'https://api.familygreenhouse.net/notifications/email/unsubscribe?t=tok'
      );
    }
  );

  it('still states the dates and that nothing is charged', () => {
    const d10 = composeTrialLifecycleEmail(ctx());
    expect(d10.text).toContain('ends on October 15, 2026');
    expect(d10.text).toContain('nothing will be charged');
    expect(d10.text).toContain('moves to Seedling, the free plan, on its own');
    const d14 = composeTrialLifecycleEmail(ctx({ kind: 'trial_day14' }));
    expect(d14.text).toContain('ended on October 15, 2026');
    expect(d14.text).toContain('nothing was charged');
  });
});

/**
 * The facts are counted inside the trial window (`readTrialFacts`, from
 * endsAt minus 14 days). A household that already had plants when its trial
 * began and added none during it must not be told it has no plant.
 */
describe('a household that had plants before the trial', () => {
  const before: TrialFacts = {
    ...FACTS,
    plantsAdded: ok(0),
    tasksCompleted: ok(3),
    plantsNow: ok(5),
  };

  it.each(['trial_day10', 'trial_day14'] as const)(
    '%s names the plants it has now, not "not added a plant"',
    (kind) => {
      const e = composeTrialLifecycleEmail(ctx({ kind, facts: before }));
      expect(e.text).toContain('Your household has 5 active plants.');
      expect(e.html).toContain('Your household has 5 active plants.');
      expect(e.text).not.toContain('not added a plant');
      expect(e.text).not.toContain('Add your first plant');
      expect(e.text).not.toContain('You added');
      // With plants, the care tasks done during the trial are shown.
      expect(e.text).toContain('Your household marked 3 care tasks done.');
    }
  );

  it('uses the singular for one plant', () => {
    const e = composeTrialLifecycleEmail(ctx({ facts: { ...before, plantsNow: ok(1) } }));
    expect(e.text).toContain('Your household has 1 active plant.');
  });

  it('does not say no task was ever done, only none during the trial', () => {
    const e = composeTrialLifecycleEmail(
      ctx({ kind: 'trial_day14', facts: { ...before, tasksCompleted: ok(0) } })
    );
    expect(e.text).toContain('No care task has been marked done during the trial.');
    expect(e.text).not.toContain('marked done yet');
  });

  it('says the same in Spanish', () => {
    for (const kind of ['trial_day10', 'trial_day14'] as const) {
      const e = composeTrialLifecycleEmail(ctx({ locale: 'es', kind, facts: before }));
      expect(e.text).toContain('Tu hogar tiene 5 plantas activas.');
      expect(e.text).not.toContain('no has añadido ninguna planta');
    }
    const one = composeTrialLifecycleEmail(
      ctx({ locale: 'es', facts: { ...before, plantsNow: ok(1), tasksCompleted: ok(0) } })
    );
    expect(one.text).toContain('Tu hogar tiene 1 planta activa.');
    expect(one.text).toContain(
      'No se ha marcado ninguna tarea de cuidado como hecha durante la prueba.'
    );
  });
});

describe('absence is never rendered as achievement', () => {
  const none: TrialFacts = {
    ...FACTS,
    plantsAdded: ok(0),
    tasksCompleted: ok(0),
    plantsNow: ok(0),
  };
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
    expect(e.text).toContain('No care task has been marked done during the trial.');
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

describe('day 10 for a household with no plant (decision C1)', () => {
  const none: TrialFacts = {
    ...FACTS,
    plantsAdded: ok(0),
    tasksCompleted: ok(0),
    plantsNow: ok(0),
  };
  // Every link target in the email's HTML, in order, by plain string splitting.
  const hrefs = (html: string) =>
    html
      .split('href="')
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf('"')));

  it('leads with "Add your first plant" and its button, and no plans line follows', () => {
    const e = composeTrialLifecycleEmail(ctx({ facts: none }));
    const lead = e.text.indexOf('Add your first plant and say how often it needs water');
    // The plain-text part prints headings in capitals.
    const changes = e.text.indexOf('WHAT CHANGES ON');
    expect(lead).toBeGreaterThan(-1);
    expect(changes).toBeGreaterThan(lead);
    expect(e.text).toContain('You have not added a plant yet.');
    const links = hrefs(e.html);
    expect(links.filter((h) => h.endsWith('/plants/new'))).toHaveLength(1);
    // The plans line and its button are gone (owner decision 2026-11-19).
    expect(links.some((h) => h.endsWith('/settings/billing'))).toBe(false);
    expect(e.text).not.toContain('See plans in Settings');
    expect(e.text).not.toContain('If you would like to keep Garden');
    // With nothing to count, the facts section is not repeated.
    expect(e.text).not.toContain('What your household did during the trial');
  });

  it('says the same in Spanish', () => {
    const e = composeTrialLifecycleEmail(ctx({ locale: 'es', facts: none }));
    expect(e.text).toContain(
      'Todavía no has añadido ninguna planta. Añade tu primera planta e indica cada cuánto necesita agua'
    );
    expect(e.html).toContain('Añadir tu primera planta');
    expect(e.text).not.toContain('Ver los planes en Ajustes');
  });

  it('keeps the usual email for a household with plants', () => {
    const e = composeTrialLifecycleEmail(ctx());
    expect(e.text).not.toContain('Add your first plant');
    expect(hrefs(e.html).some((h) => h.endsWith('/plants/new'))).toBe(false);
    expect(e.text).toContain('You added 6 plants.');
  });

  it('never leads with it on an unreadable count, or when plants exist now', () => {
    const unread = composeTrialLifecycleEmail(
      ctx({ facts: { ...none, plantsAdded: { status: 'unavailable' } } })
    );
    expect(unread.text).not.toContain('Add your first plant');
    const hasNow = composeTrialLifecycleEmail(ctx({ facts: { ...none, plantsNow: ok(2) } }));
    expect(hasNow.text).not.toContain('Add your first plant');
    // It had plants before the trial: it is told what it has, not that it has none.
    expect(hasNow.text).toContain('Your household has 2 active plants.');
    expect(hasNow.text).not.toContain('not added a plant');
    // An unreadable plantsNow does not undo a real 0.
    const nowUnread = composeTrialLifecycleEmail(
      ctx({ facts: { ...none, plantsNow: { status: 'unavailable' } } })
    );
    expect(nowUnread.text).toContain('Add your first plant');
  });

  it('day 14 is unchanged', () => {
    const e = composeTrialLifecycleEmail(ctx({ kind: 'trial_day14', facts: none }));
    expect(e.text).not.toContain('Add your first plant');
    expect(e.text).toContain('You have not added a plant yet.');
  });

  it('has no urgency language', () => {
    const e = composeTrialLifecycleEmail(ctx({ facts: none }));
    for (const re of BANNED) expect(e.text).not.toMatch(re);
  });
});

describe('tone', () => {
  it.each([
    ['en', 'trial_day10'],
    ['en', 'trial_day14'],
    ['es', 'trial_day10'],
    ['es', 'trial_day14'],
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
      ctx({ locale: 'es', facts: { ...FACTS, plantsAdded: ok(0), plantsNow: ok(0) } })
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
