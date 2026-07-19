import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicShell } from '@/components/PublicShell';

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
      'frontend/src/features/help/HelpPage.tsx',
      'frontend/src/features/landing/LandingPage.tsx',
      'frontend/src/features/pricing/PricingPage.tsx',
      'frontend/src/i18n/locales/en/translation.json',
    ]) {
      const source = readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
      expect(source, `${relativePath} must state the 10-plant cap`).toMatch(/10 plants/i);
      expect(source, `${relativePath} must state the 6-member cap`).toMatch(
        /6 (?:household )?members|6 people/i
      );
    }
  });

  it('keeps the English paid-hold notice identical to repository status', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    const status = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'commercial-status.json'), 'utf8')
    ) as { publicMessage: string; publicRegistrationAvailable: boolean };
    const english = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'frontend/src/i18n/locales/en/translation.json'), 'utf8')
    ) as { commercialHold: { message: string } };

    expect(status.publicRegistrationAvailable).toBe(true);
    expect(english.commercialHold.message).toBe(status.publicMessage);
  });

  it('describes retained paid-plan entitlements without promising them to free accounts', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    const apiKeys = readFileSync(
      resolve(repositoryRoot, 'frontend/src/features/settings/ApiKeysSettings.tsx'),
      'utf8'
    );
    const pricing = readFileSync(
      resolve(repositoryRoot, 'frontend/src/features/pricing/PricingPage.tsx'),
      'utf8'
    );

    expect(apiKeys).toMatch(/existing API-key entitlement/i);
    expect(apiKeys).not.toMatch(/free-account entitlement/i);
    expect(pricing).toMatch(/current plan limits/i);
    expect(pricing).not.toMatch(/current free-account limits/i);
  });
});
