import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandMark } from '@/components/BrandMark';
import { Footer } from '@/components/Footer';
import { Alert } from '@/components/Alert';
import { Input } from '@/components/Input';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
import { useDebounce } from '@/hooks/useDebounce';
import { petToxicityService, type ToxicityMatch } from '@/services/petToxicityService';

/**
 * Free, no-signup "Is this plant safe for pets?" checker. A top-of-funnel
 * marketing page (public, no auth — like /care and /blog) that answers
 * high-intent "is X toxic to cats/dogs" searches and gently funnels visitors
 * into the app.
 *
 * Toxicity comes from the public, cache-friendly GET /species/toxicity
 * endpoint, which resolves a hand-curated, ASPCA-grounded table server-side.
 * No PII, no auth, read-only.
 */
export function PetSafePage() {
  useMetaTags({
    title: 'Is This Plant Safe for Pets? — Cat & Dog Toxicity Checker',
    description:
      'Free, no-signup checker: type a houseplant name and see whether it’s toxic to cats and dogs, in plain language. Based on the ASPCA’s plant safety data.',
    canonical: siteUrl('/pet-safe'),
  });

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query.trim(), 300);
  const [results, setResults] = useState<ToxicityMatch[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  // Remember the query the current results belong to, so the "no matches"
  // message only shows once a real lookup has settled (not mid-type).
  const [resolvedQuery, setResolvedQuery] = useState('');

  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setResults([]);
      setStatus('idle');
      setResolvedQuery('');
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    petToxicityService
      .lookup(debouncedQuery, controller.signal)
      .then((matches) => {
        setResults(matches);
        setResolvedQuery(debouncedQuery);
        setStatus('done');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus('error');
      });
    return () => controller.abort();
  }, [debouncedQuery]);

  const showEmpty = status === 'done' && results.length === 0 && resolvedQuery.length >= 2;

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-gray-200">
        <nav className="mx-auto max-w-3xl flex items-center justify-between p-6">
          <Link to="/" aria-label="Family Greenhouse home">
            <BrandMark variant="wordmark" size="sm" />
          </Link>
          <Link to="/" className="text-sm font-medium text-primary-700 hover:underline">
            Try the app →
          </Link>
        </nav>
      </header>

      <main className="flex-1 mx-auto max-w-3xl w-full px-6 py-16">
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
          Is this plant safe for pets?
        </h1>
        <p className="mt-3 text-lg text-gray-600">
          Type a houseplant name and we’ll tell you, plainly, whether it’s toxic to cats and dogs.
          No sign-up, no fuss. Based on the{' '}
          <a
            href="https://www.aspca.org/pet-care/animal-poison-control/toxic-and-non-toxic-plants"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-700 underline hover:text-primary-800"
          >
            ASPCA’s plant safety data
          </a>
          .
        </p>

        <form
          className="mt-10"
          role="search"
          aria-label="Search plant pet-toxicity"
          onSubmit={(e) => e.preventDefault()}
        >
          <Input
            type="search"
            label="Plant or species name"
            placeholder="e.g. snake plant, pothos, lily…"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            helperText="Try a common name or a scientific name."
          />
        </form>

        {/* Live region so screen readers hear the result as it loads. */}
        <div className="mt-8 space-y-4" aria-live="polite" aria-busy={status === 'loading'}>
          {status === 'error' && (
            <Alert variant="error" title="Something went wrong">
              We couldn’t check that just now. Give it another moment and try again.
            </Alert>
          )}

          {results.map((match) => (
            <ToxicityCard key={match.slug} match={match} />
          ))}

          {showEmpty && (
            <Alert variant="info" title="No match yet">
              We don’t have that one in our checker yet. Double-check the spelling, or try the
              plant’s common name. When in doubt, assume it’s unsafe and keep it out of reach until
              you can confirm with your vet or the ASPCA.
            </Alert>
          )}
        </div>

        {/* General, always-visible caveat for kids and pets. */}
        <aside className="mt-12 rounded-lg border border-primary-200 bg-primary-50/60 p-5">
          <h2 className="font-serif text-lg font-semibold text-gray-900">
            A note on kids and pets
          </h2>
          <p className="mt-2 text-sm text-gray-700">
            Even “non-toxic” plants can cause a mild upset stomach if a curious pet or toddler eats
            a big mouthful — non-toxic means not poisonous, not that it’s food. With anything truly
            toxic, the safest move is height: put it where paws and little hands can’t reach. If you
            think a pet has eaten something harmful, call your vet or the{' '}
            <a
              href="https://www.aspca.org/pet-care/animal-poison-control"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-700 underline hover:text-primary-800"
            >
              ASPCA Animal Poison Control
            </a>{' '}
            line right away.
          </p>
        </aside>

        <section className="mt-16 rounded-lg border border-primary-200 bg-primary-50 p-6 text-center">
          <h2 className="font-serif text-xl font-semibold text-gray-900">
            Keeping a pet-safe home is easier when everyone’s on the same page
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Family Greenhouse keeps your plants, their care, and who’s looking after what in one
            shared place — so the whole household knows which plants to keep out of reach. Free to
            start, no card needed.
          </p>
          <div className="mt-4">
            <Link
              to="/register"
              className="inline-flex items-center rounded-md bg-primary-700 px-4 py-2 text-sm font-medium text-white hover:bg-primary-800 min-h-touch"
            >
              Get started
            </Link>
            <p className="mt-3 text-xs text-gray-500">
              Just browsing? Read our{' '}
              <Link to="/care" className="text-primary-700 underline hover:text-primary-800">
                plant care guides
              </Link>
              .
            </p>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}

function ToxicityCard({ match }: { match: ToxicityMatch }) {
  const safeForBoth = match.cats === 'non-toxic' && match.dogs === 'non-toxic';
  const variant = safeForBoth ? 'success' : 'warning';
  const title = safeForBoth
    ? `${match.commonName} is pet-safe`
    : `${match.commonName} can be harmful to pets`;

  return (
    <Alert variant={variant} title={title}>
      <p className="italic">{match.scientificName}</p>
      <ul className="mt-2 space-y-1">
        <li>
          <span className="font-medium">Cats:</span>{' '}
          {match.cats === 'toxic' ? 'Toxic' : 'Non-toxic'}
        </li>
        <li>
          <span className="font-medium">Dogs:</span>{' '}
          {match.dogs === 'toxic' ? 'Toxic' : 'Non-toxic'}
        </li>
      </ul>
      <p className="mt-2">{match.note}</p>
    </Alert>
  );
}
