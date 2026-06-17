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
  {
    slug: 'spider-plant',
    commonName: 'Spider Plant',
    scientificName: 'Chlorophytum comosum',
    alsoKnownAs: ['Airplane Plant', 'Ribbon Plant', 'Spider Ivy'],
    metaTitle: 'Spider Plant Care: How Often to Water + Why Brown Tips',
    metaDescription:
      'How often to water a spider plant, the light it likes, why the leaf tips go brown, and what to do with all the babies it keeps making.',
    reviewed: '2026-06-12',
    summary:
      'The spider plant forgives missed waterings, shrugs off ordinary light, and hands you free copies of itself. Its one famous complaint, brown leaf tips, is usually about what’s in your tap water, not about your skill.',
    quickFacts: {
      water: 'About once a week, when the top inch of soil is dry; less in winter',
      light: 'Bright, indirect light is ideal; tolerates moderate light',
      difficulty: 'Very easy',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA), though cats love chewing it',
      humidity: 'Average household humidity is fine; very dry air browns the tips',
    },
    sections: {
      watering: [
        'Water a spider plant about once a week, when the top inch of soil has dried out. It stores water in thick, tuberous roots, so a missed week is a non-event: the leaves go a little flat and pale, then stand back up within hours of a drink, no grudge held. When you do water, do it properly, until it runs from the drainage holes.',
        'In winter, stretch the interval to every 10–14 days. The real danger runs the other way: those water-storing roots rot in soil that never dries, and a rotted spider plant is much harder to save than a thirsty one. If you’re not sure it needs water, wait a day or two.',
      ],
      light: [
        'Bright, indirect light keeps a spider plant full, crisply striped, and making babies. It also copes fine with a moderately lit room a few feet from the window; it just grows slower there, and the variegated kinds lose some of their cream stripe.',
        'What it can’t take is harsh direct sun through glass, which bleaches the leaves and scorches the tips. An east window, or anywhere bright without a direct beam, is the sweet spot. There’s a reason this is the classic hanging-basket plant.',
      ],
      problems: [
        'Brown leaf tips are the spider plant complaint, and the usual culprits are the fluoride and chlorine in tap water, or very dry air. Switching to distilled, filtered, or rain water fixes it for most people. Existing brown tips never turn green again; snip them off at an angle and the plant looks fine.',
        'Yellow, limp leaves and mush at the base mean overwatering. The tuberous roots are a built-in water tank, and topping up a full tank rots it. Let the soil dry out fully and make sure the pot actually drains.',
        'No babies? A spider plant only sends out runners when it’s mature, slightly root-bound, and getting decent light. A young plant in a dim corner and a roomy pot has no reason to reproduce. Snug pot, brighter spot, patience.',
      ],
      sharedCare: [
        'The spider plant is unusually good at shared care because it asks out loud: when it’s thirsty, the leaves visibly droop and dull, and they perk up within hours of watering. That makes “does it need water?” a question anyone in the house can answer at a glance, which is more than you can say for almost any other plant on this list.',
        'The babies are the other superpower. Each plantlet roots in a glass of water in a week or two, so one healthy plant becomes a windowsill of starter plants for kids, housemates, and the friend who swears they kill everything. (Family Greenhouse can track whose plant each one becomes once it’s potted up, but a labelled jam jar does the job too.)',
      ],
      honestBit: [
        'My take: this is the best first plant for a household with kids or cats, full stop. It’s non-toxic, it bounces back from neglect, and a child who rooted their own spiderette in a jam jar will water it without being asked. That’s not true of a single other beginner plant I can name.',
        'And ignore anyone who calls it dated. The spider plant got filed under “grandma plant” because it’s been quietly surviving in kitchens since the seventies — that’s not a fashion problem, that’s a track record.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a spider plant?',
        a: 'About once a week, when the top inch of soil is dry, stretching to every 10–14 days in winter. Its tuberous roots store water, so it forgives a late watering far better than a constantly wet pot.',
      },
      {
        q: 'Why are my spider plant’s leaf tips turning brown?',
        a: 'Usually fluoride and chlorine in tap water, or very dry air. Switch to distilled, filtered, or rain water and new growth comes in clean. Snip existing brown tips off at an angle; they don’t recover.',
      },
      {
        q: 'Are spider plants safe for cats and dogs?',
        a: 'Yes. The ASPCA lists spider plants as non-toxic to both cats and dogs. Cats do love chewing the dangling leaves, which hurts the plant more than the cat, so hang it up if yours won’t leave it alone.',
      },
      {
        q: 'How do I propagate spider plant babies (spiderettes)?',
        a: 'Snip a plantlet off the runner and sit its base in a glass of water; roots show within a week or two. Or pin it into a pot of soil while still attached and cut the runner once it takes. Either way works almost every time.',
      },
    ],
  },
  {
    slug: 'peace-lily',
    commonName: 'Peace Lily',
    scientificName: 'Spathiphyllum',
    alsoKnownAs: ['Spath', 'Closet Plant', 'White Sail Plant'],
    metaTitle: 'Peace Lily Care: How Often to Water + Are They Toxic?',
    metaDescription:
      'How often to water a peace lily, the light it actually wants, why the leaves droop or brown, and whether it’s safe around cats and dogs.',
    reviewed: '2026-06-17',
    summary:
      'The peace lily is the rare plant that tells you out loud when it’s thirsty — it wilts dramatically, then springs back within hours of a drink. That theatrical droop makes it one of the easiest plants to read, and one of the most over-watered when people panic at the first sad leaf.',
    quickFacts: {
      water: 'About once a week, when the top inch of soil is dry; it wilts to warn you',
      light: 'Medium to bright, indirect light; tolerates low light but flowers less',
      difficulty: 'Easy',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals)',
      humidity: 'Likes higher humidity; brown tips in very dry rooms',
    },
    sections: {
      watering: [
        'Water a peace lily about once a week, when the top inch of soil has dried. Its party trick is the wilt: when it’s genuinely thirsty the whole plant droops and looks half-dead, then recovers within a few hours of watering. That makes it easy to read — but don’t use the droop as your only signal, because repeated dramatic wilts stress the plant over time.',
        'It drinks less in winter and in lower light, so check the soil rather than counting days. The plant prefers steady, lightly moist soil to a hard drought-then-flood cycle, but it will not forgive sitting in a saucer of water — that’s root rot, the one thing it doesn’t bounce back from.',
      ],
      light: [
        'Medium to bright, indirect light is the sweet spot. The peace lily earns its reputation as a low-light plant because it survives a dim corner, but “survives” and “flowers” are different things: in low light it stays green and healthy but rarely produces the white blooms people buy it for.',
        'Keep it out of direct sun, which scorches the broad leaves into brown patches. A few feet back from a bright window, or beside a north or east one, gives you the best shot at flowers without burning the foliage.',
      ],
      problems: [
        'Drooping leaves are usually just thirst — water it and watch it recover. If it droops even when the soil is wet, that’s the opposite problem: overwatering and the start of root rot. Check the soil before you reach for the watering can, because the same wilt has two opposite causes.',
        'Brown leaf tips point to dry air, or to fluoride and salts in tap water. Peace lilies are sensitive to both; switching to filtered or distilled water and nudging up the humidity usually settles it. Snip the brown off at an angle — it won’t turn green again.',
        'No flowers is almost always a light problem. A peace lily in a dark corner stays leafy and never blooms. Move it somewhere brighter (still indirect) and the white spathes tend to follow.',
      ],
      sharedCare: [
        'The peace lily is a gift in a shared home because it asks for help in a language everyone understands: when it needs water, it flops. Anyone walking past can see it and act, which is more than you can say for the plants that look fine right up until they’re dead.',
        'The trap is the same droop working against you. If three people each see the wilt and each water it, the plant gets watered three times and rots. So the rule is one waterer, or a shared note of who did it last — let the plant’s honesty work for you instead of triggering a pile-on. (Family Greenhouse logs who watered and when, but a sticky note on the pot does the same job.)',
      ],
      honestBit: [
        'My take: the name does this plant a disservice. People hear “lily,” assume it’s the cat-killer their vet warned them about, and either avoid it or panic. It isn’t a true lily at all — it won’t cause the kidney failure that real lilies (Lilium) do. It’s toxic in the ordinary mouth-irritation way, which is worth knowing but isn’t the emergency the name implies.',
        'If you want to be sure about any plant before it comes home to a pet, run it through the free pet-safe checker at /pet-safe first — two seconds, no signup, and it spells out cats versus dogs rather than a vague “toxic.”',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a peace lily?',
        a: 'About once a week, when the top inch of soil is dry — and it’ll wilt dramatically to tell you when it’s thirsty, recovering within hours of a drink. Less in winter and low light. Don’t let it sit in standing water, which causes root rot.',
      },
      {
        q: 'Why is my peace lily drooping?',
        a: 'Usually thirst — water it and it perks up within hours. But if it droops while the soil is still wet, that’s overwatering and early root rot. Always check the soil first, because the same droop has two opposite causes.',
      },
      {
        q: 'Are peace lilies toxic to cats and dogs?',
        a: 'Yes. Peace lilies contain calcium oxalate crystals that are toxic to cats and dogs if chewed, causing mouth and throat irritation, drooling, and trouble swallowing. Despite the name it is NOT a true lily, so it won’t cause the kidney failure real lilies do — but keep it away from pets. You can confirm any plant at the free checker at /pet-safe.',
      },
      {
        q: 'Why won’t my peace lily flower?',
        a: 'Almost always not enough light. Peace lilies survive low light but only bloom in medium to bright, indirect light. Move it brighter (out of direct sun) and the white flowers usually follow.',
      },
    ],
  },
  {
    slug: 'heartleaf-philodendron',
    commonName: 'Heartleaf Philodendron',
    scientificName: 'Philodendron hederaceum',
    alsoKnownAs: ['Sweetheart Plant', 'Philodendron', 'Philodendron scandens'],
    metaTitle: 'Heartleaf Philodendron Care: Watering, Light + Toxicity',
    metaDescription:
      'How often to water a heartleaf philodendron, the light it likes, why the leaves yellow or go leggy, and whether it’s safe around pets.',
    reviewed: '2026-06-17',
    summary:
      'The heartleaf philodendron is the plant people confuse with pothos, and for good reason — same trailing habit, same near-indestructible temperament, same forgiving nature. It’s one of the genuinely easy ones, and a great vine for a beginner who wants something prettier than they had to work for.',
    quickFacts: {
      water: 'Every 7–10 days, when the top inch of soil is dry',
      light: 'Bright, indirect light; tolerates lower light (grows slower)',
      difficulty: 'Very easy',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals)',
      humidity: 'Average household humidity is fine; enjoys a little more',
    },
    sections: {
      watering: [
        'Water a heartleaf philodendron every 7–10 days, when the top inch of soil has dried. Like pothos, it would rather be a touch dry than soggy, so the soil — not the calendar — makes the call: finger in, water thoroughly if the top inch is dry, wait if it’s still damp.',
        'It drinks less in winter and in lower light; stretch toward every two weeks then. The one reliable way to kill it is a pot that never drains, so when you’re unsure, give it another day rather than another splash.',
      ],
      light: [
        'Bright, indirect light keeps it full and fast-growing, with leaves close together along the vine. It tolerates lower light better than most plants — that’s why it ends up on shelves and in bathrooms — but it grows slower and leggier there.',
        'Keep it out of harsh direct sun, which scorches the thin leaves. If the vine gets sparse with long gaps between leaves, that’s a light signal: move it brighter and the new growth tightens up.',
      ],
      problems: [
        'Yellow leaves are usually overwatering, the same story as most trailing plants. Let the soil dry between waterings and confirm the pot drains. A single old leaf yellowing low on the vine is normal ageing, not a problem.',
        'Brown, crispy tips point the other way — too dry, or very dry air. A miss here and there is fine; consistent crisping means it’s getting too thirsty or the room is parched.',
        'Long, bare, leggy vines mean it’s reaching for light. Move it brighter, and pinch the growing tips to push it to branch and fill out rather than race for the window.',
      ],
      sharedCare: [
        'The heartleaf philodendron has the same shared-home trap as pothos: it’s so easy that everyone assumes someone else is handling it, and it limps along on neglect until it doesn’t. The failure mode isn’t a difficult plant — it’s “I thought you watered it.”',
        'The fix is unglamorous and reliable: one named owner, or an out-loud agreement about who waters on which day. The cuttings root in a glass of water in a week or two, so it’s also a great plant to split between housemates — everyone gets a start, everyone has a reason to keep theirs alive. (Family Greenhouse can track whose vine each cutting becomes, but a labelled jar works too.)',
      ],
      honestBit: [
        'My take: if you already have a pothos and want a second easy vine that looks a bit more refined, this is the one to get — the heart-shaped leaves are softer and tidier, and it’s every bit as forgiving. Don’t agonise over telling them apart; care for them identically and both will thrive.',
        'It is, however, toxic to cats and dogs if chewed — the whole philodendron genus carries calcium oxalate crystals. A trailing vine is exactly the kind of dangling temptation a cat bats at, so hang it high. If you’re weighing it against a pet-safe pick, the free checker at /pet-safe gives you the cats-versus-dogs answer in a couple of seconds.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a heartleaf philodendron?',
        a: 'Every 7–10 days, when the top inch of soil is dry. Less in winter or lower light (toward every two weeks). It prefers slightly dry over soggy, so when in doubt, wait a day and make sure the pot drains.',
      },
      {
        q: 'What’s the difference between a philodendron and a pothos?',
        a: 'They look alike and are cared for identically. Heartleaf philodendron leaves are thinner, softer, and a deeper matte green with a more pointed heart shape; pothos leaves are thicker, glossier, and often variegated. For watering and light, treat them the same.',
      },
      {
        q: 'Is a heartleaf philodendron toxic to cats and dogs?',
        a: 'Yes. Philodendrons contain calcium oxalate crystals that are toxic to cats and dogs if chewed, causing mouth irritation, drooling, and vomiting. It’s a trailing vine that pets bat at, so hang it out of reach. Check any plant at the free pet-safe tool at /pet-safe.',
      },
      {
        q: 'Why is my philodendron getting leggy?',
        a: 'Long, bare vines with big gaps between leaves mean it’s reaching for light. Move it somewhere brighter (still indirect) and pinch the growing tips to encourage it to branch and fill out.',
      },
    ],
  },
  {
    slug: 'zz-plant',
    commonName: 'ZZ Plant',
    scientificName: 'Zamioculcas zamiifolia',
    alsoKnownAs: ['Zanzibar Gem', 'Zamioculcas', 'ZZ'],
    metaTitle: 'ZZ Plant Care: How Often to Water (Almost Never)',
    metaDescription:
      'How often to water a ZZ plant, the light it tolerates, why the stems go yellow or mushy, and whether it’s safe around cats and dogs.',
    reviewed: '2026-06-17',
    summary:
      'The ZZ plant is the one you buy when you’ve decided you’re bad with plants. Thick underground rhizomes store water for weeks, the glossy leaves shrug off dim light, and the only real way to kill it is to care too much. It’s as close to a houseplant you can ignore as exists.',
    quickFacts: {
      water: 'Every 2–3 weeks; let the soil dry out completely first',
      light: 'Low to bright, indirect light — tolerates almost anything',
      difficulty: 'Very easy — famously hard to kill',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals)',
      humidity: 'Dry household air is perfectly fine',
    },
    sections: {
      watering: [
        'Water a ZZ plant every 2–3 weeks, and only once the soil has dried out completely — all the way down, not just the surface. Those potato-like rhizomes under the soil are water tanks, so the plant runs happily on its reserves between drinks. Topping up a full tank is how you rot it.',
        'In winter, drop to roughly once a month. The single most useful habit with a ZZ is doing nothing: if you’re not sure whether it needs water, it almost certainly doesn’t. When in genuine doubt, wait another week.',
      ],
      light: [
        'ZZ plants tolerate a huge range of light, from a dim office corner to a bright indirect window. That adaptability is why they end up in lobbies and windowless bathrooms where nothing else survives. Brighter (indirect) light just makes them grow faster and fuller.',
        'The one thing to avoid is harsh, direct, all-day sun through glass, which can scorch the glossy leaves. Other than that, put it where you want it and it’ll cope.',
      ],
      problems: [
        'Yellowing stems and leaves, especially with a soft mushy base, mean overwatering and rhizome rot — the one genuine way to kill a ZZ. Stop watering, let it dry out hard, and check the rhizomes are firm rather than soft. Caught early, it often recovers.',
        'Wrinkled stems or curling leaflets are the rare opposite: it’s actually thirsty, which takes real neglect to achieve. A proper soak fixes it within a day or two.',
        'A few yellow lower leaves on an otherwise firm plant are usually just normal ageing. It’s the soft, mushy, spreading kind of yellowing you watch for, not the occasional dropped leaf.',
      ],
      sharedCare: [
        'The ZZ’s superpower — needing almost nothing — is also its shared-home trap. Two people who each “just topped it up” twice a month have, between them, watered a drought plant four times, and a ZZ killed by enthusiasm is far more common than one killed by neglect.',
        'So the rule here is the opposite of fussier plants: agree that one person waters it, and everyone else keeps their watering can away. Less coordination, not more — the coordination you want is simply “hands off, it’s fine.”',
      ],
      honestBit: [
        'My take: the ZZ’s “toxic” reputation is overblown in one direction and underplayed in another. It won’t poison your pet from across the room — the danger is only if a pet actually chews it, and then it’s the ordinary mouth-irritation kind, not an emergency. But the sap can also irritate human skin, so wash your hands after pruning or repotting it.',
        'If you’re choosing a near-indestructible plant for a home with curious pets, weigh it against something genuinely pet-safe rather than just hardy. The free checker at /pet-safe lays out the cats-versus-dogs verdict for the ZZ and its safer alternatives in a couple of seconds.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a ZZ plant?',
        a: 'Every 2–3 weeks, and only once the soil is completely dry — drop to about once a month in winter. Its rhizomes store water, so it tolerates drought far better than overwatering. When unsure, wait; overwatering is the main way ZZ plants die.',
      },
      {
        q: 'Why is my ZZ plant turning yellow?',
        a: 'Soft, mushy yellowing at the base is overwatering and rhizome rot — the main ZZ killer. Stop watering, let it dry out fully, and check the rhizomes are firm. A few yellow lower leaves on an otherwise healthy plant are just normal ageing.',
      },
      {
        q: 'Is a ZZ plant toxic to cats and dogs?',
        a: 'Yes. ZZ plants contain calcium oxalate crystals that are toxic to cats and dogs if chewed, causing mouth irritation, drooling, and vomiting. Its reputation overstates the danger — a nibble means an unhappy pet, not an emergency — but the sap can irritate skin too, so wash your hands after handling. Confirm any plant at the free tool at /pet-safe.',
      },
      {
        q: 'Can a ZZ plant survive in low light?',
        a: 'Yes — it’s one of the most light-tolerant houseplants there is, surviving dim offices and windowless rooms. It grows faster and fuller in bright, indirect light, but low light just slows it down rather than harming it.',
      },
    ],
  },
  {
    slug: 'aloe-vera',
    commonName: 'Aloe Vera',
    scientificName: 'Aloe vera',
    alsoKnownAs: ['Medicine Plant', 'Burn Plant', 'Aloe'],
    metaTitle: 'Aloe Vera Care: How Often to Water + Is It Pet-Safe?',
    metaDescription:
      'How often to water an aloe vera, the light it needs, why it goes mushy or brown, and whether the plant is safe around cats and dogs.',
    reviewed: '2026-06-17',
    summary:
      'Aloe vera is a succulent that thinks it lives in a desert, because it does. Treat it like a cactus — bright light, deep but rare watering — and it’s nearly carefree. Treat it like a leafy tropical and you’ll drown it in a month. Most aloe deaths are kindness, not neglect.',
    quickFacts: {
      water: 'Every 2–3 weeks; soak fully, then let the soil dry out completely',
      light: 'Bright light, including some direct sun',
      difficulty: 'Easy, if you under-water it',
      toxicity: 'Toxic to cats and dogs if eaten (the leaf, not the inner gel)',
      humidity: 'Dry household air is ideal — it hates damp',
    },
    sections: {
      watering: [
        'Water an aloe every 2–3 weeks: soak the soil thoroughly so it runs out the bottom, then leave it completely alone until the soil is bone dry all the way down. This “drench and dry” rhythm mimics the desert downpours it evolved for, and it’s the whole secret to a happy aloe.',
        'In winter, back right off — once a month or even less. Aloe stores water in those plump leaves, so a missed watering is a non-event; a too-frequent one is fatal. Plant it in gritty, fast-draining cactus mix, never ordinary potting soil that stays soggy.',
      ],
      light: [
        'Aloe wants the brightest spot you’ve got — a sunny south or west window is ideal, and it’ll take a few hours of direct sun happily once it’s used to it. In a dim corner it stretches, pales, and flops, with leaves splaying outward instead of standing up.',
        'If you move it from indoors into strong outdoor sun suddenly, it can sunburn (brown or reddish patches). Step it up gradually over a week or two. Indoors, a bright windowsill is hard to beat.',
      ],
      problems: [
        'Mushy, translucent, or brown leaves at the base mean overwatering and rot — by far the most common way aloe dies. Stop watering, let it dry out hard, and repot into gritty mix if the soil stays wet. Soft leaves are almost never thirst.',
        'Thin, curled, or puckered leaves are the genuine thirst signal, and it takes real neglect to get there. A proper soak plumps them back up within a few days.',
        'Pale, stretched, flopping growth means not enough light. Aloe leaves should be firm and upright; when they splay out and lean, move it to your sunniest window.',
      ],
      sharedCare: [
        'Aloe is a classic “killed by teamwork” plant in a shared home. Because it needs watering so rarely, two well-meaning people each giving it an occasional drink adds up to a soggy, rotting succulent. The plant that asks for almost nothing gets too much from too many hands.',
        'The fix is to make “leave it alone” the explicit plan: one person waters it, on a long interval, and everyone else admires it from a distance with the watering can elsewhere. For a plant this drought-loving, good shared care mostly means agreeing not to help.',
      ],
      honestBit: [
        'My take: keep one in the kitchen — snapping off a leaf for the cool gel inside really does take the sting out of a minor burn, and that’s a genuinely useful plant to have within reach. Just don’t over-love it; the number-one cause of a dead aloe is a watering schedule meant for a fern.',
        'Worth being clear on the pet question, because the “medicine plant” reputation misleads people: the soothing gel is fine, but the leaf’s outer layer contains compounds that are toxic to cats and dogs if eaten, causing vomiting and lethargy. Keep the plant itself out of reach. The free pet-safe checker at /pet-safe spells out the cats-versus-dogs verdict if you want to double-check.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an aloe vera?',
        a: 'Every 2–3 weeks: soak it thoroughly, then let the soil dry out completely before the next drink. Once a month or less in winter. Plant it in gritty, fast-draining cactus mix — overwatering is the main way aloe dies.',
      },
      {
        q: 'Why is my aloe vera going mushy or brown?',
        a: 'Mushy, translucent leaves mean overwatering and rot — the most common aloe problem. Stop watering, let it dry out fully, and repot into gritty mix if the soil stays soggy. Brown sunburn patches, by contrast, come from sudden strong direct sun.',
      },
      {
        q: 'Is aloe vera toxic to cats and dogs?',
        a: 'Yes — the plant is toxic to cats and dogs if eaten. The clear inner gel is fine, but the leaf’s outer layer contains saponins and anthraquinones that cause vomiting, lethargy, and diarrhoea. Keep the plant out of reach even though aloe gel is a human first-aid staple. Check any plant at the free tool at /pet-safe.',
      },
      {
        q: 'Why is my aloe vera flopping over?',
        a: 'Pale, stretched, splaying leaves mean too little light. Aloe wants a bright, sunny window; in a dim spot it stretches and flops. Move it to your sunniest spot and new growth comes in firm and upright.',
      },
    ],
  },
  {
    slug: 'dieffenbachia',
    commonName: 'Dieffenbachia',
    scientificName: 'Dieffenbachia',
    alsoKnownAs: ['Dumb Cane', 'Leopard Lily'],
    metaTitle: 'Dieffenbachia (Dumb Cane) Care: Watering, Light + Toxicity',
    metaDescription:
      'How often to water a dieffenbachia, the light it likes, why the leaves yellow or brown, and why it’s one to keep away from pets and kids.',
    reviewed: '2026-06-17',
    summary:
      'Dieffenbachia gives you big, splashy, tropical leaves for not much effort — a lot of visual payoff for an easy plant. The catch is in the old name, dumb cane: its sap is among the harsher of the common houseplants, so it’s a striking plant that comes with a real keep-out-of-reach asterisk.',
    quickFacts: {
      water: 'Every 7–10 days, when the top inch of soil is dry',
      light: 'Bright, indirect light; tolerates medium light',
      difficulty: 'Easy to moderate',
      toxicity: 'Toxic to cats, dogs, and people if chewed (calcium oxalate crystals)',
      humidity: 'Prefers higher humidity; browns at the edges in dry rooms',
    },
    sections: {
      watering: [
        'Water a dieffenbachia every 7–10 days, when the top inch of soil has dried. It likes its soil lightly and evenly moist — not bone-dry like a succulent, not waterlogged like a swamp. Water thoroughly until it drains, then let the top inch dry before the next round.',
        'It drinks less in winter and in lower light, so let the soil guide you rather than the calendar. The usual killer is overwatering: soggy soil rots the thick stem from the base up, and a rotted dieffenbachia is hard to bring back.',
      ],
      light: [
        'Bright, indirect light keeps the leaf markings bold and the plant compact. It tolerates medium light but grows leggier and paler there, leaning toward the window. Direct sun scorches the big soft leaves into bleached or brown patches, so keep it back from a hot windowsill.',
        'If it’s stretching and the lower leaves are dropping, that’s usually a reach for light — move it brighter (still indirect) and rotate it now and then so it grows evenly rather than leaning.',
      ],
      problems: [
        'Yellow lower leaves usually mean overwatering; let the soil dry more between drinks and confirm the pot drains. A soft, mushy, darkening stem base is stem rot — the serious version of the same problem, and a reason to cut back hard on water immediately.',
        'Brown, crispy leaf edges point to dry air, underwatering, or cold drafts. Dieffenbachia likes a bit more humidity than the average room and dislikes sitting near a cold window or an air-conditioning vent.',
        'Drooping that doesn’t recover after watering, especially with a soft base, is stem rot rather than thirst. Caught early, you can sometimes save the plant by cutting above the rot and re-rooting a healthy section of cane.',
      ],
      sharedCare: [
        'In a shared home, dieffenbachia’s steady, even-moisture preference makes a shared schedule worthwhile — it doesn’t wilt theatrically like a peace lily, so it can quietly drift into too-dry or too-wet without anyone clocking it until the leaves complain. Agree who checks the soil and when, so it isn’t silently relying on four people who each assume someone else did it.',
        'The bigger shared-home point with this one is placement, not watering. Its sap is genuinely irritating, so in a house with pets or small children the right move is to put it somewhere nobody chews or grabs it — high shelf, out of reach — and make that a deliberate, agreed decision rather than wherever it happened to land.',
      ],
      honestBit: [
        'My take: this is a beautiful plant I’d happily recommend to a household with no pets and no toddlers, and one I’d steer clear of for anyone with either. The “dumb cane” name is a blunt warning — chewing the cane can numb and swell the mouth and throat badly enough to affect speech and, in bad cases, breathing. That’s a step beyond the mild mouth-irritation most houseplants cause.',
        'If you’re not sure a plant is right for your home, that’s exactly what the free pet-safe checker at /pet-safe is for — it gives you a plain cats-versus-dogs verdict in a couple of seconds, and points you to genuinely safe alternatives if dieffenbachia is the wrong fit.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a dieffenbachia?',
        a: 'Every 7–10 days, when the top inch of soil is dry. It likes lightly, evenly moist soil — not bone-dry, not soggy. Less in winter and lower light. Overwatering rots the stem base, so let the top inch dry between waterings and make sure the pot drains.',
      },
      {
        q: 'Why are my dieffenbachia leaves turning yellow?',
        a: 'Usually overwatering — yellow lower leaves with a soft, mushy stem base mean stem rot. Cut back on water and check drainage. Brown crispy edges, by contrast, point to dry air, underwatering, or cold drafts.',
      },
      {
        q: 'Is dieffenbachia toxic to cats, dogs, and people?',
        a: 'Yes — it’s toxic to cats, dogs, and humans if chewed. The calcium oxalate crystals are among the harsher of the common houseplants, causing intense mouth and throat pain, drooling, and sometimes enough swelling to affect breathing (hence the old name “dumb cane”). Keep it firmly out of reach of pets and children. Check any plant at the free tool at /pet-safe.',
      },
      {
        q: 'Why is my dieffenbachia leggy and leaning?',
        a: 'It’s reaching for light. Move it to a brighter (still indirect) spot and rotate the pot regularly so it grows evenly. Dropping lower leaves while stretching is the same light signal.',
      },
    ],
  },
  {
    slug: 'calathea',
    commonName: 'Calathea',
    scientificName: 'Goeppertia (formerly Calathea)',
    alsoKnownAs: ['Prayer Plant', 'Rattlesnake Plant', 'Peacock Plant', 'Goeppertia'],
    metaTitle: 'Calathea Care: How Often to Water + Are They Pet-Safe?',
    metaDescription:
      'How often to water a calathea, the humidity and water quality it demands, why the leaves curl or crisp, and why it’s a pet-safe choice.',
    reviewed: '2026-06-17',
    summary:
      'Calatheas have the most beautiful foliage of any common houseplant and the shortest temper. The trade-off is honest: stunning patterned leaves that fold up at night like praying hands, in exchange for fussiness about water, humidity, and what comes out of your tap. The pay-off, if you want it, is real.',
    quickFacts: {
      water: 'Keep lightly, evenly moist; water when the top half-inch is dry',
      light: 'Medium, indirect light; never direct sun',
      difficulty: 'Moderate to fussy',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'High humidity is essential; dry air crisps the edges fast',
    },
    sections: {
      watering: [
        'Calatheas want their soil kept lightly and evenly moist — not soggy, not dried out. Water when the top half-inch is dry, which usually lands somewhere around every 5–7 days, more often in summer and warmth. Unlike most plants on this site, you can’t just let it dry out hard between drinks; a full dry-out browns the edges and the leaves curl in protest.',
        'The catch is water quality. Calatheas are notably sensitive to the fluoride, chlorine, and salts in tap water, which show up as brown leaf edges. Filtered, distilled, or rainwater makes a real difference — for this plant it’s not fussiness, it’s the single biggest fix for the most common complaint.',
      ],
      light: [
        'Medium, indirect light is the sweet spot. Calatheas grow on the shaded forest floor, so direct sun is actively harmful — it bleaches the patterns and scorches the leaves, washing out the very colours you bought it for. An east window, or a few feet back from a brighter one, suits them.',
        'Too little light, though, and the markings fade and the plant sulks. Bright but indirect, with no direct beam ever hitting the leaves, keeps the patterns vivid. The nightly leaf-folding (the “prayer plant” move) is normal and a good sign the plant is happy.',
      ],
      problems: [
        'Brown, crispy leaf edges are the signature calathea complaint, and the usual culprits are dry air and tap water. Raise the humidity and switch to filtered or distilled water; existing brown edges won’t turn green again, so trim them and judge by the new growth.',
        'Curling leaves that don’t unfurl by day mean it’s too dry — either thirsty soil or parched air. A good drink and more humidity usually relax them. (A gentle nightly curl that opens each morning, by contrast, is just the plant’s normal rhythm.)',
        'Yellowing leaves point to overwatering or soggy soil — the line between “evenly moist” and “waterlogged” is narrow with calatheas. Make sure the pot drains and the soil isn’t staying wet for days.',
      ],
      sharedCare: [
        'Calathea is the high-maintenance member of a shared collection, so it benefits most from one clear owner rather than a committee. Its needs are specific — filtered water, steady moisture, real humidity — and they’re easy to get wrong when several people each do their own version of “looking after it.”',
        'If you do share it, the thing to write down isn’t just when it was watered but how: filtered water, not tap. A grouping with other plants, or a spot in a naturally humid room like a bright bathroom, does a lot of the humidity work for you and takes some pressure off the schedule. (Family Greenhouse can hold those care notes against the plant so they don’t live only in one person’s head.)',
      ],
      honestBit: [
        'My take: the good news that makes calathea worth the trouble — it’s genuinely pet-safe. The ASPCA lists calatheas as non-toxic to both cats and dogs, which is rare for a plant this showy. If you’ve got a leaf-chewing cat and you’re tired of hanging everything out of reach, a calathea is one of the few statement plants you can put at floor level without worry.',
        'So the honest pitch is this: calathea asks more of you than almost anything else here, but it pays you back with both the best foliage and a clean bill of health for your pets. If pet safety is the deciding factor, the free checker at /pet-safe confirms it — and lists other safe choices if you’d rather start with something more forgiving.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a calathea?',
        a: 'Keep the soil lightly and evenly moist — water when the top half-inch is dry, usually every 5–7 days. Don’t let it dry out hard like a succulent, and don’t leave it soggy. Use filtered, distilled, or rainwater, since calatheas are sensitive to tap-water chemicals.',
      },
      {
        q: 'Why are my calathea’s leaves turning brown and crispy at the edges?',
        a: 'The two usual causes are dry air and minerals (fluoride, chlorine, salts) in tap water. Raise the humidity and switch to filtered or distilled water. Existing brown edges won’t recover — trim them and watch the new growth come in clean.',
      },
      {
        q: 'Are calatheas toxic to cats and dogs?',
        a: 'No — calatheas are non-toxic to both cats and dogs per the ASPCA, making them one of the few genuinely pet-safe statement plants. A big mouthful might cause a mild upset like any plant, but there’s nothing poisonous in it. You can confirm this and find other safe plants at the free tool at /pet-safe.',
      },
      {
        q: 'Why are my calathea leaves curling?',
        a: 'Curling that doesn’t open by day means it’s too dry — thirsty soil or parched air. Water it and raise the humidity. A gentle nightly curl that opens each morning is normal: it’s the “prayer plant” rhythm and a sign the plant is healthy.',
      },
    ],
  },
];

export function findCareGuide(slug: string): CareGuide | undefined {
  return CARE_GUIDES.find((g) => g.slug === slug);
}
