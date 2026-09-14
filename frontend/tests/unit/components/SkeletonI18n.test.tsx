import { render, screen } from '@testing-library/react';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import es from '@/i18n/locales/es/translation.json';
import { ListSkeleton, PlantGridSkeleton } from '@/components/Skeleton';

/**
 * The content-shaped skeletons are `role="status"` regions: their accessible
 * name and their visually-hidden text are what a screen reader says while a
 * list or the plant grid loads. Both were English literals in every locale.
 */

let spanish: I18nInstance;

beforeAll(async () => {
  spanish = createInstance();
  await spanish.init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: es } },
    interpolation: { escapeValue: false },
  });
});

describe('loading skeletons under es', () => {
  it('names the list skeleton from the catalog', () => {
    render(
      <I18nextProvider i18n={spanish}>
        <ListSkeleton rows={2} />
      </I18nextProvider>
    );
    expect(screen.getByRole('status', { name: 'Cargando…' })).toHaveTextContent('Cargando…');
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('names the plant grid skeleton from the catalog', () => {
    render(
      <I18nextProvider i18n={spanish}>
        <PlantGridSkeleton count={2} />
      </I18nextProvider>
    );
    expect(screen.getByRole('status', { name: 'Cargando plantas…' })).toHaveTextContent(
      'Cargando plantas…'
    );
    expect(screen.queryByText('Loading plants…')).not.toBeInTheDocument();
  });
});
