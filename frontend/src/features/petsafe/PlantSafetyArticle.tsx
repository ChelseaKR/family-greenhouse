import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { buttonStyles } from '@/components/buttonStyles';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { hasCareGuide } from '@/features/care/careGuideSlugs';
import { PlantShopLink } from '@/features/plantShop/PlantShopLink';
import { offersShopLink } from '@/features/plantShop/plantShop';
import {
  ANIMALS,
  ASPCA_PLANT_LIST_URL,
  POISON_HOTLINES,
  VERDICT_LABEL_KEY,
  citedSources,
  headName,
  plantSafetyDetails,
  plantSafetyFaq,
  type AnimalClaim,
  type AnyAnimal,
  type CitedSource,
  type PlantSafetyDetails,
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
  const details = plantSafetyDetails(page);
  const faq = plantSafetyFaq(page, details, t);

  return (
    <article data-plant-safety={page.slug}>
      <EmergencyAside />

      <Link
        to="/pet-safe"
        data-chrome="plantSafetyPage.checkAnother"
        className="mt-8 inline-block text-sm font-medium text-primary-700 hover:underline"
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
          {t('plantSafetyPage.heading', { questionName: headName(page.commonName) })}
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
          {details && details.horses.state !== 'not-assessed' && (
            <VerdictRow animal="horses" claim={details.horses} />
          )}
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

      {details && <ListingDetails page={page} details={details} />}

      {details?.extension && <ExtensionDetailsSection details={details} />}

      {hasCareGuide(page.slug) && (
        <p className="mt-8">
          <Link
            to={`/care/${page.slug}`}
            data-chrome="plantSafetyPage.careGuideLink"
            className={LINK}
          >
            {t('plantSafetyPage.careGuideLink', { name: page.commonName })}
          </Link>
        </p>
      )}

      {details && details.alternatives.length > 0 && (
        <LinkedPlants
          id="plant-safety-alternatives"
          headingKey={
            details.anyToxic
              ? 'plantSafetyPage.alternativesHeading.toxic'
              : 'plantSafetyPage.alternativesHeading.other'
          }
          introKey="plantSafetyPage.alternativesIntro"
          pages={details.alternatives}
        />
      )}

      {details && details.related.length > 0 && (
        <LinkedPlants
          id="plant-safety-related"
          headingKey="plantSafetyPage.relatedHeading"
          introKey="plantSafetyPage.relatedIntro"
          pages={details.related}
        />
      )}

      {faq.length > 0 && (
        <section aria-labelledby="plant-safety-faq" className="mt-10">
          <h2
            id="plant-safety-faq"
            data-chrome="plantSafetyPage.faqHeading"
            className="font-serif text-2xl tracking-tight text-ink"
          >
            {t('plantSafetyPage.faqHeading')}
          </h2>
          <dl className="mt-4 space-y-5">
            {faq.map((item) => (
              <div key={item.id}>
                <dt data-claim="faq-question" data-faq={item.id} className="font-medium text-ink">
                  {item.question}
                </dt>
                <dd data-claim="faq-answer" data-faq={item.id} className="mt-1 text-gray-800">
                  {item.answer}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

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

      {/* Optional paid link to a shop (ADR 0038), only on a page whose every
          verdict is a cited "non-toxic": a page telling a reader a plant is
          toxic to their pet never also offers to sell it to them. */}
      {offersShopLink(Object.values(page.claims)) && <PlantShopLink slug={page.slug} />}

      {PUBLIC_REGISTRATION_AVAILABLE && (
        <section className="mt-12 rounded-xl border border-primary-200 bg-primary-50 p-6 text-center">
          <h2 data-chrome="plantSafetyPage.signupTitle" className="font-serif text-xl text-ink">
            {t('plantSafetyPage.signupTitle', { name: page.commonName })}
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

/**
 * What to do if the pet may already have eaten some, first on every page:
 * toxic, non-toxic and "Not assessed" alike, since a listing says nothing about
 * how much was eaten. Two hotlines, each a `tel:` link whose visible text is
 * the number, then its fee in its own words. This block is unmonetized: no
 * affiliate, sponsored or paid link may ever sit in it (the build gate fails on
 * one); any such link belongs below it, after the verdicts.
 */
export function EmergencyAside() {
  const { t } = useTranslation();

  return (
    <aside
      aria-labelledby="plant-safety-emergency"
      data-plant-emergency=""
      className="rounded-xl border border-primary-200 bg-primary-50/60 p-5"
    >
      <h2
        id="plant-safety-emergency"
        data-chrome="plantSafetyPage.emergencyHeading"
        className="font-serif text-lg text-ink"
      >
        {t('plantSafetyPage.emergencyHeading')}
      </h2>
      <p data-chrome="plantSafetyPage.emergencyBody" className="mt-2 text-sm text-gray-700">
        {t('plantSafetyPage.emergencyBody')}
      </p>
      <ul className="mt-3 space-y-2 text-sm text-gray-700">
        {POISON_HOTLINES.map((hotline) => (
          <li key={hotline.id} data-hotline={hotline.id}>
            <a href={hotline.tel} data-chrome={hotline.callKey} className={`${LINK} font-medium`}>
              {t(hotline.callKey)}
            </a>{' '}
            <span data-chrome={hotline.feeKey}>{t(hotline.feeKey)}</span>
          </li>
        ))}
      </ul>
      <p data-chrome="plantSafetyPage.hotlinesChecked" className="mt-3 text-sm text-gray-600">
        {t('plantSafetyPage.hotlinesChecked')}
      </p>
      <p data-chrome="plantSafetyPage.emergencyListingNote" className="mt-2 text-sm text-gray-700">
        {t('plantSafetyPage.emergencyListingNote')}
      </p>
    </aside>
  );
}

/**
 * The plant's own ASPCA listing, quoted: its toxic principles, clinical signs
 * and any further line, each verbatim from the table, then the list-wide line
 * the ASPCA prints for every plant, each beside its source.
 */
function ListingDetails({ page, details }: { page: PlantSafetyPage; details: PlantSafetyDetails }) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="plant-safety-listing" className="mt-10">
      <h2
        id="plant-safety-listing"
        data-chrome="plantSafetyPage.listingHeading"
        className="font-serif text-xl tracking-tight text-ink"
      >
        {t('plantSafetyPage.listingHeading')}
      </h2>
      {details.listing.length > 0 && (
        <>
          <p data-chrome="plantSafetyPage.listingIntro" className="mt-2 text-sm text-gray-600">
            {t('plantSafetyPage.listingIntro')}
          </p>
          <dl className="mt-3 space-y-3">
            {details.listing.map(({ field, value }) => (
              <div key={field}>
                <dt
                  data-chrome={`plantSafetyPage.listingField.${field}`}
                  className="text-xs font-medium uppercase tracking-wide text-primary-800"
                >
                  {t(`plantSafetyPage.listingField.${field}`)}
                </dt>
                <dd data-claim="listing-field" data-listing-field={field} className="text-gray-800">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <SourceLine sources={citedSources(page)} />
        </>
      )}
      <p className="mt-4 text-sm text-gray-700">
        <span data-chrome="plantSafetyPage.listCaveat">{t('plantSafetyPage.listCaveat')}</span>{' '}
        <a
          href={ASPCA_PLANT_LIST_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-claim="list-citation"
          className={LINK}
        >
          {t('plantSafetyPage.listCitation')}
        </a>
      </p>
    </section>
  );
}

/**
 * A university extension's page for the same plant, quoted, as a second
 * source. Its "non-toxic" tags appear only where the ASPCA verdict above
 * already says the same (see plantSafetyDetailsFrom).
 */
function ExtensionDetailsSection({ details }: { details: PlantSafetyDetails }) {
  const { t } = useTranslation();
  const ext = details.extension!;

  return (
    <section aria-labelledby="plant-safety-extension" className="mt-10">
      <h2
        id="plant-safety-extension"
        data-chrome="plantSafetyPage.extensionHeading"
        className="font-serif text-xl tracking-tight text-ink"
      >
        {t('plantSafetyPage.extensionHeading')}
      </h2>
      <p data-chrome="plantSafetyPage.extensionIntro" className="mt-2 text-sm text-gray-600">
        {t('plantSafetyPage.extensionIntro')}
      </p>
      {ext.fields.length > 0 && (
        <>
          <dl className="mt-3 space-y-3">
            {ext.fields.map(({ field, value }) => (
              <div key={field}>
                <dt
                  data-chrome={`plantSafetyPage.extensionField.${field}`}
                  className="text-xs font-medium uppercase tracking-wide text-primary-800"
                >
                  {t(`plantSafetyPage.extensionField.${field}`)}
                </dt>
                <dd
                  data-claim="extension-field"
                  data-extension-field={field}
                  className="text-gray-800"
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p data-chrome="plantSafetyPage.extensionCaveat" className="mt-3 text-sm text-gray-700">
            {t('plantSafetyPage.extensionCaveat')}
          </p>
        </>
      )}
      {ext.tags.length > 0 && (
        <>
          <p
            data-chrome="plantSafetyPage.extensionTagsLabel"
            className="mt-3 text-sm text-gray-700"
          >
            {t('plantSafetyPage.extensionTagsLabel')}
          </p>
          <ul className="mt-2 space-y-1 text-sm text-gray-800">
            {ext.tags.map((animal) => (
              <li key={animal}>
                <span data-chrome={`plantSafetyPage.linkedAnimal.${animal}`}>
                  {t(`plantSafetyPage.linkedAnimal.${animal}`)}
                </span>{' '}
                <span data-claim="extension-tag" data-animal={animal} data-state="non-toxic">
                  {t(VERDICT_LABEL_KEY['non-toxic'])}
                </span>
              </li>
            ))}
          </ul>
          <p data-chrome="plantSafetyPage.extensionTagsNote" className="mt-2 text-sm text-gray-600">
            {t('plantSafetyPage.extensionTagsNote')}
          </p>
        </>
      )}
      <p className="mt-2 text-sm text-gray-700">
        <span data-chrome="plantSafetyPage.sourceLabel">{t('plantSafetyPage.sourceLabel')}</span>{' '}
        <a
          href={ext.url}
          target="_blank"
          rel="noopener noreferrer"
          data-claim="extension-citation"
          className={LINK}
        >
          {t('plantSafetyPage.extensionCitation', {
            publisher: ext.publisher,
            title: ext.title,
            database: ext.database,
          })}
        </a>
      </p>
    </section>
  );
}

/**
 * Other plant pages, each named by its own table entry and shown with that
 * page's own cited cat and dog verdicts, so a link never vouches for a plant
 * on this page's authority.
 */
function LinkedPlants({
  id,
  headingKey,
  introKey,
  pages,
}: {
  id: string;
  headingKey: string;
  introKey: string;
  pages: PlantSafetyPage[];
}) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} data-chrome={headingKey} className="font-serif text-xl tracking-tight text-ink">
        {t(headingKey)}
      </h2>
      <p data-chrome={introKey} className="mt-2 text-sm text-gray-600">
        {t(introKey)}
      </p>
      <ul className="mt-3 space-y-2">
        {pages.map((target) => (
          <li key={target.slug} data-linked-plant={target.slug} className="text-gray-800">
            <Link
              to={`/pet-safe/${target.slug}`}
              data-claim="linked-plant"
              data-target={target.slug}
              className={`${LINK} font-medium`}
            >
              {target.commonName}
            </Link>{' '}
            {ANIMALS.map((animal) => (
              <span key={animal} className="ml-2 text-sm">
                {' '}
                <span data-chrome={`plantSafetyPage.linkedAnimal.${animal}`}>
                  {t(`plantSafetyPage.linkedAnimal.${animal}`)}
                </span>{' '}
                <span
                  data-claim="linked-verdict"
                  data-target={target.slug}
                  data-animal={animal}
                  data-state={target.claims[animal].state}
                >
                  {t(VERDICT_LABEL_KEY[target.claims[animal].state])}
                </span>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

function VerdictRow({ animal, claim }: { animal: AnyAnimal; claim: AnimalClaim }) {
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
