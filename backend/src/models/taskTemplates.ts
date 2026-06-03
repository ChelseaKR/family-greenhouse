/**
 * Curated bundles of common plant care tasks. Users apply a template to a
 * plant and we synthesize the underlying tasks. Pure data — no DB lookup —
 * so we can iterate on the contents without a migration.
 *
 * Add a new template by appending to TEMPLATES below; tests guarantee every
 * template has a stable id and every task has valid frequency bounds.
 */
import { TaskType } from './schemas.js';

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  /** Used by the frontend to filter templates that suit a given species. */
  suitsKeywords: string[];
  tasks: Array<{
    type: TaskType;
    customType?: string;
    frequencyDays: number;
    notes?: string;
  }>;
}

export const TEMPLATES: TaskTemplate[] = [
  {
    id: 'tropical-houseplant',
    name: 'Tropical houseplant',
    description:
      'For monsteras, philodendrons, pothos, peace lilies — humidity-loving leafy plants.',
    suitsKeywords: ['monstera', 'philodendron', 'pothos', 'peace lily', 'tropical', 'aroid'],
    tasks: [
      { type: 'water', frequencyDays: 7, notes: 'Top inch of soil dry' },
      {
        type: 'fertilize',
        frequencyDays: 30,
        notes: 'Diluted balanced fertilizer in growing season',
      },
      { type: 'prune', frequencyDays: 90, notes: 'Trim yellowing or leggy growth' },
    ],
  },
  {
    id: 'succulent-or-cactus',
    name: 'Succulent / cactus',
    description: 'Drought-tolerant — infrequent water, lots of light.',
    suitsKeywords: [
      'succulent',
      'cactus',
      'echeveria',
      'jade',
      'aloe',
      'sansevieria',
      'snake plant',
    ],
    tasks: [
      { type: 'water', frequencyDays: 21, notes: 'Soil bone-dry first' },
      { type: 'fertilize', frequencyDays: 90, notes: 'Cactus food, half strength' },
    ],
  },
  {
    id: 'fern',
    name: 'Fern',
    description: 'Loves consistent moisture and indirect light.',
    suitsKeywords: ['fern', 'maidenhair', 'boston fern', 'asparagus'],
    tasks: [
      { type: 'water', frequencyDays: 4, notes: 'Keep soil consistently moist' },
      { type: 'fertilize', frequencyDays: 21 },
      { type: 'custom', customType: 'Mist', frequencyDays: 2, notes: 'Boost humidity' },
    ],
  },
  {
    id: 'orchid',
    name: 'Orchid',
    description: 'Phalaenopsis, Cattleya — bark mix, weekly soak, monthly feed.',
    suitsKeywords: ['orchid', 'phalaenopsis', 'cattleya'],
    tasks: [
      { type: 'water', frequencyDays: 7, notes: 'Soak-and-drain in bark' },
      { type: 'fertilize', frequencyDays: 14, notes: 'Weakly weekly orchid food' },
      { type: 'repot', frequencyDays: 730, notes: 'Fresh bark every 2 years' },
    ],
  },
  {
    id: 'flowering-houseplant',
    name: 'Flowering houseplant',
    description: 'African violets, anthuriums, kalanchoes — moderate water + bloom-stage feed.',
    suitsKeywords: ['violet', 'anthurium', 'kalanchoe', 'flowering'],
    tasks: [
      { type: 'water', frequencyDays: 5 },
      { type: 'fertilize', frequencyDays: 14, notes: 'Bloom booster fertilizer' },
      { type: 'prune', frequencyDays: 30, notes: 'Deadhead spent blooms' },
    ],
  },
  {
    id: 'herb',
    name: 'Culinary herb',
    description: 'Basil, mint, rosemary, thyme — sunny window, regular harvesting.',
    suitsKeywords: ['basil', 'mint', 'rosemary', 'thyme', 'oregano', 'herb', 'cilantro', 'parsley'],
    tasks: [
      { type: 'water', frequencyDays: 3 },
      { type: 'fertilize', frequencyDays: 30 },
      { type: 'prune', frequencyDays: 14, notes: 'Pinch tops to encourage bushy growth' },
    ],
  },
];

/**
 * Suggest the best template for a species string. Returns the template whose
 * keywords match the most words in the species, falling back to undefined
 * for "we don't know" — caller can offer all templates as a manual pick.
 */
export function suggestTemplate(species: string | null | undefined): TaskTemplate | undefined {
  if (!species) return undefined;
  const lower = species.toLowerCase();
  let best: { tpl: TaskTemplate; score: number } | undefined;
  for (const tpl of TEMPLATES) {
    const score = tpl.suitsKeywords.reduce((sum, kw) => sum + (lower.includes(kw) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) {
      best = { tpl, score };
    }
  }
  return best?.tpl;
}
