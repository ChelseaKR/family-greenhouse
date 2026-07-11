/** The four highly scientific personality groups available in the name nursery. */
export type PlantNameVibe = 'punny' | 'distinguished' | 'chaotic' | 'sweet';

export interface PlantNameSuggestion {
  name: string;
  vibe: PlantNameVibe;
  note: string;
  speciesMatch?: {
    id: string;
    label: string;
  };
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

interface SpeciesNameProfile {
  id: string;
  label: string;
  patterns: readonly RegExp[];
  names: Record<PlantNameVibe, readonly string[]>;
}

/**
 * Common and botanical names share a profile, so “pothos” and
 * “Epipremnum aureum” produce the same family of jokes. Keep profiles broad
 * enough to recognize useful input without pretending to identify a plant.
 */
const speciesProfiles: readonly SpeciesNameProfile[] = [
  {
    id: 'fern',
    label: 'ferns',
    patterns: [/fern/i, /nephrolepis/i, /adiantum/i, /asplenium/i],
    names: {
      punny: ['Fernie', 'Fernie Sanders', 'Frond Expectations'],
      distinguished: ['Ferninand Frondsworth', 'Lady Boston of the Bathroom'],
      chaotic: ['The Humidity Department', 'Frond and Disorder'],
      sweet: ['Fernie Baby', 'Fuzzy Frond'],
    },
  },
  {
    id: 'cactus',
    label: 'cacti',
    patterns: [/cactus/i, /cacti/i, /opuntia/i, /mammillaria/i, /cereus/i],
    names: {
      punny: ['Spike Leeaf', 'Prickly Business', 'Cactus Everdeen'],
      distinguished: ['Sir Prickleton', 'Baron von Spine'],
      chaotic: ['Personal Space Enforcer', 'Touch Me and Find Out'],
      sweet: ['Pokey Bean', 'Tiny Spike'],
    },
  },
  {
    id: 'pothos',
    label: 'pothos',
    patterns: [/pothos/i, /epipremnum/i],
    names: {
      punny: ['Poth Malone', 'Pothos With the Mostest'],
      distinguished: ['Sir Trails-a-Lot', 'Duchess Epipremnum'],
      chaotic: ['The Cabinet Escapee', 'Vine and Punishment'],
      sweet: ['Pothie', 'Little Golden Trail'],
    },
  },
  {
    id: 'monstera',
    label: 'monsteras',
    patterns: [/monstera/i, /deliciosa/i, /adansonii/i],
    names: {
      punny: ['Monsterra Deliciosa', 'Swiss Cheese Louise'],
      distinguished: ['Professor Fenestration', 'Lady Monstera of the Split Leaf'],
      chaotic: ['The Hole Situation', 'Unauthorized Window Factory'],
      sweet: ['Little Monster', 'Swiss Cheese Baby'],
    },
  },
  {
    id: 'orchid',
    label: 'orchids',
    patterns: [/orchid/i, /phalaenopsis/i, /dendrobium/i],
    names: {
      punny: ['Orchid You Not', 'Petal to the Metal'],
      distinguished: ['Dame Phalaenopsis', 'Orchid von Bloom'],
      chaotic: ['Rebloom Pending', 'Root Inspection Denied'],
      sweet: ['Petal', 'Moth Baby'],
    },
  },
  {
    id: 'palm',
    label: 'palms',
    patterns: [/palm/i, /chamaedorea/i, /dypsis/i, /areca/i],
    names: {
      punny: ['Palmela Anderson', 'Frond of the Family'],
      distinguished: ['Lady Chamaedorea', 'Sir Palm Springs'],
      chaotic: ['Vacation Mode', 'Lobby Plant Energy'],
      sweet: ['Palmy', 'Little Frond'],
    },
  },
  {
    id: 'snake-plant',
    label: 'snake plants',
    patterns: [/snake plant/i, /sansevieria/i, /dracaena trifasciata/i],
    names: {
      punny: ['Snake Gyllenhaal', 'Hiss Majesty'],
      distinguished: ['Lady Sansevieria', 'Sir Stands-a-Lot'],
      chaotic: ['Vertical Threat', 'Mother-in-Law Enforcement'],
      sweet: ['Noodle', 'Little Snek'],
    },
  },
  {
    id: 'spider-plant',
    label: 'spider plants',
    patterns: [/spider plant/i, /chlorophytum/i],
    names: {
      punny: ['Peter Parker Plant', 'Web Developer'],
      distinguished: ['Count Chlorophytum', 'Madame Spiderette'],
      chaotic: ['Baby Factory', 'Eight Legs Zero Plans'],
      sweet: ['Spiderling', 'Tiny Tuft'],
    },
  },
  {
    id: 'prayer-plant',
    label: 'prayer plants',
    patterns: [/prayer plant/i, /calathea/i, /goeppertia/i, /maranta/i],
    names: {
      punny: ['Maranta Del Rey', 'Thoughts and Prayers'],
      distinguished: ['Countess Calathea', 'Lady Maranta at Vespers'],
      chaotic: ['Curling for Attention', 'The Evening Performance'],
      sweet: ['Prayer Bear', 'Stripey'],
    },
  },
  {
    id: 'peace-lily',
    label: 'peace lilies',
    patterns: [/peace lily/i, /spathiphyllum/i],
    names: {
      punny: ['Lily Tomlinson', 'Give Leaves a Chance'],
      distinguished: ['Ambassador Spathiphyllum', 'Lady Lily of Peace'],
      chaotic: ['Thirst Trap', 'Peace Was Never an Option'],
      sweet: ['Lily Bean', 'Peace Pea'],
    },
  },
  {
    id: 'rubber-plant',
    label: 'rubber plants',
    patterns: [/rubber plant/i, /ficus elastica/i],
    names: {
      punny: ['Rubber Plant Downey Jr.', 'Ficus Pocus'],
      distinguished: ['Lord Elastica', 'Ficus Fitzgerald'],
      chaotic: ['Bounce House', 'Tireless Employee'],
      sweet: ['Gummy', 'Rubber Ducky'],
    },
  },
  {
    id: 'aloe',
    label: 'aloes and agaves',
    patterns: [/aloe/i, /agave/i, /haworthia/i],
    names: {
      punny: ['Aloe There', 'Vera Good Plant'],
      distinguished: ['Aloe Vera Wang', 'Agave Christie'],
      chaotic: ['First Aid Department', 'Tequila Mockingbird'],
      sweet: ['Aloe Baby', 'Vera Bean'],
    },
  },
  {
    id: 'succulent',
    label: 'succulents',
    patterns: [/succulent/i, /echeveria/i, /sedum/i, /crassula/i],
    names: {
      punny: ['Succ It Up', 'Aloe by Another Name'],
      distinguished: ['Duchess Echeveria', 'Sir Sedum of the Saucer'],
      chaotic: ['Water? Never Met Her', 'Thiccums'],
      sweet: ['Chonky Bean', 'Rosette'],
    },
  },
  {
    id: 'philodendron',
    label: 'philodendrons',
    patterns: [/philodendron/i],
    names: {
      punny: ['Phil O. Dendron', 'Phil Collins'],
      distinguished: ['Professor Philodendron', 'Philippa von Heartleaf'],
      chaotic: ['Pole Dancer', 'Certified Tree Hugger'],
      sweet: ['Philly', 'Heartleaf'],
    },
  },
];

/**
 * Produces a name plus its tiny character bio. Supplying an rng keeps the
 * generator deterministic in tests. Recognized common or scientific species
 * names tailor every vibe without ever sending form data over the network.
 */
export function generatePlantNameSuggestion(
  vibe: PlantNameVibe | 'surprise' = 'surprise',
  species = '',
  rng: () => number = Math.random
): PlantNameSuggestion {
  const resolvedVibe = vibe === 'surprise' ? pick(vibes, rng) : vibe;
  const speciesProfile = speciesProfiles.find((profile) =>
    profile.patterns.some((pattern) => pattern.test(species))
  );

  let name: string;
  if (speciesProfile) {
    name = pick(speciesProfile.names[resolvedVibe], rng);
  } else {
    switch (resolvedVibe) {
      case 'punny':
        name = pick(punnyNames, rng);
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
  }

  return {
    name,
    vibe: resolvedVibe,
    note: pick(notes[resolvedVibe], rng),
    ...(speciesProfile && {
      speciesMatch: { id: speciesProfile.id, label: speciesProfile.label },
    }),
  };
}

/** Backwards-compatible one-line helper for callers that only need a name. */
export function generatePlantName(rng: () => number = Math.random): string {
  return generatePlantNameSuggestion('surprise', '', rng).name;
}

function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}
