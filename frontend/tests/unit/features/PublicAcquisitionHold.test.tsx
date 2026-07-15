import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicShell } from '@/components/PublicShell';

describe('public acquisition hold', () => {
  it('keeps the shared public shell linked to existing-account sign-in', () => {
    render(
      <MemoryRouter>
        <PublicShell>Public content</PublicShell>
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('link', { name: /try the app/i })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/register"]')).toBeNull();
  });

  it('keeps every public acquisition surface and social source free of signup controls', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    const relativePaths = [
      'frontend/src/features/auth/LoginPage.tsx',
      'frontend/src/features/auth/ConfirmEmailPage.tsx',
      'frontend/src/features/auth/RegisterPage.tsx',
      'frontend/src/features/landing/LandingPage.tsx',
      'frontend/src/features/blog/BlogPost.tsx',
      'frontend/src/features/blog/posts/remembering-to-water.tsx',
      'frontend/src/features/blog/posts/sharing-plant-care.tsx',
      'frontend/src/features/care/CareIndex.tsx',
      'frontend/src/features/care/CareGuidePage.tsx',
      'frontend/src/features/petsafe/PetSafePage.tsx',
      'frontend/src/features/household/JoinHouseholdPage.tsx',
      'frontend/src/features/plants/SharedPlantPage.tsx',
      'frontend/index.html',
      'frontend/vite.config.ts',
      'frontend/scripts/brand-assets/og-image.svg',
    ];
    const forbidden = [
      /(?:to|href)=[{]?['"`]\/register/,
      /navigate\(['"`]\/register/,
      /sign up free/i,
      /get started(?: free)?/i,
      /free for up to 10 plants/i,
      /no (?:credit )?card/i,
    ];

    for (const relativePath of relativePaths) {
      const source = readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${relativePath} contains ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('keeps static crawler and PWA metadata explicit about the hold', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    for (const relativePath of ['frontend/index.html', 'frontend/vite.config.ts']) {
      const source = readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
      expect(source, `${relativePath} needs technical-demonstration disclosure`).toMatch(
        /technical demonstration/i
      );
      expect(source, `${relativePath} needs registration-hold disclosure`).toMatch(
        /new (?:account )?registrations?/i
      );
      expect(source, `${relativePath} needs paused status`).toMatch(/paused/i);
    }
  });

  it('keeps the English notice identical to the repository status decision', () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    const status = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'commercial-status.json'), 'utf8')
    ) as { publicMessage: string };
    const english = JSON.parse(
      readFileSync(resolve(repositoryRoot, 'frontend/src/i18n/locales/en/translation.json'), 'utf8')
    ) as { commercialHold: { message: string } };

    expect(english.commercialHold.message).toBe(status.publicMessage);
  });
});
