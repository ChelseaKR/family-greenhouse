import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { buttonStyles } from '@/components/buttonStyles';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import {
  ANIMALS,
  POISON_CONTROL_URL,
  VERDICT_LABEL_KEY,
  citedSources,
  type Animal,
  type AnimalClaim,
  type CitedSource,
  type PlantSafetyPage,
} from './plantSafetyPages';

/**
 * The body of a published `/pet-safe/<slug>` page. Every visible string sits in
 * an element marked with its source (`data-claim`, `data-field`, `data-chrome`);
 * PetSafePlantPage.tsx explains why, and scripts/check-plant-safety-pages.mjs
 * enforces it over the prerendered HTML.
 */
const LINK = 'text-primary-700 underline hover:text-primary-800';

export function PlantSafetyArticle({ page }: { page: PlantSafetyPage }) {
  const { t } = useTranslation();

  return (
    <article data-plant-safety={page.slug}>
      <Link
        to="/pet-safe"
        data-chrome="plantSafetyPage.checkAnother"
        className="text-sm font-medium text-primary-700 hover:underline"
      >
        {t('plantSafetyPage.checkAnother')}
      </Link>

      <header className="mt-6">
        <p
          data-chrome="plantSafetyPage.eyebrow"
          className="text-xs font-semibold uppercase tracking-[0.2em] text-primary-700"
        >
          {t('plantSafetyPage.eyebrow')}
        </p>
        <h1
          data-chrome="plantSafetyPage.heading"
          className="mt-3 font-serif text-4xl tracking-tight text-ink sm:text-5xl"
        >
          {t('plantSafetyPage.heading', { name: page.commonName })}
        </h1>
        <p data-field="scientificName" className="mt-2 text-lg italic text-gray-600">
          {page.scientificName}
        </p>
      </header>

      <section aria-labelledby="plant-safety-verdicts" className="mt-8">
        <h2
          id="plant-safety-verdicts"
          data-chrome="plantSafetyPage.verdictsHeading"
          className="font-serif text-2xl tracking-tight text-ink"
        >
          {t('plantSafetyPage.verdictsHeading')}
        </h2>
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {ANIMALS.map((animal) => (
            <VerdictRow key={animal} animal={animal} claim={page.claims[animal]} />
          ))}
        </dl>
      </section>

      {page.note !== null && (
        <section aria-labelledby="plant-safety-note" className="mt-10">
          <h2
            id="plant-safety-note"
            data-chrome="plantSafetyPage.noteHeading"
            className="font-serif text-xl tracking-tight text-ink"
          >
            {t('plantSafetyPage.noteHeading')}
          </h2>
          <p data-claim="note" className="mt-3 text-gray-800">
            {page.note}
          </p>
          <SourceLine sources={citedSources(page)} />
        </section>
      )}

      <aside
        aria-labelledby="plant-safety-emergency"
        className="mt-10 rounded-xl border border-primary-200 bg-primary-50/60 p-5"
      >
        <h2
          id="plant-safety-emergency"
          data-chrome="plantSafetyPage.emergencyHeading"
          className="font-serif text-lg text-ink"
        >
          {t('plantSafetyPage.emergencyHeading')}
        </h2>
        <p className="mt-2 text-sm text-gray-700">
          <span data-chrome="plantSafetyPage.emergencyBody">
            {t('plantSafetyPage.emergencyBody')}
          </span>{' '}
          <a
            href={POISON_CONTROL_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-chrome="plantSafetyPage.poisonControlLink"
            className={LINK}
          >
            {t('plantSafetyPage.poisonControlLink')}
          </a>
        </p>
      </aside>

      <section aria-labelledby="plant-safety-about" className="mt-10">
        <h2
          id="plant-safety-about"
          data-chrome="plantSafetyPage.aboutHeading"
          className="font-serif text-lg text-ink"
        >
          {t('plantSafetyPage.aboutHeading')}
        </h2>
        <p data-chrome="plantSafetyPage.aboutBody" className="mt-2 text-sm text-gray-700">
          {t('plantSafetyPage.aboutBody')}
        </p>
      </section>

      {PUBLIC_REGISTRATION_AVAILABLE && (
        <section className="mt-12 rounded-xl border border-primary-200 bg-primary-50 p-6 text-center">
          <h2 data-chrome="plantSafetyPage.signupTitle" className="font-serif text-xl text-ink">
            {t('plantSafetyPage.signupTitle')}
          </h2>
          <p data-chrome="plantSafetyPage.signupBody" className="mt-2 text-sm text-gray-600">
            {t('plantSafetyPage.signupBody')}
          </p>
          <div className="mt-4">
            <Link to="/register" data-chrome="plantSafetyPage.signupCta" className={buttonStyles()}>
              {t('plantSafetyPage.signupCta')}
            </Link>
          </div>
        </section>
      )}
    </article>
  );
}

function VerdictRow({ animal, claim }: { animal: Animal; claim: AnimalClaim }) {
  const { t } = useTranslation();

  return (
    <div
      data-claim-group={animal}
      className="rounded-xl border border-primary-100/80 bg-white p-4 shadow-journal"
    >
      <dt
        data-chrome={`plantSafetyPage.animal.${animal}`}
        className="text-xs font-medium uppercase tracking-wide text-primary-800"
      >
        {t(`plantSafetyPage.animal.${animal}`)}
      </dt>
      <dd className="mt-1">
        <p
          data-claim="verdict"
          data-animal={animal}
          data-state={claim.state}
          className="font-serif text-2xl text-ink"
        >
          {t(VERDICT_LABEL_KEY[claim.state])}
        </p>
        {claim.state === 'not-assessed' ? (
          <p
            data-chrome={`plantSafetyPage.notAssessed.${animal}`}
            className="mt-2 text-sm text-gray-700"
          >
            {t(`plantSafetyPage.notAssessed.${animal}`)}
          </p>
        ) : (
          <SourceLine sources={[claim.source]} />
        )}
      </dd>
    </div>
  );
}

/** "Source: <listing>" — the citation, next to the claim it supports. */
function SourceLine({ sources }: { sources: CitedSource[] }) {
  const { t } = useTranslation();

  return (
    <p className="mt-2 text-sm text-gray-700">
      <span data-chrome="plantSafetyPage.sourceLabel">{t('plantSafetyPage.sourceLabel')}</span>{' '}
      {sources.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          data-claim="citation"
          className={LINK}
        >
          {t('plantSafetyPage.citation', {
            title: source.title,
            scientificName: source.scientificName,
          })}
        </a>
      ))}
    </p>
  );
}
