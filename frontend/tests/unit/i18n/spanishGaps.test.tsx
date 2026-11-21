import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import i18n from '@/i18n';
import { ensureLocaleCatalog } from '@/i18n/nonEnglishCatalog';
import { Button } from '@/components/Button';
import { Toaster } from '@/components/Toaster';
import { AuthShell } from '@/features/auth/AuthShell';
import { NoCareDataNotice } from '@/features/plants/NoCareDataNotice';
import { toast, useToastStore } from '@/store/toastStore';

/**
 * Shared pieces that were English on every Spanish screen until 2026-11,
 * because their text sat in the component and not in the catalog: the word
 * on a loading button, the toast region and its dismiss button, the sign-in
 * shell's home link. The ratchet (scripts/check-hardcoded-strings.mjs) keeps
 * new literals out; this pins that the ones it found are actually rendered in
 * Spanish, with the shipped catalog.
 */
describe('shared components in Spanish', () => {
  beforeAll(async () => {
    await ensureLocaleCatalog(i18n, 'es');
    await i18n.changeLanguage('es');
  });
  afterAll(async () => {
    useToastStore.setState({ toasts: [] });
    await i18n.changeLanguage('en');
  });

  it('a loading button says so in Spanish', () => {
    render(<Button isLoading>Guardar</Button>);
    expect(screen.getByRole('button')).toHaveTextContent('Cargando…');
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('the toast region and its dismiss button are named in Spanish', () => {
    render(<Toaster />);
    act(() => {
      toast.success('Hecho');
    });
    expect(screen.getByRole('region', { name: 'Notificaciones' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Descartar notificación' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).not.toBeInTheDocument();
  });

  it('the sign-in shell names its home link and tagline in Spanish', () => {
    render(
      <MemoryRouter>
        <AuthShell title="Restablece tu contraseña">
          <p>…</p>
        </AuthShell>
      </MemoryRouter>
    );
    expect(
      screen.getByRole('link', { name: 'Family Greenhouse, Crecer juntos, inicio' })
    ).toBeInTheDocument();
    expect(screen.queryByText('Grow together')).not.toBeInTheDocument();
  });

  it('a notice with no translation function of its own is in Spanish too', () => {
    render(<NoCareDataNotice />);
    expect(
      screen.getByRole('heading', { name: 'Aún no hay guía de cuidado para esta especie' })
    ).toBeInTheDocument();
  });
});

/**
 * Three wording decisions from the 2026-11-17 review of the Spanish, pinned so
 * a later edit does not quietly undo them.
 */
describe('reviewed Spanish wording', () => {
  afterAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('greets an account that has no name without a stand-in name', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t('dashboard.welcomeBackNoName')).toBe('Welcome back, friend');
    await ensureLocaleCatalog(i18n, 'es');
    await i18n.changeLanguage('es');
    expect(i18n.t('dashboard.welcomeBackNoName')).toBe('Hola de nuevo');
    expect(i18n.t('dashboard.welcomeBack', { name: 'Ana' })).toBe('Hola de nuevo, Ana');
  });

  it('says a key is generated, and puts the example plant in la sala', async () => {
    const catalog = JSON.stringify((await import('@/i18n/locales/es/translation.json')).default);
    expect(catalog).toContain('Generar clave');
    expect(catalog).toContain('Generada el {{date}}');
    expect(catalog).toContain('Monstera de la sala');
    for (const retired of ['Emitir clave', 'Emitida el', 'Emite claves', 'amigo/a', 'del salón']) {
      expect(catalog).not.toContain(retired);
    }
  });
});
