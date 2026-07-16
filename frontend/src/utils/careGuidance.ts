/**
 * Curated care tips for the species we know best. Match by exact scientific
 * name first (the form the SpeciesCombobox stores), then fall back to a
 * keyword match on the user's free-text species string. If nothing matches,
 * we don't render a guidance card — never make something up.
 *
 * Sources: Royal Horticultural Society care sheets, Missouri Botanical
 * Garden's plant finder, plus first-hand household trial-and-error. Reviewed
 * for accuracy before adding new entries.
 */
export interface CareGuide {
  scientific: string;
  /** Common name shown in the card title. */
  common: string;
  /** Keywords that match this guide via fuzzy match (lowercase). */
  keywords: string[];
  /** Lowest approximate room-light level this plant is known to tolerate. */
  minimumLight: 'low' | 'medium' | 'bright';
  /** Curated pet-safety flag; only `true` triggers a placement warning. */
  toxicToPets: boolean;
  light: string;
  water: string;
  humidity: string;
  notes: string;
}

export const CARE_GUIDES: CareGuide[] = [
  {
    scientific: 'Monstera deliciosa',
    common: 'Monstera',
    keywords: ['monstera', 'swiss cheese plant'],
    minimumLight: 'medium',
    toxicToPets: true,
    light:
      'Bright indirect light. Can tolerate medium light but grows slower and produces fewer fenestrations.',
    water: 'Water when the top 1-2 inches of soil are dry. Reduce in winter.',
    humidity: 'Likes 50%+ humidity but tolerates household-average air just fine.',
    notes:
      'Aerial roots want something to climb — a moss pole encourages bigger leaves. Wipe dust off the leaves monthly.',
  },
  {
    scientific: 'Epipremnum aureum',
    common: 'Pothos',
    keywords: ['pothos', "devil's ivy", 'epipremnum'],
    minimumLight: 'low',
    toxicToPets: true,
    light:
      'Anything from low to bright indirect. Variegated cultivars need more light to keep their patterns.',
    water: 'Let the top inch dry out between waterings. Pothos forgives an occasional missed week.',
    humidity: 'Average household humidity is fine.',
    notes:
      'Easiest plant to propagate — cut a stem below a node, root in water, transplant. Trim long vines to encourage bushiness.',
  },
  {
    scientific: 'Dracaena trifasciata',
    common: 'Snake plant',
    keywords: ['snake plant', 'sansevieria', 'mother-in-law'],
    minimumLight: 'low',
    toxicToPets: true,
    light: 'Low to bright indirect. One of the most light-tolerant houseplants there is.',
    water: 'Sparingly. Wait until the soil is bone-dry, then soak. Overwatering is the #1 killer.',
    humidity: 'No special needs — desert-tolerant.',
    notes: 'Great for beginners and forgetful waterers. Drainage holes are non-negotiable.',
  },
  {
    scientific: 'Spathiphyllum wallisii',
    common: 'Peace lily',
    keywords: ['peace lily', 'spathiphyllum'],
    minimumLight: 'medium',
    toxicToPets: true,
    light: 'Medium to bright indirect. Direct sun scorches the leaves.',
    water:
      "Drinks more than most houseplants — drooping leaves are its signal that it's thirsty (and recovers within hours of watering).",
    humidity: 'Higher is better. Mist or sit on a pebble tray.',
    notes: 'Toxic to cats and dogs — keep out of reach.',
  },
  {
    scientific: 'Ficus lyrata',
    common: 'Fiddle leaf fig',
    keywords: ['fiddle leaf', 'ficus lyrata'],
    minimumLight: 'bright',
    toxicToPets: true,
    light: 'Bright indirect, ideally near a south-facing window with sheer curtains.',
    water:
      'Only when the top 2 inches are dry. Consistency matters — fiddle leaves dislike shifting routines.',
    humidity: '50% or above. Brown leaf edges usually mean dry air.',
    notes:
      'Hates being moved. Pick a spot and leave it. Wipe leaves monthly so light reaches them properly.',
  },
  {
    scientific: 'Crassula ovata',
    common: 'Jade plant',
    keywords: ['jade plant', 'crassula'],
    minimumLight: 'bright',
    toxicToPets: true,
    light: 'Bright direct light at least 4-6 hours/day. Indoor sun-room or south window.',
    water: 'Only when soil is fully dry. In winter, monthly is plenty.',
    humidity: "Low. Don't mist.",
    notes:
      'Slow grower; happy when crowded in its pot. Wrinkled leaves = thirsty; mushy leaves = overwatered.',
  },
  {
    scientific: 'Phalaenopsis',
    common: 'Moth orchid',
    keywords: ['orchid', 'phalaenopsis'],
    minimumLight: 'bright',
    toxicToPets: false,
    light: 'Bright indirect. East-facing windows are ideal.',
    water:
      'Once a week — soak the bark medium thoroughly, let it drain completely. Roots should be silvery between waterings.',
    humidity: '50-70%. A pebble tray under the pot helps.',
    notes:
      "Don't water with ice cubes despite the popular advice — slow soak is healthier. Re-bloom comes from a slight night-time temperature drop in fall.",
  },
  {
    scientific: 'Aloe vera',
    common: 'Aloe vera',
    keywords: ['aloe'],
    minimumLight: 'bright',
    toxicToPets: true,
    light: 'Bright direct or very bright indirect. Pale leaves mean not enough light.',
    water: 'Deep soak when soil is fully dry; let drain completely. Roots rot easily.',
    humidity: 'Low.',
    notes: 'Drainage holes mandatory. Cactus/succulent potting mix only.',
  },
  {
    scientific: 'Chlorophytum comosum',
    common: 'Spider plant',
    keywords: ['spider plant', 'chlorophytum'],
    minimumLight: 'medium',
    toxicToPets: false,
    light: 'Medium to bright indirect. Tolerates lower light at the cost of slower growth.',
    water: 'Keep soil lightly moist; let the top inch dry between waterings.',
    humidity: 'Average is fine; appreciates a misting in dry winters.',
    notes:
      'Sensitive to fluoride — leaf tips brown if you water with hard tap water. Filtered or rainwater is better.',
  },
  {
    scientific: 'Zamioculcas zamiifolia',
    common: 'ZZ plant',
    keywords: ['zz plant', 'zamioculcas', 'zz'],
    minimumLight: 'low',
    toxicToPets: true,
    light: 'Anywhere from low to bright indirect. Genuinely tolerates dim corners.',
    water: 'Every 2-3 weeks. The rhizome stores water and resents being soaked.',
    humidity: 'No special needs.',
    notes: 'Toxic if ingested — keep away from pets that chew on plants.',
  },
];

/**
 * Look up a guide by species. Tries exact scientific-name match first
 * (case-insensitive), then keyword match. Returns undefined when nothing
 * fits — caller should hide the card rather than show a generic placeholder.
 */
export function findCareGuide(species: string | null | undefined): CareGuide | undefined {
  if (!species) return undefined;
  const lower = species.trim().toLowerCase();
  if (!lower) return undefined;
  const exact = CARE_GUIDES.find((g) => g.scientific.toLowerCase() === lower);
  if (exact) return exact;
  return CARE_GUIDES.find((g) => g.keywords.some((kw) => lower.includes(kw)));
}
