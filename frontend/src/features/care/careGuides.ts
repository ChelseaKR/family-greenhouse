/**
 * Programmatic species care pages — the SEO scale lever.
 *
 * Each entry is one page at `/care/[slug]`, targeting "how often to water
 * [plant]" / "[plant] care" / "why is my [plant] dying". One template
 * (`CareGuidePage.tsx`) renders all of them, so growing the surface = adding
 * data entries, not writing components.
 *
 * Entries are GROUNDED: the facts (watering interval, light, toxicity) come
 * from the species catalog / Perenual, the prose is original. The generator
 * prompt that produces this shape is `docs/growth/prompts/02-species-care-page.md`.
 * These three are a hand-reviewed SAMPLE so the content quality and the
 * architecture can be judged before scaling to ~150 species.
 *
 * ⚠️ Two fields a wrong answer does real harm on — verify against source data
 * for every entry before publishing: `quickFacts.water` and `quickFacts.toxicity`
 * (a pet owner trusts that toxicity line).
 */
export interface CareGuide {
  slug: string;
  commonName: string;
  scientificName: string;
  alsoKnownAs: string[];
  metaTitle: string;
  metaDescription: string;
  /** ISO date — drives "last reviewed" + sitemap lastmod. */
  reviewed: string;
  summary: string;
  quickFacts: {
    water: string;
    light: string;
    difficulty: string;
    toxicity: string;
    humidity: string;
  };
  sections: {
    watering: string[];
    light: string[];
    problems: string[];
    /** The differentiator: keeping it alive in a shared home. */
    sharedCare: string[];
    /** Founder voice — one real opinion, light humour ok. */
    honestBit: string[];
  };
  faqs: { q: string; a: string }[];
}

export const CARE_GUIDES: CareGuide[] = [
  {
    slug: 'pothos',
    commonName: 'Pothos',
    scientificName: 'Epipremnum aureum',
    alsoKnownAs: ['Devil’s Ivy', 'Golden Pothos', 'Money Plant'],
    metaTitle: 'Pothos Care: How Often to Water (and Not Kill It)',
    metaDescription:
      'How often to water a pothos, how much light it needs, why the leaves go yellow, and how to keep one alive in a shared home.',
    reviewed: '2026-06-08',
    summary:
      'Pothos is the plant people mean when they say “I can’t keep anything alive, except this one.” It’s forgiving, fast-growing, and tells you clearly when something’s wrong — if you know what to look for.',
    quickFacts: {
      water: 'Every 7–10 days, when the top inch of soil is dry',
      light: 'Bright, indirect light. Tolerates low light (just grows slower)',
      difficulty: 'Very easy',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals)',
      humidity: 'Average household humidity is fine',
    },
    sections: {
      watering: [
        'Water a pothos roughly every 7–10 days — but the calendar is a starting point, not the rule. The real signal is the soil: stick a finger in, and if the top inch is dry, water it thoroughly until it drains out the bottom. If it’s still damp, wait.',
        'In winter, or in a low-light spot, it drinks less — stretch to every two weeks. In a bright window in summer, it may want water every 5–6 days. A pothos would rather be a touch too dry than too wet, so when in doubt, wait a day.',
      ],
      light: [
        'Bright, indirect light is the sweet spot — near a window, but out of direct midday sun, which scorches the leaves. The good news is pothos tolerates low light better than almost anything; it just grows slower and the variegation (the cream-and-green marbling) fades toward plain green.',
        'If the vines get long and sparse with big gaps between leaves, that’s “leggy” — it’s reaching for light. Move it brighter and the new growth tightens up.',
      ],
      problems: [
        'Yellow leaves are almost always overwatering. The instinct when a plant looks sad is to give it more water; with pothos, that’s usually the thing that’s hurting it. Let it dry out properly and the yellowing stops.',
        'Brown, crispy tips point the other way — underwatering, or very dry air. Crispy edges on an otherwise green leaf means it got too thirsty at some point.',
        'Limp, mushy stems at the soil line are root rot, the one genuinely dangerous problem, and it comes from sitting in soggy soil. Pothos forgives a missed watering; it does not forgive a pot with no drainage hole.',
      ],
      sharedCare: [
        'Here’s the thing nobody warns you about: pothos is so easy that everyone in the house assumes someone else is handling it. It limps along on neglect for weeks — which is exactly how it ends up dead. The failure mode isn’t a hard plant; it’s “I thought you watered it.”',
        'The fix is boring and it works: one person owns it, or you agree out loud who waters on which day. A shared note, a shared reminder, anything that turns “someone should” into “you, Thursday.” (This is the whole reason Family Greenhouse exists, but a whiteboard works too.)',
      ],
      honestBit: [
        'If you have killed every plant you’ve ever owned, start here and only here. A pothos cutting in a glass of water will grow roots on a windowsill with zero soil and zero expertise — it’s the closest thing to a confidence cheat code in houseplants.',
        'My one real opinion: skip the moisture meter. For a pothos it’s a gadget solving a problem your finger already solves for free. Save the money for a second plant.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a pothos?',
        a: 'About every 7–10 days, when the top inch of soil is dry. Less in winter or low light (every two weeks); more in a bright window in summer. When unsure, wait a day — it prefers slightly dry over soggy.',
      },
      {
        q: 'Why are my pothos leaves turning yellow?',
        a: 'Almost always overwatering. Let the soil dry out properly between waterings and make sure the pot drains. Yellowing from underwatering is rarer and usually comes with crispy brown edges.',
      },
      {
        q: 'Is pothos toxic to cats and dogs?',
        a: 'Yes — pothos contains calcium oxalate crystals that are toxic to cats and dogs if chewed, causing mouth irritation and drooling. Keep it out of reach of pets that nibble.',
      },
      {
        q: 'Can pothos survive in low light?',
        a: 'Yes, better than most houseplants. It just grows more slowly and the variegation fades toward solid green. Bright indirect light keeps it fuller and more colourful.',
      },
    ],
  },
  {
    slug: 'snake-plant',
    commonName: 'Snake Plant',
    scientificName: 'Dracaena trifasciata',
    alsoKnownAs: ['Sansevieria', 'Mother-in-Law’s Tongue'],
    metaTitle: 'Snake Plant Care: How Often to Water It (Hint: Less)',
    metaDescription:
      'How often to water a snake plant, the light it needs, why the leaves go mushy or wrinkled, and how to share its care without drowning it.',
    reviewed: '2026-06-08',
    summary:
      'The snake plant is as close to unkillable as houseplants get — and the one way people do kill it is kindness. It wants to be left alone, and most plant deaths here are an excess of attention, not a lack of it.',
    quickFacts: {
      water: 'Every 2–3 weeks; let the soil dry out completely first',
      light: 'Anything from low light to bright, indirect light',
      difficulty: 'Very easy — famously hard to kill',
      toxicity: 'Mildly toxic to cats and dogs if eaten',
      humidity: 'Dry household air is perfectly fine',
    },
    sections: {
      watering: [
        'Water a snake plant every 2–3 weeks, and only after the soil has dried out completely — not “mostly,” completely, all the way to the bottom of the pot. These are succulents; they store water in those stiff upright leaves and genuinely prefer drought to damp.',
        'In winter, back off to roughly once a month. The single most useful habit you can build with a snake plant is doing nothing — if you’re not sure whether it needs water, it almost certainly doesn’t.',
      ],
      light: [
        'Snake plants are unbothered by light. They’ll handle a dim hallway corner and a bright living-room window equally, which is why they end up in offices and bathrooms where nothing else survives. Bright indirect light makes them grow faster; low light just slows them down.',
        'The only thing to avoid is harsh, direct, all-day sun through glass, which can bleach the leaves. Other than that, put it where you want it.',
      ],
      problems: [
        'Soft, mushy, yellowing leaves at the base mean root rot — and root rot means too much water. This is the one real way to kill a snake plant. If you catch it early, stop watering, let it dry out hard, and it often recovers.',
        'Wrinkled or curling leaves are the rare opposite: it’s actually thirsty. Give it a proper soak and the leaves plump back up within a day or two.',
        'Leaves flopping over instead of standing upright usually means it’s been sitting in too-wet soil for too long, or the pot is too big and holds water it can’t use.',
      ],
      sharedCare: [
        'The snake plant’s superpower — needing almost nothing — is also the trap in a shared home. Two people who each “just topped it up” twice a month have, between them, watered a drought plant four times. The plant that’s nearly impossible to kill gets killed by teamwork.',
        'So the rule for a shared snake plant is the opposite of most plants: agree that exactly one person waters it, and everyone else keeps their watering can away from it. Less coordination, not more — just make sure the coordination is “hands off.”',
      ],
      honestBit: [
        'If you travel, rent, forget, or simply don’t want a plant to be a responsibility, this is the one. A snake plant will forgive a three-week trip without a sitter and look exactly the same when you get back, faintly judging you.',
        'My take: ignore the “it purifies your air” marketing. The famous NASA study used sealed lab chambers, not living rooms — you’d need a jungle to measure a difference. Buy it because it’s handsome and indestructible, not because it’s a humidifier with a marketing budget.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a snake plant?',
        a: 'Every 2–3 weeks, and only once the soil is completely dry. Drop to about once a month in winter. If you’re unsure, wait — overwatering is the main way snake plants die.',
      },
      {
        q: 'Why is my snake plant going soft and mushy?',
        a: 'That’s root rot from too much water. Stop watering, let the soil dry out fully, and remove any mushy leaves. Make sure the pot drains and isn’t oversized.',
      },
      {
        q: 'Can a snake plant live in low light?',
        a: 'Yes — it’s one of the few plants that genuinely tolerates a dim corner. It grows faster in bright indirect light but survives low light comfortably.',
      },
      {
        q: 'Are snake plants toxic to pets?',
        a: 'Mildly. If a cat or dog eats the leaves it can cause nausea and drooling. It’s not usually serious, but keep it away from pets that chew.',
      },
    ],
  },
  {
    slug: 'monstera',
    commonName: 'Monstera',
    scientificName: 'Monstera deliciosa',
    alsoKnownAs: ['Swiss Cheese Plant', 'Split-Leaf Philodendron'],
    metaTitle: 'Monstera Care: How Often to Water + Why No Leaf Holes',
    metaDescription:
      'How often to water a monstera, the light it needs to grow holes (fenestrations), why leaves yellow or brown, and sharing its care at home.',
    reviewed: '2026-06-08',
    summary:
      'The monstera is the plant everyone wants for those dramatic split leaves — and the one people are surprised they have to earn. The holes aren’t automatic; they’re a reward for getting the light right.',
    quickFacts: {
      water: 'Every 1–2 weeks, when the top 1–2 inches of soil are dry',
      light: 'Bright, indirect light — never harsh direct sun',
      difficulty: 'Easy to moderate',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalates)',
      humidity: 'Likes higher humidity but copes with average rooms',
    },
    sections: {
      watering: [
        'Water a monstera every 1–2 weeks, when the top inch or two of soil has dried out. Like most tropicals it wants a real drink — water until it runs from the drainage holes — and then a dry-down period before the next one. Soggy, never-quite-dry soil is what kills them.',
        'The interval drifts with the seasons: closer to weekly in bright, warm summer months, closer to every two weeks in winter. Let the soil, not the date, make the call.',
      ],
      light: [
        'Bright, indirect light is non-negotiable if you want the famous holes. Those splits — “fenestrations” — only develop when a monstera gets enough light and matures; a plant in a dim corner stays small with plain, solid, heart-shaped leaves and people wonder what they did wrong. The answer is almost always: more light.',
        'Keep it out of harsh direct sun through glass, which scorches the leaves. A few feet back from a bright window, or beside an east-facing one, is ideal.',
      ],
      problems: [
        'Yellow leaves usually mean overwatering — the same story as most houseplants. Check that the soil is drying between waterings and that the pot actually drains.',
        'Brown, crispy edges point to dry air or letting it get too thirsty. Monsteras like a bit more humidity than the average living room; a grouping of plants or the occasional misting helps, though it’s not essential.',
        'No splits on new leaves? That’s not a disease — it’s a light problem. A young monstera also simply isn’t old enough yet. Give it brighter light and time, and the new leaves come in with windows.',
      ],
      sharedCare: [
        'A monstera is a big, visible, second-living-room-member kind of plant — which is exactly why its care slips through the cracks in a shared home. It’s too established to look thirsty quickly, so “it seems fine” becomes everyone’s reason not to water it, right up until it isn’t fine.',
        'For a plant this slow to complain, the move is a shared schedule rather than vibes. Decide who checks the soil and when, so the monstera isn’t quietly relying on four people each assuming one of the others did it. (A plant this expensive is worth a reminder neither of you can ignore.)',
      ],
      honestBit: [
        'Unpopular opinion: most “my monstera won’t fenestrate” problems are light problems wearing a costume. People reach for humidifiers and fertiliser and moss poles when the plant just needs to be a metre closer to the window. Fix light first; fix everything else second.',
        'And the moss pole is genuinely worth it once the plant is a year or two in — monsteras are climbers, and a supported, climbing monstera produces bigger, holier leaves than one flopping over the side of its pot. That part of the hype is real.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a monstera?',
        a: 'Every 1–2 weeks, when the top 1–2 inches of soil are dry. Lean weekly in bright summer months and every two weeks in winter. Always let it drain — it hates sitting in water.',
      },
      {
        q: 'Why doesn’t my monstera have holes in its leaves?',
        a: 'Almost always not enough light, or the plant is still young. The famous splits (fenestrations) develop as a monstera matures in bright, indirect light. Move it brighter and give it time.',
      },
      {
        q: 'Why are my monstera’s leaves turning yellow?',
        a: 'Usually overwatering. Let the top inch or two of soil dry between waterings and confirm the pot drains. Brown crispy edges, by contrast, mean dry air or underwatering.',
      },
      {
        q: 'Is a monstera toxic to cats and dogs?',
        a: 'Yes — monstera contains calcium oxalate crystals that are toxic to cats and dogs if chewed, causing mouth irritation and drooling. Keep it away from pets that nibble leaves.',
      },
    ],
  },
];

export function findCareGuide(slug: string): CareGuide | undefined {
  return CARE_GUIDES.find((g) => g.slug === slug);
}
