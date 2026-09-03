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
    // Deliberately NO bare 'fern' alias — the mirror of the note on
    // asparagus-fern below. A bare 'fern' here put this NON-TOXIC row in the
    // exact-match tier for the query "fern", which outranks every later tier
    // and so led with a green "Boston fern is pet-safe" card above the
    // genuinely toxic asparagus fern. "fern" still matches this row through
    // the substring tier via "Boston fern", so nothing is lost but the
    // undeserved top billing.
    aliases: ['sword fern', 'nephrolepis', 'nephrolepis exaltata'],
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
  // ---------------------------------------------------------------------
  // Added to cover the /care/<plant> guides shipped in #384. Every verdict
  // below was read off that plant's own ASPCA entry page (URL noted per
  // entry), not inferred from the slug or from the care guide's prose.
  // ---------------------------------------------------------------------
  {
    slug: 'bird-of-paradise',
    commonName: 'Bird of paradise',
    scientificName: 'Strelitzia reginae',
    // ASPCA "Bird of Paradise Flower" (Strelitzia reginae): Toxic to Dogs,
    // Toxic to Cats, Toxic to Horses.
    // /toxic-and-non-toxic-plants/bird-paradise-flower
    //
    // ⚠️ TWO different plants are sold as "bird of paradise". ASPCA's entry
    // titled plain "Bird of Paradise" is Caesalpinia gilliesii — a DIFFERENT,
    // more toxic shrub, also toxic to cats and dogs, whose own listing warns
    // not to confuse it with Strelitzia. Deliberately no Caesalpinia common
    // names ('peacock flower', 'pride of barbados', 'poinciana') as aliases
    // here: routing that plant's searches to this row would answer a question
    // about the harsher species using the milder one's note. Both are toxic,
    // so an ambiguous query is never told "safe" — but keep them separate.
    aliases: ['strelitzia', 'strelitzia reginae', 'bird of paradise flower', 'crane flower'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Toxic to cats and dogs per the ASPCA — the fruit and seeds carry the GI irritants, causing nausea, vomiting and drowsiness. Usually mild, but note that a very different shrub (Caesalpinia gilliesii) is also sold as “bird of paradise” and is harsher, so check which one you have.',
  },
  {
    slug: 'anthurium',
    commonName: 'Anthurium',
    scientificName: 'Anthurium',
    // ASPCA "Flamingo Flower" (Anthurium scherzeranum): Toxic to Dogs, Toxic
    // to Cats, Toxic to Horses. /toxic-and-non-toxic-plants/flamingo-flower
    // Kept at genus level because the care guide covers A. andraeanum while
    // ASPCA lists A. scherzeranum; the insoluble-calcium-oxalate toxicity is
    // an Araceae family trait shared across the genus, so the verdict holds
    // either way and naming a single species here would overstate precision.
    aliases: [
      'flamingo flower',
      'flamingo lily',
      'tail flower',
      'painters palette',
      'pigtail plant',
      'anthurium andraeanum',
      'anthurium scherzeranum',
    ],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Toxic to cats and dogs per the ASPCA — the same insoluble calcium oxalate crystals as peace lily and dieffenbachia, so chewing burns the mouth and causes drooling and trouble swallowing. Despite the “flamingo lily” nickname it is not a true lily, so it will not cause the kidney failure those do.',
  },
  {
    slug: 'chinese-evergreen',
    commonName: 'Chinese evergreen',
    scientificName: 'Aglaonema',
    // ASPCA "Chinese Evergreen" (Aglaonema modestum): Toxic to Dogs, Toxic to
    // Cats, Toxic to Horses. /toxic-and-non-toxic-plants/chinese-evergreen
    aliases: ['aglaonema', 'aglaonema modestum', 'silver queen'],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Toxic to cats and dogs per the ASPCA — insoluble calcium oxalate crystals cause oral pain, a swollen mouth and tongue, drooling and vomiting. Mild for a nibble rather than an emergency, but a popular floor plant, so put it up out of a chewer’s reach.',
  },
  {
    slug: 'english-ivy',
    commonName: 'English ivy',
    scientificName: 'Hedera helix',
    // ASPCA "English Ivy" (Hedera helix): Toxic to Dogs, Toxic to Cats, Toxic
    // to Horses. /toxic-and-non-toxic-plants/english-ivy
    // The bare 'ivy' alias is safe here in a way a bare 'fern' or 'palm'
    // alias would not be: every ivy-named row in this table (this one and
    // pothos's "devil's ivy") is toxic, so an ambiguous "ivy" query cannot
    // be answered "pet-safe". Re-check that if a non-toxic ivy (e.g. Swedish
    // ivy, Plectranthus) is ever added.
    aliases: [
      'hedera helix',
      'hedera',
      'ivy',
      'common ivy',
      'california ivy',
      'branching ivy',
      'glacier ivy',
      'needlepoint ivy',
      'sweetheart ivy',
    ],
    cats: 'toxic',
    dogs: 'toxic',
    note: 'Toxic to cats and dogs per the ASPCA — the triterpenoid saponins cause vomiting, drooling, belly pain and diarrhoea. The leaves are more dangerous than the berries, and it is a trailing vine a cat will happily bat at, so hang it well out of reach.',
  },
  {
    slug: 'money-tree',
    commonName: 'Money tree',
    scientificName: 'Pachira aquatica',
    // ASPCA "Money Tree" (Pachira aquatica): Non-Toxic to Dogs, Non-Toxic to
    // Cats, Non-Toxic to Horses. /toxic-and-non-toxic-plants/money-tree
    //
    // ⚠️ DELIBERATELY NO 'money plant' ALIAS — this is the highest-stakes
    // alias trap in the table. ASPCA does list "Money Plant" as an additional
    // common name for Pachira, but in ordinary use "money plant" far more
    // often means pothos (Epipremnum aureum) or jade (Crassula ovata), BOTH
    // OF WHICH ARE TOXIC and both of which are already in this table. Adding
    // it here would hand a worried pothos or jade owner a green "pet-safe"
    // card for a plant that is not. 'money plant' stays pointed at pothos
    // (toxic) — the conservative of the three readings. Guarded by tests.
    aliases: ['pachira', 'pachira aquatica', 'guiana chestnut', 'malabar chestnut', 'saba nut'],
    cats: 'non-toxic',
    dogs: 'non-toxic',
    note: 'Non-toxic to cats and dogs per the ASPCA — the braided-trunk Pachira is genuinely safe. Careful with the name though: “money plant” usually means pothos or jade instead, and both of those ARE toxic, so make sure yours is the braided Pachira.',
  },
  {
    slug: 'christmas-cactus',
    commonName: 'Christmas cactus',
    scientificName: 'Schlumbergera',
    // ASPCA "Christmas Cactus" (Schlumbergera bridgesii): Non-Toxic to Dogs,
    // Non-Toxic to Cats, Non-Toxic to Horses.
    // /toxic-and-non-toxic-plants/christmas-cactus
    // No bare 'christmas' alias: poinsettia (toxic) is the other Christmas
    // plant in this table and must not be out-ranked by a non-toxic row on a
    // generic seasonal query.
    aliases: [
      'schlumbergera bridgesii',
      'holiday cactus',
      'thanksgiving cactus',
      'zygocactus',
      'crab cactus',
    ],
    cats: 'non-toxic',
    dogs: 'non-toxic',
    note: 'Non-toxic to cats and dogs per the ASPCA — a safe choice for a house with pets at Christmas, unlike the poinsettia it usually sits next to. A big mouthful of it can still cause a mild tummy upset, as any plant can.',
  },
  {
    slug: 'parlor-palm',
    commonName: 'Parlor palm',
    scientificName: 'Chamaedorea elegans',
    // ASPCA "Parlor Palm" (Chamaedorea elegans): Non-Toxic to Dogs, Non-Toxic
    // to Cats. /toxic-and-non-toxic-plants/parlor-palm
    //
    // ⚠️ DELIBERATELY NO BARE 'palm' ALIAS, for the same reason asparagus
    // fern carries no bare 'fern' alias — only far more serious. The sago
    // palm in this table is severely toxic (liver failure, often fatal even
    // with treatment). A bare 'palm' alias here would put a non-toxic row in
    // the exact-match tier for the query "palm" and lead a worried owner with
    // a green "pet-safe" card. Guarded by tests.
    aliases: [
      'chamaedorea',
      'chamaedorea elegans',
      'parlour palm',
      'neanthe bella palm',
      'neanthe bella',
      'good luck palm',
    ],
    cats: 'non-toxic',
    dogs: 'non-toxic',
    note: 'Non-toxic to cats and dogs per the ASPCA — a genuinely pet-safe palm. Do not let that generalise to other palms: the sago palm, sold alongside it, is severely toxic and can be fatal, so check the specific plant rather than the word “palm”.',
  },
  {
    slug: 'hoya',
    commonName: 'Hoya',
    scientificName: 'Hoya carnosa',
    // ASPCA "Wax Plant" (Hoya carnosa 'krinkle kurl'): Non-Toxic to Dogs,
    // Non-Toxic to Cats. /toxic-and-non-toxic-plants/wax-plant
    aliases: ['hoya carnosa', 'wax plant', 'porcelain flower', 'hindu rope plant', 'hindu rope'],
    cats: 'non-toxic',
    dogs: 'non-toxic',
    note: 'Non-toxic to cats and dogs per the ASPCA — safe to hang where a cat can reach it. The waxy leaves are tough enough that most pets lose interest quickly anyway.',
  },
  {
    slug: 'nerve-plant',
    commonName: 'Nerve plant',
    scientificName: 'Fittonia albivenis',
    // ASPCA "Nerve Plant" (listed as Fittonia verschaffeltii, a synonym of
    // the accepted F. albivenis): Non-Toxic to Dogs, Non-Toxic to Cats,
    // Non-Toxic to Horses. /toxic-and-non-toxic-plants/nerve-plant
    aliases: ['fittonia', 'fittonia albivenis', 'fittonia verschaffeltii', 'mosaic plant'],
    cats: 'non-toxic',
    dogs: 'non-toxic',
    note: 'Non-toxic to cats and dogs per the ASPCA — a good pick for a low shelf or a terrarium within reach of a curious pet. Nothing poisonous in it, though a big mouthful can upset a stomach like any plant.',
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

/** True when an entry is toxic to either species. */
function isToxic(entry: PetToxicityEntry): boolean {
  return entry.cats === 'toxic' || entry.dogs === 'toxic';
}

/**
 * Stable partition of one matching tier: toxic entries first, each group
 * keeping its original catalog order.
 *
 * Several common names are genuinely ambiguous across species — "fern"
 * (Boston, non-toxic / asparagus, toxic), "palm" (parlor, non-toxic / sago,
 * severely toxic), "christmas" (cactus, non-toxic / poinsettia, toxic),
 * "lily" (peace lily vs the true lily that kills cats). The page renders
 * every match as a card, but the FIRST card is the one a hurried, worried
 * reader acts on, and a green "…is pet-safe" banner above a toxic sibling is
 * the wrong way round. When a tier is ambiguous, lead with the dangerous
 * answer.
 *
 * This re-orders WITHIN a tier only — exact still beats prefix beats
 * substring beats word-overlap — and never adds or removes a result, so it
 * cannot turn a non-match into a match or otherwise loosen matching.
 */
function toxicFirst(bucket: PetToxicityEntry[]): PetToxicityEntry[] {
  return [...bucket.filter(isToxic), ...bucket.filter((e) => !isToxic(e))];
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
 * Ties inside a tier are broken toxic-first — see `toxicFirst`.
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
    for (const e of toxicFirst(bucket)) {
      if (!ordered.includes(e)) ordered.push(e);
    }
  }
  return ordered.slice(0, limit).map(toMatch);
}
