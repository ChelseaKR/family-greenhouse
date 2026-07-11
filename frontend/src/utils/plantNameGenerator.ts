/** The four highly scientific personality groups available in the name nursery. */
export type PlantNameVibe = 'punny' | 'distinguished' | 'chaotic' | 'sweet';

export interface PlantNameSuggestion {
  name: string;
  vibe: PlantNameVibe;
  note: string;
}

const vibes: readonly PlantNameVibe[] = ['punny', 'distinguished', 'chaotic', 'sweet'];

const notes: Record<PlantNameVibe, readonly string[]> = {
  punny: [
    'A name with excellent comic thyme-ing.',
    'Groan now. Grow later.',
    'The pun is bad. The plant is innocent.',
  ],
  distinguished: [
    'Owns several estates, all of them pots.',
    'Has strong opinions about afternoon light.',
    'Requests rainwater in the good saucer.',
  ],
  chaotic: [
    'Thriving is optional. Drama is mandatory.',
    'No references. Can start immediately.',
    'A perfectly normal name for a perfectly normal leaf.',
  ],
  sweet: [
    'Small name. Enormous emotional responsibility.',
    'Certified little green friend.',
    'Just a baby, regardless of actual age.',
  ],
};

const punnyNames = [
  'Aloe Vera Wang',
  'Root Bader Ginsburg',
  'Morgan Treeman',
  'Leaf Erikson',
  'Keanu Leaves',
  'Vincent van Grow',
  'Post Ma-leaf',
  'Frond Drescher',
  'Pot Hanks',
  'Dolly Pardon My Roots',
  'Sproutkast',
  'Christopher Plantin',
  'Bud Lightyear',
  'Fernie Sanders',
  'Snoop Frond',
  'Shrubert Downey Jr.',
];

const distinguishedFirsts = [
  'Bartholomew',
  'Beatrice',
  'Cornelius',
  'Dorothea',
  'Edmund',
  'Henrietta',
  'Hortensia',
  'Montgomery',
  'Octavia',
  'Percival',
  'Reginald',
  'Wilhelmina',
];
const distinguishedLasts = [
  'Fernsworth',
  'Mossbottom',
  'Sproutworth',
  'Pottersby',
  'von Verdant',
  "O'Bloom",
  'de la Plante',
  'Chlorophyll III',
  'of the Sunny Window',
  'Leafington-Smythe',
];
const titles = ['Sir', 'Lady', 'Professor', 'Doctor', 'Admiral', 'Baron', 'Countess', 'Mx.'];

const chaoticNames = [
  'The Moist Wanted',
  'Leaf Me Alone',
  'Tax Evasion',
  'Emergency Contact',
  'Unpaid Intern',
  'Photosynthesis With Benefits',
  'Planty McPlantface',
  'Not Dead Yet',
  'The Forbidden Salad',
  'Water Me or Else',
  'Local Foliage',
  'Crisis on the Windowsill',
  'Soil Goodman, Attorney at Lawn',
  'Big Leaf Energy',
  'Moisturizer',
  'Botanical Witness Protection',
];

const sweetFirsts = [
  'Bean',
  'Biscuit',
  'Button',
  'Dumpling',
  'Figgy',
  'Mochi',
  'Noodle',
  'Peanut',
  'Pickle',
  'Pip',
  'Pudding',
  'Sprig',
];
const sweetLasts = [
  'Baby',
  'McSprout',
  'Littleleaf',
  'Wiggles',
  'Sunshine',
  'Greenbean',
  'Pocket Salad',
  'the Brave',
];

const speciesBits: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/fern/i, ['Fernie', 'Frond Expectations', 'Ferninand']],
  [/(cactus|cacti)/i, ['Spike Leeaf', 'Prickly Business', 'Pointy Potter']],
  [/(aloe|agave)/i, ['Aloe There', 'Vera Good Plant', 'Agave It My All']],
  [/pothos/i, ['Poth Malone', 'Pothos With the Mostest', 'Sir Trails-a-Lot']],
  [/monstera/i, ['Monsterra Deliciosa', 'Swiss Cheese Louise', 'Monstera Mash']],
  [/orchid/i, ['Orchid You Not', 'Bloom Hilda', 'Petal to the Metal']],
  [/(palm|parlor)/i, ['Palmela', 'Frond of the Family', 'Palm Springs']],
  [/(succulent|echeveria|sedum)/i, ['Succ It Up', 'Thiccums', 'Water? Never Met Her']],
];

/**
 * Produces a name plus its tiny character bio. Supplying an rng keeps the
 * generator deterministic in tests; species is used occasionally for a
 * tailored joke without ever sending form data over the network.
 */
export function generatePlantNameSuggestion(
  vibe: PlantNameVibe | 'surprise' = 'surprise',
  species = '',
  rng: () => number = Math.random
): PlantNameSuggestion {
  const resolvedVibe = vibe === 'surprise' ? pick(vibes, rng) : vibe;
  const contextualNames = speciesBits.find(([pattern]) => pattern.test(species))?.[1];
  const useContextualPun = resolvedVibe === 'punny' && contextualNames && rng() < 0.55;

  let name: string;
  switch (resolvedVibe) {
    case 'punny':
      name = useContextualPun ? pick(contextualNames, rng) : pick(punnyNames, rng);
      break;
    case 'distinguished':
      name = `${pick(titles, rng)} ${pick(distinguishedFirsts, rng)} ${pick(distinguishedLasts, rng)}`;
      break;
    case 'chaotic':
      name = pick(chaoticNames, rng);
      break;
    case 'sweet':
      name = `${pick(sweetFirsts, rng)} ${pick(sweetLasts, rng)}`;
      break;
  }

  return { name, vibe: resolvedVibe, note: pick(notes[resolvedVibe], rng) };
}

/** Backwards-compatible one-line helper for callers that only need a name. */
export function generatePlantName(rng: () => number = Math.random): string {
  return generatePlantNameSuggestion('surprise', '', rng).name;
}

function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}
