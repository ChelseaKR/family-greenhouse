import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { PublicShell } from '@/components/PublicShell';
import { planBandFor } from '@/features/landing/planBand';

describe('free registration with paid activity on hold', () => {
  it('links the shared public shell to free registration', () => {
    render(
      <MemoryRouter>
        <PublicShell>Public content</PublicShell>
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: /try the app/i })).toHaveAttribute('href', '/register');
  });

  it('keeps paid acquisition controls out of public signup surfaces', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    const relativePaths = [
      'frontend/src/features/auth/RegisterPage.tsx',
      'frontend/src/features/landing/LandingPage.tsx',
      'frontend/src/features/pricing/PricingGrid.tsx',
      'frontend/src/features/pricing/PricingPage.tsx',
      'frontend/index.html',
      'frontend/vite.config.ts',
    ];
    const forbidden = [
      /\$\s*\d/,
      /start free trial/i,
      /subscribe now/i,
      /checkout session/i,
      /upgrade to (?:garden|greenhouse)/i,
    ];

    for (const relativePath of relativePaths) {
      const source = readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${relativePath} contains ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('keeps every public registration CTA behind the shared kill switch', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    const acquisitionSurfaces = [
      'frontend/src/features/auth/LoginPage.tsx',
      'frontend/src/features/blog/BlogPost.tsx',
      'frontend/src/features/care/CareGuidePage.tsx',
      'frontend/src/features/care/CareIndex.tsx',
      'frontend/src/features/household/JoinHouseholdPage.tsx',
      'frontend/src/features/landing/LandingPage.tsx',
      'frontend/src/features/petsafe/PetSafePage.tsx',
      'frontend/src/features/plants/SharedPlantPage.tsx',
      'frontend/src/features/pricing/PricingPage.tsx',
    ];

    for (const relativePath of acquisitionSurfaces) {
      const source = readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
      expect(source, `${relativePath} must use the registration kill switch`).toContain(
        'PUBLIC_REGISTRATION_AVAILABLE'
      );
    }
  });

  it('names only the reminder channels production can deliver', () => {
    // #607. SMS is built and fail-closed: production leaves
    // `sms_notifications_enabled` empty, so `smsAvailable()` in
    // backend/src/handlers/notifications/handler.ts is false for every real
    // user — the toggle renders disabled, phone verification is hidden, and a
    // request that enables it anyway is rejected. The landing page sold
    // "Browser, email, or text" regardless, which a visitor could only
    // discover was untrue after signing up. A channel may be marketed once
    // the flag that delivers it is on, and this reads that flag rather than
    // trusting the copy.
    const repositoryRoot = resolve(process.cwd(), '..');
    const productionVars = readFileSync(
      resolve(repositoryRoot, 'infrastructure/environments/production/terraform.tfvars'),
      'utf8'
    );
    const smsDelivers = /^\s*sms_notifications_enabled\s*=\s*"1"/m.test(productionVars);

    // Comment lines are stripped: the source explains why SMS is absent, and
    // that explanation must not read as the claim it is there to prevent.
    const landingCopy = readFileSync(
      resolve(repositoryRoot, 'frontend/src/features/landing/LandingPage.tsx'),
      'utf8'
    ).replace(/^\s*\/\/.*$/gm, '');

    expect(
      smsDelivers || !/\bSMS\b|\bor text\b|\btext message/i.test(landingCopy),
      'LandingPage.tsx offers a text/SMS reminder channel that production does not deliver'
    ).toBe(true);
  });

  it('advertises free registration in crawler and PWA metadata', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    for (const relativePath of ['frontend/index.html', 'frontend/vite.config.ts']) {
      const source = readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
      expect(source, `${relativePath} needs free-account copy`).toMatch(/free accounts?/i);
      expect(source, `${relativePath} must not claim registration is paused`).not.toMatch(
        /registration[^.]{0,40}paused/i
      );
    }
  });

  it('states the authoritative free tier limits on acquisition and help surfaces', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    for (const relativePath of [
      // The help answers live in helpContent.tsx; HelpPage.tsx is now only the
      // browse/filter shell around them.
      'frontend/src/features/help/helpContent.tsx',
      'frontend/src/features/landing/LandingPage.tsx',
      'frontend/src/features/pricing/PricingPage.tsx',
      'frontend/src/i18n/locales/en/translation.json',
    ]) {
      const source = readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
      // The free tier is "a couple and their plants" (ADR 0014): one home,
      // three hands, twenty plants. Every acquisition surface says so.
      expect(source, `${relativePath} must state the 20-plant cap`).toMatch(/20 plants/i);
      expect(source, `${relativePath} must state the 3-member cap`).toMatch(
        /3 (?:household )?members|3 people/i
      );
      expect(source, `${relativePath} must state the one-home cap`).toMatch(/one home/i);
    }
  });

  it('keeps the English status copy identical to, and consistent with, repository status', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    const status = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'commercial-status.json'), 'utf8')
    ) as {
      publicMessage: string;
      publicRegistrationAvailable: boolean;
      commercialHoldActive: boolean;
    };
    const english = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'frontend/src/i18n/locales/en/translation.json'), 'utf8')
    ) as { commercialHold: { message: string; headline: string; unavailableMessage: string } };

    expect(status.publicRegistrationAvailable).toBe(true);
    // The repository's public statement and the copy the app renders for it
    // must never drift apart.
    expect(english.commercialHold.message).toBe(status.publicMessage);

    if (status.commercialHoldActive) {
      // Guards a specific way this pairing can go wrong: re-activating the
      // hold without rewriting publicMessage would pair the "paid plans are
      // paused" headline with a message saying they are available. Worse than
      // showing no notice at all.
      expect(status.publicMessage).toMatch(/unavailable|paused|remain|not currently/i);
    } else {
      // With no hold in force, the fallback notice carries its own copy and
      // must not cite a hold that no longer exists.
      expect(english.commercialHold.unavailableMessage).toBeTruthy();
      // Word-bounded: an unbounded /hold/ also matches "household", which
      // legitimately appears in this copy.
      expect(english.commercialHold.unavailableMessage).not.toMatch(/\b(?:hold|paused)\b/i);
    }
  });

  it('describes retained paid-plan entitlements without promising them to free accounts', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    const apiKeys = readFileSync(
      resolve(repositoryRoot, 'frontend/src/features/settings/ApiKeysSettings.tsx'),
      'utf8'
    );
    // The pricing copy now lives in the translation catalogs rather than in
    // JSX, so the claim is checked where it is actually authored. Both locales
    // are checked: a mistranslation that promised paid entitlements to free
    // accounts would be just as wrong in Spanish.
    const pricingCopy = ['en', 'es'].map((locale) =>
      readFileSync(
        resolve(repositoryRoot, `frontend/src/i18n/locales/${locale}/translation.json`),
        'utf8'
      )
    );

    expect(apiKeys).toMatch(/existing API-key entitlement/i);
    expect(apiKeys).not.toMatch(/free-account entitlement/i);
    expect(pricingCopy[0]).toMatch(/current plan limits/i);
    for (const copy of pricingCopy) {
      expect(copy).not.toMatch(/current free-account limits/i);
      expect(copy).not.toMatch(/l[íi]mites de la cuenta gratuita actual/i);
    }
  });
});

describe('landing plans band tracks BOTH commercial gates', () => {
  /**
   * Regression guard. The band used to branch on the registration kill switch
   * alone, so when the commercial hold lifted it kept telling every visitor
   * "paid plans are paused" directly above a PricingGrid that was rendering
   * real, purchasable amounts. A pause announcement over a selling catalog
   * costs a sale on the highest-traffic surface there is, and it is a lie in
   * whichever direction the reader believes it.
   */
  // Deliberately narrow: it targets a pause claim about *paid* activity, not
  // the word "paused" anywhere. Registration and paid plans are independent
  // gates, and "new account registration is paused" is the correct thing to
  // say in the hold-lifted / registration-closed state.
  const PAID_PAUSE_LANGUAGE =
    /(?:paid plans?|purchases?|plan changes)[^.]{0,60}(?:paused|unavailable)/i;

  it('announces the pause only while the hold is actually active', () => {
    for (const registrationOpen of [true, false]) {
      const held = planBandFor(true, registrationOpen);
      expect(
        `${held.title} ${held.description}`,
        `hold active / registration ${registrationOpen} must state the pause`
      ).toMatch(PAID_PAUSE_LANGUAGE);
    }
  });

  it('never claims paid plans are paused once the hold is lifted', () => {
    for (const registrationOpen of [true, false]) {
      const open = planBandFor(false, registrationOpen);
      expect(
        `${open.title} ${open.description} ${open.footerNote} ${open.footerLink}`,
        `hold lifted / registration ${registrationOpen} must not announce a pause`
      ).not.toMatch(PAID_PAUSE_LANGUAGE);
    }
  });

  it('publishes no amount in band copy — prices belong to the API-backed grid', () => {
    for (const holdActive of [true, false]) {
      for (const registrationOpen of [true, false]) {
        const band = planBandFor(holdActive, registrationOpen);
        expect(Object.values(band).join(' ')).not.toMatch(/\$\s*\d/);
      }
    }
  });
});
