// Pure client-side novelty name generator. Combines a "first name" with a
// plant-themed surname, occasionally with a title for personality.
const firstNames = [
  'Audrey',
  'Basil',
  'Bramble',
  'Clover',
  'Daisy',
  'Fern',
  'Hazel',
  'Iris',
  'Juniper',
  'Lavender',
  'Marigold',
  'Olive',
  'Pearl',
  'Poppy',
  'Posey',
  'Rosie',
  'Sage',
  'Sorrel',
  'Sprout',
  'Thistle',
  'Verbena',
  'Willow',
  'Yarrow',
  'Zinnia',
  'Bartholomew',
  'Beverly',
  'Cornelius',
  'Edmund',
  'Felix',
  'Frederick',
  'Gerald',
  'Henrietta',
  'Hortensia',
  'Maximilian',
  'Mortimer',
  'Octavia',
  'Reginald',
  'Sebastian',
  'Wilhelmina',
  'Wendell',
];

const lastNames = [
  'Leafington',
  'Greenleaf',
  'Sproutworth',
  'Mossbottom',
  'Pottersby',
  'Stemwick',
  'Frondsworth',
  'Bloomgood',
  'Petalstone',
  'Vinemoor',
  'Photosynth',
  'Chlorophyll',
  'Tendril',
  'Bushwhacker',
  'McLeafface',
  "O'Bloom",
  'von Verdant',
  'de la Plante',
  'Greentoes',
  'Blossomington',
];

const titles = [
  'Sir',
  'Lady',
  'Captain',
  'Professor',
  'Doctor',
  'Admiral',
  'Mx.',
  'Madame',
  'Lord',
  'Baron',
];

/**
 * Returns a single random plant name. The same generator powers the "shuffle"
 * button on the AddPlant page; nothing about it touches the network so it's
 * safe to spam-click.
 */
export function generatePlantName(rng: () => number = Math.random): string {
  const useTitle = rng() < 0.3;
  const first = pick(firstNames, rng);
  const last = pick(lastNames, rng);
  return useTitle ? `${pick(titles, rng)} ${first} ${last}` : `${first} ${last}`;
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}
