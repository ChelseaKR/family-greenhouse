import { useState } from 'react';
import { ArrowPathIcon, CheckIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';
import {
  generatePlantNameSuggestion,
  type PlantNameSuggestion,
  type PlantNameVibe,
} from '@/utils/plantNameGenerator';

interface PlantNameNurseryProps {
  species: string;
  onUseName: (name: string) => void;
}

const vibeOptions: ReadonlyArray<{
  value: PlantNameVibe | 'surprise';
  labelKey: string;
  emoji: string;
}> = [
  { value: 'surprise', labelKey: 'plants.nameNursery.vibes.surprise', emoji: '🎲' },
  { value: 'punny', labelKey: 'plants.nameNursery.vibes.punny', emoji: '🥁' },
  { value: 'distinguished', labelKey: 'plants.nameNursery.vibes.distinguished', emoji: '🎩' },
  { value: 'chaotic', labelKey: 'plants.nameNursery.vibes.chaotic', emoji: '🔥' },
  { value: 'sweet', labelKey: 'plants.nameNursery.vibes.sweet', emoji: '🍬' },
];

export function PlantNameNursery({ species, onUseName }: PlantNameNurseryProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [vibe, setVibe] = useState<PlantNameVibe | 'surprise'>('surprise');
  const [suggestion, setSuggestion] = useState<PlantNameSuggestion | null>(null);

  const rollName = (nextVibe = vibe) => {
    setSuggestion((previous) => {
      let next = generatePlantNameSuggestion(nextVibe, species);
      // A reroll that returns the same card feels broken even when it is valid
      // randomness. Give the nursery a few cheap client-side chances to find a
      // different name; every pool has multiple possibilities.
      for (let attempt = 0; previous && next.name === previous.name && attempt < 3; attempt += 1) {
        next = generatePlantNameSuggestion(nextVibe, species);
      }
      return next;
    });
  };

  const chooseVibe = (nextVibe: PlantNameVibe | 'surprise') => {
    setVibe(nextVibe);
    rollName(nextVibe);
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        className="group inline-flex min-h-touch items-center gap-2 rounded-md text-sm font-semibold text-primary-700 hover:text-primary-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
        onClick={() => {
          setIsOpen(true);
          rollName();
        }}
        aria-expanded="false"
      >
        <SparklesIcon className="h-4 w-4 transition-transform group-hover:rotate-12" />
        {t('plants.nameNursery.open')}
      </button>
    );
  }

  return (
    <section
      className="relative overflow-hidden rounded-xl border border-primary-200 bg-primary-50/80 p-4 shadow-journal"
      aria-label={t('plants.nameNursery.regionLabel')}
    >
      <div
        className="pointer-events-none absolute -right-5 -top-8 select-none text-7xl opacity-[0.08]"
        aria-hidden="true"
      >
        ☘
      </div>
      <div className="relative">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-serif text-lg text-ink">{t('plants.nameNursery.title')}</p>
            <p className="mt-0.5 text-xs text-primary-800">{t('plants.nameNursery.description')}</p>
          </div>
          <button
            type="button"
            className="min-h-touch rounded-md px-2 text-xs font-medium text-primary-700 hover:bg-primary-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            onClick={() => setIsOpen(false)}
          >
            {t('plants.nameNursery.close')}
          </button>
        </div>

        <div
          className="mt-3 flex flex-wrap gap-2"
          role="group"
          aria-label={t('plants.nameNursery.personalityLabel')}
        >
          {vibeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`min-h-touch rounded-full border px-3 py-1.5 text-xs font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${
                vibe === option.value
                  ? 'border-primary-700 bg-primary-700 text-white shadow-sm'
                  : 'border-primary-200 bg-paper text-primary-800 hover:-translate-y-0.5 hover:border-primary-400'
              }`}
              onClick={() => chooseVibe(option.value)}
              aria-pressed={vibe === option.value}
            >
              <span aria-hidden="true">{option.emoji}</span> {t(option.labelKey)}
            </button>
          ))}
        </div>

        {suggestion && (
          <div
            className="mt-4 rounded-lg border border-dashed border-primary-300 bg-paper px-4 py-4 text-center"
            aria-live="polite"
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent-700">
              {t('plants.nameNursery.ready')}
            </p>
            {suggestion.speciesMatch && (
              <p className="mx-auto mt-2 w-fit rounded-full border border-primary-200 bg-primary-50 px-2.5 py-1 text-[11px] font-semibold text-primary-800">
                <span aria-hidden="true">🧬</span>{' '}
                {t('plants.nameNursery.speciesInspired', {
                  species: t(
                    `plants.nameNursery.speciesFamilies.${suggestion.speciesMatch.id}`,
                    suggestion.speciesMatch.label
                  ),
                })}
              </p>
            )}
            <p className="mt-1 font-serif text-2xl leading-tight text-ink">{suggestion.name}</p>
            <p className="mt-1 text-xs italic text-gray-600">{suggestion.note}</p>

            <div className="mt-4 flex flex-col-reverse justify-center gap-2 sm:flex-row">
              <button
                type="button"
                className="inline-flex min-h-touch items-center justify-center gap-2 rounded-md border border-primary-300 bg-paper px-4 text-sm font-semibold text-primary-800 hover:bg-primary-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                onClick={() => rollName()}
              >
                <ArrowPathIcon className="h-4 w-4" />
                {t('plants.nameNursery.another')}
              </button>
              <button
                type="button"
                className="inline-flex min-h-touch items-center justify-center gap-2 rounded-md bg-primary-700 px-4 text-sm font-semibold text-white hover:bg-primary-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
                onClick={() => {
                  onUseName(suggestion.name);
                  setIsOpen(false);
                }}
              >
                <CheckIcon className="h-4 w-4" />
                {t('plants.nameNursery.useName')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
