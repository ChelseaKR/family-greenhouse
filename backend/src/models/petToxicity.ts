/**
 * Curated pet-toxicity catalog for the public "is this plant safe for pets?"
 * lookup (GET /species/toxicity).
 *
 * Why a hand-curated table rather than the Perenual enrichment cache: the
 * lookup is PUBLIC and unauthenticated, so it must never hit the metered
 * Perenual API on an anonymous request (cost + abuse surface). Perenual also
 * only exposes a coarse `poisonous_to_pets` boolean, which can't distinguish
 * "toxic to cats but not dogs" or carry the plain-language caveat a worried
 * pet owner actually needs. These entries are GROUNDED in the ASPCA toxic /
 * non-toxic plant database (the reference vets point people to); the prose is
 * original.
 *
 * ⚠️ The `cats`/`dogs` verdicts are the field a wrong answer does real harm
 * on — a pet owner trusts this line. Verify every entry against the ASPCA
 * listing before adding or editing it, and keep `note` honest about
 * uncertainty rather than guessing.
 */

export type ToxicityVerdict = 'toxic' | 'non-toxic';

export interface PetToxicityEntry {
  /** Stable lookup slug (kebab-case, unique). */
  slug: string;
  commonName: string;
  scientificName: string;
  /** Other names people search by — folded into the match index. */
  aliases: string[];
  cats: ToxicityVerdict;
  dogs: ToxicityVerdict;
  /** One plain, warm sentence: what happens, and the honest caveat. */
  note: string;
}

export const PET_TOXICITY: PetToxicityEntry[] = [
  {
    slug: 'pothos',
    commonName: 'Pothos',
    scientificName: 'Epipremnum aureum',
    aliases: ['devil’s ivy', 'devils ivy', 'golden pothos', 'money plant', 'epipremnum'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'The sap carries insoluble calcium oxalate crystals, so a chewed leaf causes mouth pain, drooling and vomiting. Rarely life-threatening, but unpleasant — keep it up high or out of a determined pet’s reach.',
  },
  {
    slug: 'monstera',
    commonName: 'Monstera',
    scientificName: 'Monstera deliciosa',
    aliases: ['swiss cheese plant', 'split-leaf philodendron', 'split leaf philodendron'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Same calcium oxalate crystals as pothos — chewing irritates the mouth and stomach. Mild for a nibble, but worth keeping out of reach of a cat that likes to taste-test.',
  },
  {
    slug: 'snake-plant',
    commonName: 'Snake plant',
    scientificName: 'Dracaena trifasciata',
    aliases: ['mother-in-law’s tongue', 'mother in laws tongue', 'sansevieria', 'dracaena'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Contains saponins, which cause drooling, vomiting and the odd bout of diarrhoea if eaten. Mildly toxic rather than dangerous — most pets feel rotten for a while and recover.',
  },
  {
    slug: 'spider-plant',
    commonName: 'Spider plant',
    scientificName: 'Chlorophytum comosum',
    aliases: ['airplane plant', 'ribbon plant', 'chlorophytum'],
    cats: 'non-toxic',
    dogs: 'non-toxic',
    note: 'Non-toxic to cats and dogs per the ASPCA — one of the safest leafy plants you can own. Cats are oddly drawn to chewing it; a big mouthful can still cause a mild tummy upset, but there’s nothing poisonous in it.',
  },
  {
    slug: 'peace-lily',
    commonName: 'Peace lily',
    scientificName: 'Spathiphyllum',
    aliases: ['spathiphyllum', 'closet plant'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Calcium oxalate crystals cause intense mouth and throat irritation, drooling and trouble swallowing. Despite the name it is NOT a true lily, so it won’t cause the kidney failure true lilies do — but it’s still one to keep away from pets.',
  },
  {
    slug: 'aloe-vera',
    commonName: 'Aloe vera',
    scientificName: 'Aloe vera',
    aliases: ['aloe', 'medicine plant', 'burn plant'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'The gel inside is fine, but the leaf’s outer layer contains saponins and anthraquinones that cause vomiting, lethargy and diarrhoea if eaten. Keep the plant out of reach even though aloe gel is a human first-aid staple.',
  },
  {
    slug: 'jade-plant',
    commonName: 'Jade plant',
    scientificName: 'Crassula ovata',
    aliases: ['lucky plant', 'crassula', 'friendship tree'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Toxic to both, though exactly why isn’t fully understood — eating it causes vomiting, a wobbly unsteady gait and a slowed heart rate. Worth a vet call if a pet has had a real mouthful.',
  },
  {
    slug: 'philodendron',
    commonName: 'Philodendron',
    scientificName: 'Philodendron',
    aliases: ['heartleaf philodendron', 'philodendron hederaceum'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'The whole genus carries calcium oxalate crystals — chewing burns the mouth and causes drooling and vomiting. A common, easy houseplant, so a popular one to site well out of reach.',
  },
  {
    slug: 'zz-plant',
    commonName: 'ZZ plant',
    scientificName: 'Zamioculcas zamiifolia',
    aliases: ['zanzibar gem', 'zamioculcas', 'zz'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Calcium oxalate crystals again — chewing irritates the mouth and stomach. Its reputation as “toxic” overstates it; a nibble means an unhappy pet, not an emergency, but the sap can also irritate skin so wash hands after handling.',
  },
  {
    slug: 'fiddle-leaf-fig',
    commonName: 'Fiddle-leaf fig',
    scientificName: 'Ficus lyrata',
    aliases: ['fiddle leaf fig', 'ficus', 'fig'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'The sap contains crystals that irritate the mouth and skin, causing drooling and vomiting if leaves are eaten. More of a nuisance than a danger, but the milky sap can also cause a skin rash.',
  },
  {
    slug: 'rubber-plant',
    commonName: 'Rubber plant',
    scientificName: 'Ficus elastica',
    aliases: ['rubber tree', 'rubber fig', 'ficus elastica'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'The milky sap irritates the mouth and gut and can cause drooling, vomiting and a skin reaction. Mildly toxic — keep curious chewers away and wipe up any sap from broken leaves.',
  },
  {
    slug: 'dieffenbachia',
    commonName: 'Dieffenbachia',
    scientificName: 'Dieffenbachia',
    aliases: ['dumb cane', 'dumbcane', 'leopard lily'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Among the harsher of the calcium-oxalate plants — chewing causes intense oral pain, drooling and, in bad cases, enough swelling to make breathing difficult. One to keep firmly out of reach of pets and children.',
  },
  {
    slug: 'calathea',
    commonName: 'Calathea',
    scientificName: 'Calathea',
    aliases: ['prayer plant', 'goeppertia', 'maranta', 'rattlesnake plant'],
    cats: 'non-toxic',
    dogs: 'non-toxic',
    note: 'Non-toxic to cats and dogs per the ASPCA — a genuinely pet-safe choice if you want something showy. A big mouthful might cause a mild upset like any plant, but nothing poisonous.',
  },
  {
    slug: 'boston-fern',
    commonName: 'Boston fern',
    scientificName: 'Nephrolepis exaltata',
    aliases: ['sword fern', 'nephrolepis', 'fern'],
    cats: 'non-toxic',
    dogs: 'non-toxic',
    note: 'Non-toxic to cats and dogs per the ASPCA — true ferns are a reliably safe group. Pets sometimes bat at the fronds; no harm done beyond a bit of mess.',
  },
  {
    slug: 'asparagus-fern',
    commonName: 'Asparagus fern',
    scientificName: 'Asparagus densiflorus',
    // Despite the name, this is NOT a true fern (it's in the asparagus/lily
    // family) — critically, it does NOT belong in the "true ferns are safe"
    // group above. Deliberately no bare "fern" alias: that would collide
    // with boston-fern's "fern" alias in the word-overlap matching tier and
    // reintroduce the exact false-negative this entry exists to close.
    aliases: ['sprenger fern', 'emerald fern', 'foxtail fern', 'asparagus densiflorus'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Toxic to cats and dogs per the ASPCA — the berries carry sapogenins that cause vomiting, diarrhea and abdominal pain, and repeated skin contact with the sap can cause allergic dermatitis. Keep it well out of reach.',
  },
  {
    slug: 'african-violet',
    commonName: 'African violet',
    scientificName: 'Saintpaulia',
    aliases: ['saintpaulia', 'violet'],
    cats: 'non-toxic',
    dogs: 'non-toxic',
    note: 'Non-toxic to cats and dogs per the ASPCA — safe to keep on a windowsill within reach. (Don’t confuse it with true violets or other flowering “violets”, which differ.)',
  },
  {
    slug: 'orchid',
    commonName: 'Orchid (Phalaenopsis)',
    scientificName: 'Phalaenopsis',
    aliases: ['phalaenopsis', 'moth orchid', 'orchids'],
    cats: 'non-toxic',
    dogs: 'non-toxic',
    note: 'The common moth orchid is non-toxic to cats and dogs per the ASPCA. Eating a flower or leaf might cause a mild stomach upset, but there’s nothing poisonous in it.',
  },
  {
    slug: 'lily',
    commonName: 'True lily',
    scientificName: 'Lilium',
    aliases: [
      'lilium',
      'easter lily',
      'tiger lily',
      'stargazer lily',
      'asiatic lily',
      'daylily',
      'hemerocallis',
    ],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'This is the dangerous one. True lilies (Lilium) and daylilies (Hemerocallis) cause sudden kidney failure in cats — even pollen, vase water or a single leaf can be fatal. If a cat has had ANY contact, treat it as an emergency and call a vet immediately. Less severe in dogs, but still keep them away.',
  },
  {
    slug: 'sago-palm',
    commonName: 'Sago palm',
    scientificName: 'Cycas revoluta',
    aliases: ['cycad', 'cycas', 'king sago'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Severely toxic — every part, especially the seeds, can cause liver failure and is often fatal even with treatment. If a pet has eaten any of it, this is a vet emergency, not a wait-and-see.',
  },
  {
    slug: 'poinsettia',
    commonName: 'Poinsettia',
    scientificName: 'Euphorbia pulcherrima',
    aliases: ['euphorbia', 'christmas flower', 'christmas star'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Its reputation is far worse than the reality — the milky sap irritates the mouth and stomach, causing drooling and mild vomiting, but it is rarely serious. Keep it out of reach, but don’t panic over a stray nibble.',
  },
];

/** Normalize a query/name for fuzzy matching: lowercase, strip punctuation,
 *  collapse whitespace. Keeps the matcher forgiving of "snake plant" vs
 *  "snake-plant" vs "Snake Plant!". */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface PetToxicityMatch {
  slug: string;
  commonName: string;
  scientificName: string;
  cats: ToxicityVerdict;
  dogs: ToxicityVerdict;
  note: string;
}

function toMatch(entry: PetToxicityEntry): PetToxicityMatch {
  return {
    slug: entry.slug,
    commonName: entry.commonName,
    scientificName: entry.scientificName,
    cats: entry.cats,
    dogs: entry.dogs,
    note: entry.note,
  };
}

/**
 * Resolve a free-text plant name to at most `limit` toxicity entries, best
 * match first. Pure + deterministic (no I/O), so it's safe to call from the
 * public, cache-friendly handler. Matching tiers, in priority order:
 *   1. exact name/alias hit
 *   2. query is a prefix of a name/alias (typeahead)
 *   3. any name/alias contains the query (substring)
 *   4. every query word (individually) appears in some name/alias (loose
 *      word overlap) — deliberately requires ALL words, not just one: a
 *      single generic alias word (e.g. Boston fern's bare "fern" alias)
 *      must not alone satisfy a multi-word query like "asparagus fern" and
 *      hand back an unrelated species' (possibly wrong) toxicity verdict.
 */
export function lookupToxicity(query: string, limit = 5): PetToxicityMatch[] {
  const q = normalizeName(query);
  if (q.length < 2) return [];

  const indexed = PET_TOXICITY.map((entry) => ({
    entry,
    names: [entry.commonName, entry.scientificName, ...entry.aliases].map(normalizeName),
  }));

  const exact: PetToxicityEntry[] = [];
  const prefix: PetToxicityEntry[] = [];
  const substring: PetToxicityEntry[] = [];
  const word: PetToxicityEntry[] = [];
  const qWords = q.split(' ').filter((w) => w.length >= 3);

  for (const { entry, names } of indexed) {
    if (names.some((n) => n === q)) {
      exact.push(entry);
    } else if (names.some((n) => n.startsWith(q))) {
      prefix.push(entry);
    } else if (names.some((n) => n.includes(q))) {
      substring.push(entry);
    } else if (qWords.length > 0 && qWords.every((w) => names.some((n) => n.includes(w)))) {
      word.push(entry);
    }
  }

  const ordered: PetToxicityEntry[] = [];
  for (const bucket of [exact, prefix, substring, word]) {
    for (const e of bucket) {
      if (!ordered.includes(e)) ordered.push(e);
    }
  }
  return ordered.slice(0, limit).map(toMatch);
}
