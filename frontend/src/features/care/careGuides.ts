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
  {
    slug: 'fiddle-leaf-fig',
    commonName: 'Fiddle Leaf Fig',
    scientificName: 'Ficus lyrata',
    alsoKnownAs: ['Fiddle-Leaf Fig', 'Banjo Fig', 'Ficus lyrata'],
    metaTitle: 'Fiddle Leaf Fig Care: Watering + Why It Drops Leaves',
    metaDescription:
      'How often to water a fiddle leaf fig, the light it actually needs, why the leaves get brown spots or drop, and how to keep one alive in a shared home.',
    reviewed: '2026-09-02',
    summary:
      'The fiddle leaf fig is the most photographed and most returned houseplant there is. It isn’t difficult so much as inflexible: it wants one bright spot and the same routine every week, and it registers a complaint about anything else.',
    quickFacts: {
      water: 'Every 7–10 days, when the top 2 inches of soil are dry',
      light: 'Bright light, including a few hours of direct morning sun',
      difficulty: 'Moderate — fussy about change, not about care',
      toxicity: 'Toxic to cats and dogs if chewed (the ASPCA lists Ficus species as toxic)',
      humidity: 'Prefers moderate humidity; dislikes cold draughts more',
    },
    sections: {
      watering: [
        'Water a fiddle leaf fig roughly every 7–10 days, once the top two inches of soil have gone dry. Water thoroughly — until it runs out of the drainage hole — then let it drain properly and tip away whatever is left in the saucer. Half-hearted splashes wet only the top of the pot and leave the roots at the bottom bone dry.',
        'The thing that kills them is inconsistency, not the interval. A big drink one week, nothing for three, then a panic-soak is far worse than a slightly wrong schedule kept steadily. In winter it wants less; check the soil rather than the calendar and it will forgive you.',
      ],
      light: [
        'This is the one plant on this site that genuinely wants a lot of light. A bright window — south or west facing, with a few hours of gentle direct sun in the morning — is what keeps the leaves large and dark. In a dim corner it doesn’t die dramatically; it just stops growing and sheds a leaf now and then until there’s nothing left.',
        'Once it’s happy, leave it there. Fiddle leaf figs acclimatise to a specific light level and sulk when moved, which is why so many drop leaves in the fortnight after coming home from the shop. Rotate the pot a quarter-turn each time you water so it grows evenly, but don’t keep relocating it.',
      ],
      problems: [
        'Brown spots in the middle of a leaf, with a dark edge, usually mean root rot from too much water or a pot with no drainage. Brown patches that start at the leaf edge and creep inward are more often underwatering or dry air. It’s worth looking closely before you reach for the watering can, because the two look similar and the fixes are opposite.',
        'Sudden leaf drop after you move it, repot it, or turn the heating on is a stress response, not a death sentence. Put it somewhere bright and stable, water on your normal schedule, and stop fussing. Most recover once the conditions stop changing.',
        'Bare, leggy stems with leaves only at the top mean not enough light. New growth won’t fill in the bottom on its own — you can prune the top to force branching, but the real fix is a brighter spot.',
      ],
      sharedCare: [
        'The fiddle leaf fig is the plant most likely to be killed by two people caring for it kindly. It only wants water every week or so, so if you each water it “when it looks a bit dry,” it gets twice what it needs and rots quietly from the bottom.',
        'Make it a one-owner plant, or write down the date every time it gets watered so the second person can see it’s been done. This is the plant where a shared log earns its keep — the damage from double-watering takes weeks to show, and by then the cause is invisible.',
      ],
      honestBit: [
        'My honest take: don’t buy one first. A fiddle leaf fig is a plant for someone who already knows how their home behaves in winter — where the draughts are, which window still gets light in February, how fast a pot dries out. Learn that on a pothos, then buy the fig.',
        'And if yours drops a few leaves in the first month home, that’s normal and almost everybody panics about it. Give it one bright spot, a steady week, and no interventions. The plant isn’t asking for more attention; it’s asking for less change.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a fiddle leaf fig?',
        a: 'About every 7–10 days, once the top two inches of soil are dry. Water thoroughly until it drains out the bottom, then empty the saucer. Consistency matters more than the exact interval — steady beats a soak-and-forget cycle.',
      },
      {
        q: 'Why is my fiddle leaf fig dropping leaves?',
        a: 'Usually stress from a change: it was moved, repotted, hit by a cold draught, or the heating came on. Give it one bright, stable spot, water on a regular schedule, and stop moving it. Leaf drop paired with brown spotting is more likely a watering problem.',
      },
      {
        q: 'Are fiddle leaf figs toxic to cats and dogs?',
        a: 'Yes. The ASPCA lists Ficus species as toxic to both cats and dogs — the milky sap irritates the mouth and stomach and causes drooling and vomiting, and it can irritate skin too. Unpleasant rather than an emergency, but keep it away from pets that chew, and wash your hands after pruning.',
      },
      {
        q: 'What kind of light does a fiddle leaf fig need?',
        a: 'Bright light, more than most houseplants — ideally a south or west window with a few hours of direct morning sun. Low light won’t kill it quickly; it just stalls and slowly sheds leaves from the bottom up.',
      },
    ],
  },
  {
    slug: 'rubber-plant',
    commonName: 'Rubber Plant',
    scientificName: 'Ficus elastica',
    alsoKnownAs: ['Rubber Tree', 'Rubber Fig', 'Ficus elastica'],
    metaTitle: 'Rubber Plant Care: How Often to Water a Ficus Elastica',
    metaDescription:
      'How often to water a rubber plant, how much light it needs, why the leaves drop or yellow, and how to share the care of one without overwatering it.',
    reviewed: '2026-09-02',
    summary:
      'A rubber plant is what you buy when you want the drama of a fiddle leaf fig without the temperament. Same big glossy leaves, same architectural shape, a fraction of the sulking — it’s the easiest large statement plant you can own.',
    quickFacts: {
      water: 'Every 7–14 days, when the top inch or two of soil is dry',
      light: 'Bright, indirect light; tolerates medium light',
      difficulty: 'Easy',
      toxicity: 'Toxic to cats and dogs if chewed (the ASPCA lists Ficus species as toxic)',
      humidity: 'Average household humidity is fine',
    },
    sections: {
      watering: [
        'Water a rubber plant every 7–14 days, when the top inch or two of soil is dry. It’s a wide range because it depends on pot size and light: a big plant in a bright room drinks weekly, the same plant in a dim corner in January might go three weeks. Check with a finger, water thoroughly, let it drain.',
        'Rubber plants would rather be slightly dry than slightly wet. If you’ve inherited one and have no idea what its schedule was, err on the side of waiting — a thirsty rubber plant recovers in a day, a waterlogged one takes months.',
      ],
      light: [
        'Bright, indirect light gives you the best leaves: large, thick and glossy. It copes with medium light and a spot a few feet from a window, just with slower growth and more space between leaves. The variegated ones — the pink and cream types — need more light than the plain burgundy ones to hold their colour.',
        'Direct midday sun through glass can scorch the leaves, so a sheer curtain helps in a very bright window. Wipe the leaves with a damp cloth every month or so; they’re big enough to collect real dust, and dusty leaves genuinely take in less light.',
      ],
      problems: [
        'Leaves dropping from the bottom of the plant is the classic rubber plant complaint, and it’s usually overwatering — soggy soil starves the roots of air and the plant sheds from the bottom up. Let it dry out properly and check the pot actually drains.',
        'Yellow leaves point the same way: too much water, too often. A single yellow leaf at the base of an otherwise healthy plant is just ageing, and nothing to worry about.',
        'Brown, crispy edges mean the opposite — it got too dry, or it’s sitting next to a radiator. Curling leaves that don’t relax after a drink usually mean cold: rubber plants dislike draughty spots and doorways in winter.',
      ],
      sharedCare: [
        'A rubber plant is a good shared plant precisely because its schedule is loose. Anywhere in the 7-to-14-day window is fine, so it doesn’t much matter which of you gets to it — as long as somebody does and nobody doubles up in the same week.',
        'The one rule worth agreeing out loud: whoever waters, waters properly and empties the saucer. The failure mode in a shared house is two small top-ups plus a full soak in the same week, which reads as attentive care and lands as root rot.',
      ],
      honestBit: [
        'My take: the rubber plant is the most underrated big houseplant there is. People walk straight past it to buy a fiddle leaf fig they’ll kill within the year, when this thing gives you the same look, forgives a missed fortnight, and grows into a proper tree if you let it.',
        'One warning that has nothing to do with the plant and everything to do with your floors: the sap is milky, sticky and it stains. When you prune it — and you will, they get tall fast — put something down first and wear old clothes.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a rubber plant?',
        a: 'Every 7–14 days, once the top inch or two of soil is dry. Bright rooms and summer push it toward weekly; dim corners and winter stretch it to every two or three weeks. When in doubt, wait — it handles dry far better than soggy.',
      },
      {
        q: 'Why is my rubber plant losing its bottom leaves?',
        a: 'Almost always overwatering. Soggy soil starves the roots of air and the plant drops leaves from the bottom up. Let it dry out fully, make sure the pot has a drainage hole, and stop watering on a fixed calendar.',
      },
      {
        q: 'Are rubber plants toxic to cats and dogs?',
        a: 'Yes. The ASPCA lists Ficus species as toxic to cats and dogs — the milky sap irritates the mouth and gut, causing drooling and vomiting, and it can cause a skin reaction on contact. Keep it out of reach of pets that chew, and wipe up sap from broken leaves.',
      },
      {
        q: 'Do rubber plants need direct sunlight?',
        a: 'No — bright indirect light is ideal, and harsh midday sun through glass can scorch the leaves. Variegated varieties need more light than the plain dark ones to keep their pink and cream markings.',
      },
    ],
  },
  {
    slug: 'bird-of-paradise',
    commonName: 'Bird of Paradise',
    scientificName: 'Strelitzia reginae',
    alsoKnownAs: ['Crane Flower', 'Strelitzia', 'Bird of Paradise Flower'],
    metaTitle: 'Bird of Paradise Care: How Often to Water + Is It Pet-Safe?',
    metaDescription:
      'How often to water a bird of paradise, how much light it needs indoors, why the leaves split or brown, and whether it is safe around cats and dogs.',
    reviewed: '2026-09-02',
    summary:
      'A bird of paradise is the closest thing to a small tree that will live in a flat. It’s genuinely easy to keep alive and genuinely hard to make flower indoors — worth knowing which of those you’re buying it for.',
    quickFacts: {
      water: 'Every 7–10 days in summer, every 2–3 weeks in winter',
      light: 'As much bright light as you can give it, including some direct sun',
      difficulty: 'Easy to keep, hard to flower indoors',
      toxicity: 'Toxic to cats and dogs if eaten (per the ASPCA)',
      humidity: 'Likes moderate to high humidity; tolerates average',
    },
    sections: {
      watering: [
        'Water thoroughly every 7–10 days through spring and summer, letting the top inch or two dry out first. These are big plants with big leaves and they genuinely drink — a mature one in a bright room can empty its pot in a week. Water until it runs from the bottom, then let it drain.',
        'In winter, back right off to every two or three weeks. Growth slows, the plant uses far less, and the most common winter death is a summer schedule carried on into December.',
      ],
      light: [
        'Give it the brightest spot you have. Bird of paradise is a full-sun plant outdoors, and indoors it wants a south or west window with a few hours of direct sun. This is not one to tuck into a corner — it will survive there and look progressively worse.',
        'If you’re hoping for the orange-and-blue flower, light is most of the answer and patience is the rest: plants usually need to be mature, four or five years old, and snug in their pot before they bloom, and plenty of indoor plants never do. Treat the flower as a bonus and the leaves as the point.',
      ],
      problems: [
        'Split leaves are normal and not a problem. In the wild the splits let wind through instead of tearing the whole leaf off; indoors they happen from handling, draughts and simple age. A split leaf isn’t damaged, and cutting them off just leaves you with less plant.',
        'Brown, crispy leaf edges usually mean dry air, underwatering, or minerals building up in the soil. Water more thoroughly — a proper flush through the pot, not a sip — and consider filtered water if your tap is hard.',
        'Yellowing lower leaves with damp soil is overwatering, the most likely cause in winter. Yellowing across the whole plant with dry soil means it’s thirsty and probably needs a bigger pot.',
      ],
      sharedCare: [
        'This is a plant that changes what it wants twice a year, which is exactly the sort of thing that gets lost between two people. The summer routine and the winter routine are genuinely different, and a housemate who learned “water it weekly” in July will drown it in January.',
        'The fix is to write down the rule and not just the date: weekly in summer, fortnightly-to-monthly in winter, always check the soil first. A shared note attached to the plant beats one person privately remembering the seasonal switch.',
      ],
      honestBit: [
        'My take: buy it for the leaves. Almost every bird of paradise sold as a houseplant is bought by somebody imagining the flower, and most of them will never see one indoors. That’s fine — the foliage alone is the best value-per-pound of any large houseplant.',
        'Worth being straight about the pet question too, because it comes up constantly and the internet is split: the ASPCA lists Strelitzia reginae as toxic to both cats and dogs. It’s a mild toxicity, mostly from the fruit and seeds, but it is not one of the pet-safe options. If that’s your deciding factor, a parlor palm gives you a similar shape with a clean record.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a bird of paradise?',
        a: 'Every 7–10 days in spring and summer, once the top inch or two is dry, and every two to three weeks in winter. They’re thirsty in growth and barely drink in the cold — carrying the summer schedule into winter is the usual way people kill them.',
      },
      {
        q: 'Why are my bird of paradise leaves splitting?',
        a: 'That’s normal. The splits are how the leaves survive wind in the wild, and indoors they come from handling, draughts and age. It isn’t a sign of poor care and there’s nothing to fix.',
      },
      {
        q: 'Is bird of paradise toxic to cats and dogs?',
        a: 'Yes. The ASPCA lists Strelitzia reginae (bird of paradise flower) as toxic to cats and dogs — mainly the fruit and seeds, causing mild nausea, vomiting and drowsiness. Not usually dangerous, but not a pet-safe pick either.',
      },
      {
        q: 'Why won’t my bird of paradise flower indoors?',
        a: 'Usually not enough light, or the plant is still too young. They typically need several years of maturity, a snug pot and hours of direct sun to bloom, and many indoor plants never do. Grow it for the leaves and treat a flower as a surprise.',
      },
    ],
  },
  {
    slug: 'anthurium',
    commonName: 'Anthurium',
    scientificName: 'Anthurium andraeanum',
    alsoKnownAs: ['Flamingo Flower', 'Flamingo Lily', 'Painter’s Palette', 'Tail Flower'],
    metaTitle: 'Anthurium Care: Watering + Why It Stopped Flowering',
    metaDescription:
      'How often to water an anthurium, the light it needs to keep flowering, why the leaves yellow or the flowers turn green, and whether it is safe for pets.',
    reviewed: '2026-09-02',
    summary:
      'The anthurium is the houseplant that actually keeps flowering — those waxy red or pink blooms hold for weeks and come back for months on end. The catch is that it stops the moment the light isn’t good enough, and most people blame the water.',
    quickFacts: {
      water: 'Every 7–10 days, when the top inch of soil is dry',
      light: 'Bright, indirect light — essential if you want flowers',
      difficulty: 'Easy to keep alive, moderate to keep flowering',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals, per the ASPCA)',
      humidity: 'Likes higher humidity; copes with average, with browner tips',
    },
    sections: {
      watering: [
        'Water every 7–10 days, when the top inch of soil has dried. Anthuriums grow on trees in the wild rather than in the ground, so their roots want air as much as water — a chunky, well-draining mix and a pot that empties properly matter more here than the exact interval.',
        'They are very sensitive to standing wet. If the pot sits inside a decorative outer cover, tip the water out of it after every watering; the single most common anthurium killer is a plastic pot standing in an inch of leftover water inside a nice ceramic sleeve.',
      ],
      light: [
        'Bright, indirect light is the whole game with anthuriums. In medium or low light the plant stays perfectly healthy and simply stops producing flowers — which is how you end up with a green plant that somebody insists is “not doing anything.” Move it near a window, out of the direct beam, and the blooms come back.',
        'Direct midday sun scorches the leaves and bleaches the flowers, so bright-but-filtered is the target: an east window, or a metre back from a south one. If it hasn’t flowered in six months and everything else looks fine, light is almost certainly your answer.',
      ],
      problems: [
        'Flowers turning green as they age is normal. Anthurium blooms fade to green before they finish, so a green “flower” is an old one rather than a sick plant. Cut the stem back to the base and let the plant put its energy into the next one.',
        'Yellowing leaves usually mean too much water or a pot that won’t drain. Brown, crispy tips point the other way: dry air, or minerals from hard tap water building up in the mix.',
        'No flowers at all, on a plant with healthy leaves, is a light problem nine times out of ten. The tenth time it’s a plant that needs feeding — a diluted, high-phosphorus feed every few weeks in spring and summer makes a real difference.',
      ],
      sharedCare: [
        'Anthuriums make a good shared plant because they’re visibly expressive: when it’s happy it flowers, and everybody in the house can see that. That’s a lot more motivating than an evergreen which looks identical whether you’re doing well or badly by it.',
        'The bit to agree on is the outer pot. If one person waters and another tips out the cover, neither of you knows whether it’s standing in water right now. Make emptying the cover part of watering, not a separate job somebody else might have done.',
      ],
      honestBit: [
        'My take: an anthurium is the best gift plant on this list. It flowers for months, the blooms look almost artificial in a good way, and it survives the sort of care a brand-new plant owner gives. Just don’t put it on a shelf away from the window and then wonder why it stopped performing.',
        'And be honest about the pet side before it goes anywhere low: the ASPCA lists anthurium as toxic to cats and dogs. It’s the same calcium oxalate irritation as pothos and peace lily — a painful mouth rather than an emergency — but with a plant this vividly coloured at coffee-table height, it’s worth deciding where it lives before it arrives.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an anthurium?',
        a: 'Every 7–10 days, when the top inch of soil is dry. Water thoroughly, and always tip out any water left standing in the decorative outer pot — that is the most common way anthuriums are killed.',
      },
      {
        q: 'Why has my anthurium stopped flowering?',
        a: 'Almost always not enough light. Anthuriums stay green and healthy in medium light but stop producing blooms. Move it to bright, indirect light near a window and feed it through spring and summer, and flowers usually return.',
      },
      {
        q: 'Are anthuriums toxic to cats and dogs?',
        a: 'Yes. The ASPCA lists anthurium (flamingo flower) as toxic to both — it contains insoluble calcium oxalate crystals that cause mouth pain, swelling, drooling and difficulty swallowing if chewed. Keep it out of reach of pets that nibble.',
      },
      {
        q: 'Why are my anthurium flowers turning green?',
        a: 'That’s the normal way the bloom ages, not a problem. Each flower fades to green after several weeks. Cut the spent stem back to the base so the plant can put its energy into the next one.',
      },
    ],
  },
  {
    slug: 'chinese-evergreen',
    commonName: 'Chinese Evergreen',
    scientificName: 'Aglaonema',
    alsoKnownAs: ['Aglaonema', 'Silver Bay', 'Chinese Evergreen Plant'],
    metaTitle: 'Chinese Evergreen Care: Watering, Light, Pet Safety',
    metaDescription:
      'How often to water a Chinese evergreen, why it thrives in low light, what yellow or curling leaves mean, and whether aglaonema is safe for pets.',
    reviewed: '2026-09-02',
    summary:
      'If you have a room with bad light and you’ve already killed something in it, this is the plant. Aglaonema is the best-looking thing that genuinely tolerates a dim corner, and it comes in pink and red varieties that look like they ought to be much harder.',
    quickFacts: {
      water: 'Every 7–14 days, when the top inch or two of soil is dry',
      light: 'Low to medium indirect light; no direct sun',
      difficulty: 'Very easy',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals, per the ASPCA)',
      humidity: 'Average household humidity is fine',
    },
    sections: {
      watering: [
        'Water when the top inch or two of soil is dry, which lands somewhere around every 7–14 days depending on how bright and warm the room is. In a genuinely dim corner it can go much longer — a Chinese evergreen in low light in winter might want water once a month, and will be perfectly happy about it.',
        'These are far more likely to be overwatered than underwatered, because they look lush and people assume lush means thirsty. It stores water in those thick stems; if the soil is damp, put the can down.',
      ],
      light: [
        'Low to medium indirect light is what it’s famous for, and it’s one of the few plants where “low light” is a real recommendation rather than marketing. A north window, an interior wall, an office with no window of its own — it copes with all of them.',
        'The exception is the coloured varieties. The pink, red and heavily silver-marked aglaonemas need more light to hold their colour and drift back toward plain green in a dark spot. Keep the plain dark-green types for the worst corners and the colourful ones nearer a window. Direct sun burns all of them.',
      ],
      problems: [
        'Yellow leaves are overwatering, nearly always. Chinese evergreens are slow, quiet plants, so a soggy pot shows up as gradual yellowing rather than sudden collapse — which means it can go on for weeks before anybody notices.',
        'Curling leaves with brown edges point at dry air, cold, or hard tap water. They dislike being next to a draughty door or above a radiator, and a spot below about 15°C makes them unhappy fast.',
        'Leggy growth with long bare stems means either not enough light or simply age — older plants naturally lose their lower leaves and go a bit trunk-like. You can cut a leggy stem back hard in spring and it will resprout.',
      ],
      sharedCare: [
        'The Chinese evergreen is the ideal plant for the shared room nobody quite owns: a hallway, a landing, a home office two people use. It goes weeks without complaint, so it survives the gap where everyone assumes somebody else has it in hand.',
        'That same forgiveness is the trap. Because it never looks urgent, it can quietly go two months without water and then decline all at once. Pin it to a rough monthly check rather than a tight schedule, and it will outlast almost everything else in the house.',
      ],
      honestBit: [
        'My take: aglaonema is the answer to the question people actually ask, which is not “what’s the prettiest plant” but “what will survive in this specific bad corner.” It’s what I recommend when somebody describes a room with one small north-facing window.',
        'Be aware of the toxicity before you put one at ankle height, though. It’s an aroid, the same family as dieffenbachia and peace lily, and the ASPCA lists it as toxic to cats and dogs. A chewed leaf means a burning mouth and drooling — unpleasant enough that a shelf is a better home than the floor if you have a cat that samples things.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a Chinese evergreen?',
        a: 'Every 7–14 days, when the top inch or two of soil is dry — and considerably less in a dim room in winter, sometimes as little as once a month. It is far easier to overwater one than to underwater it.',
      },
      {
        q: 'Can a Chinese evergreen live in low light?',
        a: 'Yes, genuinely. It’s one of the few houseplants that does well in a dim corner or a windowless office. The plain dark-green varieties handle the least light; the pink and red ones need more to keep their colour.',
      },
      {
        q: 'Is aglaonema toxic to cats and dogs?',
        a: 'Yes. The ASPCA lists Chinese evergreen (Aglaonema) as toxic to both cats and dogs. It contains insoluble calcium oxalate crystals that cause mouth pain, swelling, drooling and vomiting if chewed. Keep it above a curious pet.',
      },
      {
        q: 'Why are my Chinese evergreen leaves turning yellow?',
        a: 'Overwatering is the usual cause. Let the soil dry out further between waterings and check the pot drains. Yellowing paired with a cold or draughty spot is also common in winter.',
      },
    ],
  },
  {
    slug: 'jade-plant',
    commonName: 'Jade Plant',
    scientificName: 'Crassula ovata',
    alsoKnownAs: ['Money Plant', 'Lucky Plant', 'Friendship Tree', 'Crassula'],
    metaTitle: 'Jade Plant Care: How Often to Water (Less Than You Think)',
    metaDescription:
      'How often to water a jade plant, the light it needs, why the leaves drop or wrinkle, and why it is not a pet-safe choice.',
    reviewed: '2026-09-02',
    summary:
      'A jade plant is a slow-growing succulent tree that will happily outlive you if you leave it alone. Almost every jade plant that dies was loved to death with a weekly watering it never asked for.',
    quickFacts: {
      water: 'Every 2–3 weeks in summer, monthly or less in winter',
      light: 'Bright light, including several hours of direct sun',
      difficulty: 'Very easy, if you can resist watering it',
      toxicity: 'Toxic to cats and dogs if eaten (per the ASPCA)',
      humidity: 'Dry household air is ideal',
    },
    sections: {
      watering: [
        'Water a jade plant every two to three weeks in summer, and roughly monthly or less in winter — and only once the soil is dry all the way through. When you do water, soak it properly and let everything drain away. The pattern is drought, then flood, then drought again: that’s how it lives in the wild.',
        'The wrinkle test beats any schedule. Plump, firm leaves mean it has plenty of water stored and needs nothing from you. Slightly soft or wrinkled leaves mean it’s ready for a drink. If you learn one thing about jade plants, learn to look at the leaves instead of the calendar.',
      ],
      light: [
        'Jade wants real light — several hours of direct sun a day if you can manage it. A south or west windowsill is ideal. Good light keeps the growth compact and can bring out a red blush on the leaf edges, which is a sign of a happy plant rather than a stressed one.',
        'In low light it stretches: long floppy stems, widely spaced leaves, and a plant that leans toward the window until it eventually tips over. If yours has gone lanky, that’s a light problem, and no amount of water or feeding will fix it.',
      ],
      problems: [
        'Leaves dropping at the slightest touch is the classic overwatering signal, and so are soft, yellowing, translucent leaves at the base. Stop watering entirely, let it dry out hard, and it usually recovers — jade is remarkably resilient once the soil is dry again.',
        'Wrinkled, shrivelled leaves are the far rarer opposite: it’s genuinely thirsty. Give it a thorough soak and they plump back up within a few days.',
        'White powdery patches or cottony spots in the leaf joints are mealybugs, which love jade plants. Dab them off with a cotton bud dipped in rubbing alcohol and check again a week later — they hide in the crevices and come straight back if you only do it once.',
      ],
      sharedCare: [
        'Jade is the plant most likely to be killed by a well-meaning housemate. It looks like a normal leafy plant rather than obviously a succulent, so the instinct is to water it weekly like everything else — and weekly watering will kill it within a season.',
        'If it lives in a shared space, label it or say it plainly: this one gets water once a month, and it’s meant to look dry. It’s one of the few plants where “do nothing” is the correct instruction, and it needs saying out loud precisely because it’s so counterintuitive.',
      ],
      honestBit: [
        'My take: a jade plant is a fifty-year plant. People buy them as small desk succulents and don’t realise they’re looking at something that becomes a proper miniature tree with a thick trunk if it’s simply left to get on with it. The main skill is patience and the main danger is enthusiasm.',
        'The pet answer disappoints people, because jade looks so innocuous: the ASPCA lists it as toxic to both cats and dogs, causing vomiting, depression and an unsteady, wobbly gait. Unusually, nobody is quite sure which compound is responsible. If a pet has eaten a real mouthful, that’s worth a call to the vet rather than a wait-and-see.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a jade plant?',
        a: 'Every two to three weeks in summer and about monthly in winter, only once the soil is completely dry. Better still, go by the leaves: firm and plump means wait, slightly soft or wrinkled means water.',
      },
      {
        q: 'Why is my jade plant dropping leaves?',
        a: 'Overwatering is the usual cause — leaves that fall at a touch, or go soft and translucent at the base, mean soggy soil. Stop watering, let it dry out completely, and check the pot drains. Leaf drop can also follow a sudden move or a cold draught.',
      },
      {
        q: 'Are jade plants toxic to cats and dogs?',
        a: 'Yes. The ASPCA lists jade plant (Crassula) as toxic to both cats and dogs — eating it causes vomiting, depression and incoordination, and the responsible toxin has never been identified. Worth a vet call if a pet has had a real mouthful.',
      },
      {
        q: 'Why is my jade plant leggy and floppy?',
        a: 'Not enough light. Jade needs several hours of direct sun to stay compact; in a dim spot it stretches toward the window with long bare stems. Move it somewhere brighter and prune the stretched growth — new growth comes in tighter.',
      },
    ],
  },
  {
    slug: 'english-ivy',
    commonName: 'English Ivy',
    scientificName: 'Hedera helix',
    alsoKnownAs: ['Common Ivy', 'Hedera', 'Needlepoint Ivy', 'Glacier Ivy'],
    metaTitle: 'English Ivy Indoor Care: Watering, Light, and Pet Safety',
    metaDescription:
      'How often to water English ivy indoors, the cool bright conditions it prefers, how to deal with spider mites, and why it is not pet-safe.',
    reviewed: '2026-09-02',
    summary:
      'English ivy is a beautiful trailing plant that is far fussier indoors than its reputation as an unstoppable outdoor weed suggests. It wants cool, bright and humid, and in a warm dry living room it gets spider mites and sulks.',
    quickFacts: {
      water: 'Every 5–10 days; keep lightly moist, never soggy',
      light: 'Bright, indirect light',
      difficulty: 'Moderate indoors — easy in a cool, bright room',
      toxicity: 'Toxic to cats and dogs if eaten (per the ASPCA)',
      humidity: 'Prefers higher humidity; dry heated air invites spider mites',
    },
    sections: {
      watering: [
        'Keep the soil lightly moist — water when the top half-inch to inch is dry, usually every 5–10 days. Ivy doesn’t want to dry out hard like a succulent, and equally won’t tolerate sitting in a wet pot. Even and moderate is the target.',
        'It drinks noticeably more in a warm room and much less in a cool one. If yours is on a cool bright windowsill or in an unheated porch, which is where it does best, expect to water considerably less often than the same plant in the living room.',
      ],
      light: [
        'Bright, indirect light keeps ivy full and keeps the variegated types variegated. Plain green ivies cope with medium light; the cream and white marbled ones fade and revert to green if the light is poor.',
        'Direct hot sun through glass scorches the leaves, but ivy genuinely loves being cool. A bright unheated room, a hallway, or a north-facing porch suits it far better than a warm living room — this is one of the very few houseplants that prefers the chilly end of your home.',
      ],
      problems: [
        'Fine webbing between the leaves, and a dusty, stippled, faded look, is spider mites — and English ivy indoors is a magnet for them. Warm dry air is what invites them in. Rinse the whole plant thoroughly in the shower, raise the humidity, and check weekly, because mites rebound fast from a single treatment.',
        'Brown, dry leaf edges and steady leaf drop usually mean the air is too dry or the room too warm. Moving it somewhere cooler often fixes more than any watering change will.',
        'Bare, straggly stems with leaves only at the ends mean not enough light. Cut the stems back by a third in spring; ivy responds well to a hard trim and comes back bushier.',
      ],
      sharedCare: [
        'Ivy is the plant that most rewards somebody actually looking at it. Spider mites are invisible for a fortnight and obvious once they’ve won, so it needs a person who turns a leaf over now and then rather than a person who waters on a timer.',
        'If two of you share it, the useful habit isn’t splitting the watering but agreeing that whoever waters also gives it ten seconds of inspection — undersides of leaves, new growth at the tips. That’s the whole maintenance routine, and it only works if it belongs to the job rather than to a particular person.',
      ],
      honestBit: [
        'My honest take: most people would be happier with a pothos. Ivy looks like the easy trailing plant and isn’t — it wants cool, humid and bright all at once, which describes very few centrally heated homes. It’s genuinely lovely in a cold bright hallway and genuinely miserable above a radiator.',
        'And a real warning if you have pets: the ASPCA lists English ivy as toxic to cats and dogs, with the foliage more toxic than the berries. Trailing plants are exactly the ones a cat can reach, because the plant comes down to them. If you want the trailing look with a clean pet record, a spider plant or a hoya does the same job.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water English ivy indoors?',
        a: 'Every 5–10 days, when the top half-inch to inch of soil is dry. Keep it lightly and evenly moist — not bone dry, not soggy. Cool rooms need watering much less often than warm ones.',
      },
      {
        q: 'Why does my English ivy keep getting spider mites?',
        a: 'Warm, dry indoor air, and ivy is unusually prone to them. Rinse the whole plant in the shower, raise the humidity, move it somewhere cooler, and re-check weekly — one treatment is rarely enough.',
      },
      {
        q: 'Is English ivy toxic to cats and dogs?',
        a: 'Yes. The ASPCA lists English ivy (Hedera helix) as toxic to both — it contains triterpenoid saponins that cause vomiting, abdominal pain, drooling and diarrhoea. The leaves are more toxic than the berries, and trailing stems are easy for a cat to reach.',
      },
      {
        q: 'Why is my English ivy going brown and dropping leaves?',
        a: 'Usually dry air or too much heat. Ivy prefers cool, humid conditions and struggles near radiators. Move it somewhere cooler and brighter, raise the humidity, and check for spider mites while you’re at it.',
      },
    ],
  },
  {
    slug: 'boston-fern',
    commonName: 'Boston Fern',
    scientificName: 'Nephrolepis exaltata',
    alsoKnownAs: ['Sword Fern', 'Nephrolepis', 'Boston Sword Fern'],
    metaTitle: 'Boston Fern Care: How Often to Water + Is It Pet-Safe?',
    metaDescription:
      'How often to water a Boston fern, the humidity it needs, why the fronds go brown and shed everywhere, and why it is a genuinely pet-safe choice.',
    reviewed: '2026-09-02',
    summary:
      'A Boston fern is one of the few genuinely pet-safe plants that also looks like something. It’s also the plant most likely to shed brown fronds across your floor in January, and those two facts are worth weighing against each other honestly.',
    quickFacts: {
      water: 'Every 3–7 days; keep the soil consistently damp, never dry',
      light: 'Bright, indirect light; no direct sun',
      difficulty: 'Moderate — easy to keep alive, harder to keep beautiful',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'High humidity is essential; dry air is the main killer',
    },
    sections: {
      watering: [
        'Boston ferns want the soil consistently damp — not wet, not dry. Check every few days and water when the surface starts to feel dry to the touch, which in practice is often every three to five days in summer and closer to weekly in winter. A fern that dries out completely, even once, browns off a batch of fronds and doesn’t forgive you.',
        'Because they dry from the top, a light watering can leave the middle of a dense root ball bone dry. Every few weeks it’s worth standing the pot in a sink of water for twenty minutes and letting it drink from the bottom, then draining it fully.',
      ],
      light: [
        'Bright but indirect. A north or east window is ideal, or a spot just out of the beam of a brighter one. Direct sun scorches the fronds quickly — this is a forest-floor plant and it shows.',
        'Too little light gives you a thin, sparse fern that sheds more than it grows. If yours is looking gappy and you’ve got the watering right, light is the next thing to change.',
      ],
      problems: [
        'Brown, crispy fronds and leaflets shedding all over the floor is the signature Boston fern complaint, and it’s almost always dry air. Central heating in winter is brutal on them. Grouping plants together, a pebble tray, a humidifier, or a bright bathroom all help far more than misting does.',
        'Yellowing fronds with soggy soil is overwatering — the one direction people don’t expect from a fern. Damp is the target; waterlogged still causes rot.',
        'A fern that looks fine on top and dead underneath usually just needs its old fronds cut out. Boston ferns constantly renew from the centre, and clearing the browned-off outer fronds at the base is normal maintenance rather than surgery.',
      ],
      sharedCare: [
        'This is a plant with a short fuse: three or four days late and it starts browning off. That makes it a bad candidate for “whoever gets to it,” and a good candidate for one named owner with a recurring reminder.',
        'If it does live in a shared house, the honest advice is to put it somewhere the humidity does the work for you — a bright bathroom is the classic answer — so the schedule matters less. A fern in a steamy bathroom forgives a forgetful household in a way that a fern in a heated living room never will.',
      ],
      honestBit: [
        'My take: the Boston fern is the plant I most often recommend and most often warn about in the same breath. If pet safety is your hard constraint, it’s one of the best-looking safe options there is. If you also want low effort, it’s the wrong plant, and a spider plant or a parlor palm will serve you better.',
        'One thing worth knowing that has genuinely caught people out: not everything sold as a “fern” is one. Asparagus fern isn’t a true fern at all, and the ASPCA lists it as toxic to cats and dogs. True ferns like this one are the safe group — but check the actual plant, not the word on the label.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a Boston fern?',
        a: 'Every three to seven days — keep the soil consistently damp and never let it dry out fully. Check by touch rather than by calendar, and soak the pot from the bottom every few weeks so the middle of the root ball actually gets wet.',
      },
      {
        q: 'Why is my Boston fern turning brown and dropping everywhere?',
        a: 'Dry air, almost always, and central heating in winter is the usual culprit. Raise the humidity with a pebble tray, a humidifier, or a move to a bright bathroom. Letting the soil dry out completely will do it too.',
      },
      {
        q: 'Are Boston ferns safe for cats and dogs?',
        a: 'Yes. The ASPCA lists Boston fern (Nephrolepis) as non-toxic to both cats and dogs — true ferns are one of the more reliably safe groups. Note that asparagus fern is not a true fern and is toxic, so check what you actually have.',
      },
      {
        q: 'Does misting a Boston fern help?',
        a: 'Barely. Misting raises the humidity for a few minutes and then it’s gone. A pebble tray, grouping plants together, a humidifier, or a naturally humid room all do far more, and none of them need you to remember anything daily.',
      },
    ],
  },
  {
    slug: 'money-tree',
    commonName: 'Money Tree',
    scientificName: 'Pachira aquatica',
    alsoKnownAs: ['Pachira', 'Guiana Chestnut', 'Malabar Chestnut', 'Braided Money Tree'],
    metaTitle: 'Money Tree (Pachira) Care: Watering, Light, and Pet Safety',
    metaDescription:
      'How often to water a money tree, the light it needs, why the leaves go yellow or drop, and why Pachira aquatica is one of the pet-safe options.',
    reviewed: '2026-09-02',
    summary:
      'The braided money tree is a genuinely good houseplant hiding behind a gimmicky presentation. It’s easy, it’s forgiving, and — unusually for a plant this size — the ASPCA lists it as non-toxic to cats and dogs.',
    quickFacts: {
      water: 'Every 1–2 weeks, when the top 2 inches of soil are dry',
      light: 'Bright, indirect light; tolerates medium',
      difficulty: 'Easy',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'Likes moderate humidity; copes with average',
    },
    sections: {
      watering: [
        'Water every one to two weeks, once the top two inches of soil are dry. Water thoroughly until it drains, then leave it alone until it’s dry again. Pachira stores water in that swollen trunk base, so it handles a missed week far better than a doubled-up one.',
        'In winter, stretch it out — every two to three weeks is plenty. The commonest money tree death is a well-meaning fortnightly routine kept identical all year, which is about right in July and much too much in January.',
      ],
      light: [
        'Bright, indirect light is ideal, and it does fine a few feet back from a window or in a medium-light room. Direct afternoon sun scorches the leaves, so a sheer curtain or a bit of distance from a south window helps.',
        'Turn the pot a quarter-turn every time you water. Money trees lean hard toward the light, and with a braided trunk that can’t correct itself, a plant that spent a year facing one way ends up permanently lopsided.',
      ],
      problems: [
        'Yellow leaves dropping off is the classic sign of too much water. The trunk should feel firm; if the base is soft or spongy, that’s rot and the watering needs to stop immediately.',
        'Brown, crispy leaf edges usually mean dry air or underwatering, and sometimes minerals from hard tap water. It’s a milder complaint than yellowing and much easier to correct.',
        'Leaf drop right after you bring it home is normal acclimation, not a crisis. Give it a stable bright spot and a consistent schedule and it settles within a few weeks. Repeated leaf drop later on is usually a light or watering problem.',
      ],
      sharedCare: [
        'Money trees are frequently office plants and gift plants, which means they are frequently nobody’s plant — everyone likes it, nobody waters it, and it dies slowly in a corner. A plant that only needs attention every couple of weeks is exactly the kind that falls through the gaps.',
        'It’s a good candidate for a shared reminder rather than a shared habit. Fortnightly in summer, monthly in winter, and one person confirming it was actually done is enough to keep it alive indefinitely.',
      ],
      honestBit: [
        'My take: if you want a floor-standing plant and you have a cat that chews, this is the one. Most large statement plants — fiddle leaf figs, rubber plants, bird of paradise, dracaenas — are toxic. Pachira is on the ASPCA non-toxic list and gets to five or six feet indoors. That combination is rarer than it should be.',
        'A naming warning worth taking seriously, though. “Money plant” is used for at least three different plants — this one, pothos, and jade — and the other two are both toxic to pets. If somebody hands you a “money plant,” find out what it actually is before you decide where it can live.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a money tree?',
        a: 'Every one to two weeks in the growing season, when the top two inches of soil are dry, and every two to three weeks in winter. It stores water in the swollen trunk base and copes much better with being late than with being early.',
      },
      {
        q: 'Are money trees safe for cats and dogs?',
        a: 'Yes — the ASPCA lists money tree (Pachira aquatica) as non-toxic to cats and dogs. Eating a lot of any plant can cause nausea or loose stool, but there is nothing poisonous in it. Beware the name, though: “money plant” is also used for pothos and jade, and both of those are toxic.',
      },
      {
        q: 'Why are my money tree leaves turning yellow and falling off?',
        a: 'Overwatering is the most likely cause. Let the soil dry down two inches before watering again and check the pot drains. If the base of the trunk feels soft or spongy, that is rot, and you should stop watering entirely.',
      },
      {
        q: 'Why is my money tree leaning to one side?',
        a: 'It’s growing toward the light. Rotate the pot a quarter-turn each time you water so every side gets its share — braided trunks can’t straighten themselves out later.',
      },
    ],
  },
  {
    slug: 'christmas-cactus',
    commonName: 'Christmas Cactus',
    scientificName: 'Schlumbergera',
    alsoKnownAs: ['Holiday Cactus', 'Thanksgiving Cactus', 'Zygocactus', 'Schlumbergera'],
    metaTitle: 'Christmas Cactus Care: Watering + How to Make It Bloom',
    metaDescription:
      'How often to water a Christmas cactus, why it drops its buds, how to get it to bloom again, and why it is a pet-safe flowering plant.',
    reviewed: '2026-09-02',
    summary:
      'A Christmas cactus is a jungle plant wearing a desert plant’s costume. It isn’t a succulent that wants neglect — it wants regular water and shade — and once you know that, it’s easy, long-lived and safe around pets.',
    quickFacts: {
      water: 'Every 1–2 weeks, when the top inch of soil is dry',
      light: 'Bright, indirect light; no direct sun',
      difficulty: 'Easy to grow, moderate to re-flower',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'Likes moderate humidity; average is fine',
    },
    sections: {
      watering: [
        'Water when the top inch of soil is dry, roughly every one to two weeks. Despite the name this is not a desert cactus: it grows in the crooks of trees in Brazilian rainforest and doesn’t want to be baked dry between drinks. Let it get slightly dry, then water thoroughly.',
        'It drinks more while it’s budding and flowering, and less afterwards while it rests. A dry spell during budding is the single most common reason buds drop off before they ever open.',
      ],
      light: [
        'Bright, indirect light. Direct sun bleaches and reddens the flat segments and can burn them outright. An east window, or a shaded spot in a brighter room, is about right.',
        'Light is also how you get it to flower. Schlumbergera sets buds in response to long nights and cool temperatures — roughly six to eight weeks of twelve-plus hours of uninterrupted darkness each night, at around 10–15°C. A spare room where nobody switches a lamp on in the evening, from about October, does it with no special effort at all.',
      ],
      problems: [
        'Buds forming and then dropping before they open is the classic complaint, and the cause is almost always change: it got moved, the temperature swung, or it dried out at the wrong moment. Once it’s budding, put it where it will stay and keep the watering steady.',
        'Limp, wrinkled, floppy segments can mean either extreme, which is unhelpful but true. Check the soil: dry means water it, soggy means root rot, and you should let it dry out hard and consider repotting.',
        'Reddish or purple segment edges are usually too much direct sun, occasionally cold. Move it out of the beam and the new growth comes back green.',
      ],
      sharedCare: [
        'Christmas cactus is the plant most likely to be inherited. They live for decades and get handed down, which means the one in your house may well have a routine that predates you — worth asking about, because these plants really do settle into a spot.',
        'The shared-care rule here is a seasonal one: from autumn, don’t move it and don’t leave a light on in its room at night. That’s a request other people in the house cannot possibly guess at, so it needs saying rather than assuming. Once the buds are set, it can come back somewhere everyone can see it.',
      ],
      honestBit: [
        'My take: the reason your Christmas cactus doesn’t flower is almost never the watering. It’s that its room has a lamp on in the evening. Six weeks of genuinely dark nights in autumn is the whole trick, and it costs nothing.',
        'The other good news is the pet one. The ASPCA lists Christmas cactus as non-toxic to cats and dogs, which puts it in a very small group of plants that flower reliably indoors and are safe at floor level. If you want winter colour in a house with animals, this is the pick.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a Christmas cactus?',
        a: 'Every one to two weeks, when the top inch of soil is dry. It’s a rainforest plant, not a desert one, so don’t treat it like a succulent — but don’t leave it soggy either. It drinks more while budding and flowering.',
      },
      {
        q: 'Why is my Christmas cactus dropping its buds?',
        a: 'Usually a change of some kind — it was moved, the temperature swung, or the soil dried out while it was budding. Once buds appear, leave it in place and keep the watering steady.',
      },
      {
        q: 'How do I make a Christmas cactus bloom again?',
        a: 'Give it long, uninterrupted dark nights and cool temperatures for about six to eight weeks in autumn — twelve or more hours of darkness at roughly 10–15°C. A spare room where nobody turns a lamp on in the evening does it.',
      },
      {
        q: 'Is a Christmas cactus safe for cats and dogs?',
        a: 'Yes. The ASPCA lists Christmas cactus (Schlumbergera) as non-toxic to both cats and dogs. It’s one of the few reliably flowering houseplants you can keep at floor level in a home with pets.',
      },
    ],
  },
  {
    slug: 'parlor-palm',
    commonName: 'Parlor Palm',
    scientificName: 'Chamaedorea elegans',
    alsoKnownAs: ['Parlour Palm', 'Neanthe Bella Palm', 'Good Luck Palm', 'Chamaedorea'],
    metaTitle: 'Parlor Palm Care: Watering, Low Light, and Pet Safety',
    metaDescription:
      'How often to water a parlor palm, why it works in low light, what brown tips mean, and why it is one of the best pet-safe plants you can buy.',
    reviewed: '2026-09-02',
    summary:
      'The parlor palm has been the standard indoor palm since the Victorians, and for good reason: it handles low light, it’s genuinely pet-safe, and it looks tropical while asking for almost nothing.',
    quickFacts: {
      water: 'Every 7–10 days, when the top inch of soil is dry',
      light: 'Low to medium indirect light; no direct sun',
      difficulty: 'Easy',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'Prefers moderate humidity; browns at the tips in very dry air',
    },
    sections: {
      watering: [
        'Water every 7–10 days, when the top inch of soil is dry. Parlor palms like their soil lightly moist, but they’re far more tolerant of a missed watering than of a soggy pot — the roots are fine and they rot easily if they stay wet.',
        'In a low-light spot, or in winter, stretch it to every two weeks or more. A dim corner plus a damp pot is the combination that kills them; if it’s somewhere dark, it needs water noticeably less often than you’d think.',
      ],
      light: [
        'Low to medium indirect light. This is a genuine low-light plant — it grows in the understorey of Central American rainforest and never sees direct sun there. A north window, an interior corner, or a shaded spot in a brighter room all work.',
        'Direct sun scorches the fronds and turns them a bleached yellow-green, so the one mistake to avoid is putting it on a sunny windowsill because it looks tropical. Shade isn’t a compromise for this plant; it’s the preference.',
      ],
      problems: [
        'Brown, crispy frond tips are the most common complaint and usually mean dry air, though hard tap water and inconsistent watering both contribute. Trim the brown off with scissors if it bothers you, raise the humidity, and judge by the new growth.',
        'Yellowing fronds across the whole plant point at overwatering. Parlor palms grow slowly and a rotting root system shows up gradually, so it’s worth checking the soil actually dries out between waterings.',
        'Fine webbing and stippled, dusty-looking fronds are spider mites, which like the same warm dry air that causes the brown tips. Rinse the plant in the shower and raise the humidity — conveniently, the two fixes are the same fix.',
      ],
      sharedCare: [
        'A parlor palm is one of the best plants for a household that isn’t very good at plants. It goes over a week without water, it doesn’t need a bright window, and it doesn’t die dramatically when the routine slips — which makes it forgiving of the gap where everybody assumed somebody else had it.',
        'It’s also a good one for the room the pets live in, precisely because it’s safe. Households often end up with every plant exiled to a high shelf; this is one you can put on the floor and stop thinking about.',
      ],
      honestBit: [
        'My take: the parlor palm is the most useful plant on this whole site. It’s the answer to “low light AND pet-safe AND low effort,” which is the combination most people actually need and very few plants satisfy. It isn’t exciting. It’s just right almost every time.',
        'Buy a full pot rather than a single stem if you have the choice. Parlor palms don’t branch — each stem grows on its own — so a sparse plant stays sparse forever. Nurseries plant several together for a fuller look, and that’s what you want.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a parlor palm?',
        a: 'Every 7–10 days, when the top inch of soil is dry, and less in winter or in a dim spot — sometimes every two weeks or more. They tolerate a missed watering much better than a soggy pot.',
      },
      {
        q: 'Are parlor palms safe for cats and dogs?',
        a: 'Yes. The ASPCA lists parlor palm (Chamaedorea elegans) as non-toxic to both cats and dogs. It’s one of the few plants that is simultaneously pet-safe, low-light tolerant and easy, which is why it gets recommended so often.',
      },
      {
        q: 'Why are my parlor palm tips turning brown?',
        a: 'Dry air is the usual cause, with hard tap water and uneven watering contributing. Raise the humidity, keep the watering consistent, and trim the brown tips off if you want it tidy — the existing damage won’t turn green again.',
      },
      {
        q: 'Can a parlor palm live in low light?',
        a: 'Yes, genuinely. It grows in rainforest understorey and prefers shade to sun, and direct sunlight scorches the fronds. Just remember that a plant in low light needs watering less often, not more.',
      },
    ],
  },
  {
    slug: 'orchid',
    commonName: 'Moth Orchid',
    scientificName: 'Phalaenopsis',
    alsoKnownAs: ['Phalaenopsis', 'Phal', 'Moon Orchid', 'Supermarket Orchid'],
    metaTitle: 'Orchid Care: Watering a Moth Orchid + Reblooming It',
    metaDescription:
      'How often to water a phalaenopsis orchid, what the roots are telling you, how to get it to flower again, and why orchids are pet-safe.',
    reviewed: '2026-09-02',
    summary:
      'The supermarket orchid is not a delicate specialist plant — it’s an easy plant that almost everybody waters wrong. Get the watering right and a phalaenopsis will flower for months, rest, and then do it again for years.',
    quickFacts: {
      water: 'Roughly every 7–10 days; soak, then drain completely',
      light: 'Bright, indirect light — an east window is ideal',
      difficulty: 'Easy, once you stop watering it like a normal plant',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'Likes moderate to high humidity; average is workable',
    },
    sections: {
      watering: [
        'An orchid isn’t growing in soil, it’s growing in bark, and its roots are meant to be wet briefly and then dry with air around them. Water roughly every 7–10 days by taking the plastic inner pot to the sink, running water through the bark for a minute, then letting it drain completely before it goes back in its cover. Never leave it standing in water.',
        'The roots tell you when. Firm, silvery-green roots mean it’s fine; roots that have gone plain silver-white and slightly shrivelled mean it’s thirsty. That’s far more reliable than a schedule, and it’s the reason clear plastic pots are standard — you’re supposed to look.',
      ],
      light: [
        'Bright, indirect light. An east-facing window is close to perfect: gentle morning sun, shade for the rest of the day. The leaves should be a medium grass green — very dark green means not enough light, and yellow-green or red-tinged means too much.',
        'Light is also the flowering lever. An orchid that hasn’t reflowered is usually in a spot that’s too dim. That, plus a cool spell — a few weeks with night temperatures around 15°C, which an autumn windowsill provides by itself — is what triggers a new flower spike.',
      ],
      problems: [
        'Wrinkled, floppy, leathery leaves mean the plant can’t take up water, and confusingly the usual cause is overwatering that has rotted the roots. Tip it out and look: healthy roots are firm and green or silver, dead ones are brown, flat and mushy. Cut the dead ones off and repot into fresh bark.',
        'Flowers dropping after a couple of months isn’t a failure — that’s the end of a normal flowering cycle. The plant isn’t dying, it’s resting. Keep watering it, keep it in good light, and it will spike again.',
        'Roots wandering out of the pot into the air are completely normal and should be left alone. Phalaenopsis are epiphytes and aerial roots are simply how they live; stuffing them back into the pot does more harm than leaving them be.',
      ],
      sharedCare: [
        'Orchids get given as gifts, and gift plants are the ones that fall between people. Worse, an orchid that has finished flowering looks like it’s finished full stop, so it quietly gets abandoned on a shelf while still perfectly alive.',
        'The thing worth sharing isn’t the schedule, it’s the fact that a spent orchid is not a dead orchid. Enormous numbers of them are binned in month three by somebody who didn’t know they reflower. And while we’re dispelling things: the ice-cube trick people pass around isn’t a good idea — a proper soak and a full drain is.',
      ],
      honestBit: [
        'My take: three things fix nearly every orchid problem, and none of them are complicated. Take it out of the decorative pot to water it. Let it drain completely. Put it in an east window. That’s genuinely most of orchid care, and everything else is refinement.',
        'And a nice bonus if you have animals: the ASPCA lists the moth orchid as non-toxic to cats and dogs. Given how many houseplants that flower this dramatically are toxic, an orchid on a low table in a house with a cat is a rare, easy yes.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an orchid?',
        a: 'Roughly every 7–10 days. Take the inner pot to the sink, run water through the bark for a minute, and let it drain completely before returning it to its cover pot. Better still, go by the roots: silvery and shrivelled means water, firm and green means wait.',
      },
      {
        q: 'Are orchids safe for cats and dogs?',
        a: 'Yes — the ASPCA lists the phalaenopsis (moth) orchid as non-toxic to both cats and dogs. Eating a flower or leaf might cause a mild stomach upset like any plant, but there is nothing poisonous in it.',
      },
      {
        q: 'How do I get my orchid to flower again?',
        a: 'More light and a cool spell. Move it to a bright east window, and let it experience a few weeks of cooler nights in autumn, around 15°C. A dim spot is the usual reason an otherwise healthy orchid never spikes again.',
      },
      {
        q: 'Why are my orchid leaves wrinkled and floppy?',
        a: 'The roots can’t take up water, and the usual cause is root rot from overwatering or a pot that stays wet. Tip it out and inspect: firm green or silver roots are healthy, brown mushy ones are dead. Trim the dead roots and repot into fresh bark.',
      },
    ],
  },
  {
    slug: 'hoya',
    commonName: 'Hoya',
    scientificName: 'Hoya carnosa',
    alsoKnownAs: ['Wax Plant', 'Porcelain Flower', 'Hindu Rope Plant', 'Wax Flower'],
    metaTitle: 'Hoya Care: How Often to Water a Wax Plant + Pet Safety',
    metaDescription:
      'How often to water a hoya, the light it needs to flower, why the leaves wrinkle or yellow, and why Hoya carnosa is a pet-safe trailing plant.',
    reviewed: '2026-09-02',
    summary:
      'A hoya is a trailing plant with thick, almost plastic-feeling leaves that stores its own water and asks very little of you. It’s slow, it’s nearly indestructible, and Hoya carnosa is on the ASPCA non-toxic list — which makes it the pet-safe answer to a hanging pothos.',
    quickFacts: {
      water: 'Every 2–3 weeks; let the soil dry out most of the way first',
      light: 'Bright, indirect light; some gentle direct sun helps it flower',
      difficulty: 'Very easy',
      toxicity: 'Non-toxic to cats and dogs (the ASPCA lists Hoya carnosa as non-toxic)',
      humidity: 'Average household humidity is fine',
    },
    sections: {
      watering: [
        'Water every two to three weeks, once the soil has dried out most of the way. Those thick waxy leaves are water storage — a hoya is closer to a succulent than to a fern in how it wants to be treated, and it genuinely prefers being forgotten to being fussed over.',
        'In winter, once a month is often enough. The wrinkle test works here as well as it does on a jade plant: firm leaves mean it’s fine, slightly soft or dimpled leaves mean it’s time.',
      ],
      light: [
        'Bright, indirect light keeps it healthy, and a bit of gentle direct sun — morning, or a west window through a curtain — is what gets it to flower. A hoya in medium light will live happily for years and simply never bloom.',
        'If you want the flowers, and they’re worth wanting, there’s one rule that catches everybody out: don’t cut off the bare little stalk a flower cluster grew from. Hoyas rebloom from the same spur year after year, and pruning it off means starting over.',
      ],
      problems: [
        'Yellowing leaves that feel soft mean too much water. It’s the main way hoyas are killed, and it takes a while to show because the plant is so slow — by the time leaves yellow, the roots have usually been sitting wet for weeks.',
        'Wrinkled, dimpled leaves are the honest thirst signal, and a thorough soak fixes them within a couple of days. If a soak doesn’t fix them, check the roots, because rot produces the same symptom.',
        'No flowers on an otherwise healthy plant usually means not enough light, or a plant that’s still too young — hoyas often need a few years before they bloom. Repotting frequently also delays it; they flower better when slightly root-bound.',
      ],
      sharedCare: [
        'Hoyas are ideal for households that travel or forget. A three-week interval means a fortnight away does no damage at all, and there’s no realistic scenario in which two people miss it badly enough to matter.',
        'The one thing worth telling everybody is the flower spur rule. A tidy-minded housemate deadheading the spent flowers and snipping off the “dead-looking twig” underneath will cost you next year’s blooms — and it’s a completely reasonable mistake to make if nobody has ever mentioned it.',
      ],
      honestBit: [
        'My take: if you want the trailing look of a pothos but you have a cat that chews, this is the swap. Pothos is toxic and hoya is not, they live happily in similar spots, and the hoya asks for less water. The only real difference is that hoyas grow slowly, so buy one bigger than you think you need.',
        'And the flowers are genuinely strange in a good way — tight clusters of small waxy stars that look machine-made and, on many varieties, smell strongly of chocolate or vanilla at night. It takes patience to get there. It’s worth it.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a hoya?',
        a: 'Every two to three weeks, once the soil has dried out most of the way, and about monthly in winter. The leaves are the best guide: firm means wait, slightly soft or wrinkled means water.',
      },
      {
        q: 'Are hoyas safe for cats and dogs?',
        a: 'The ASPCA lists Hoya carnosa (wax plant) as non-toxic to cats and dogs, which covers the common trailing hoya sold as a houseplant. It’s a good pet-safe alternative to a pothos, which is toxic. Hoya is a large genus, so check the label if yours is an unusual species.',
      },
      {
        q: 'Why won’t my hoya flower?',
        a: 'Usually not enough light, or the plant is still young — many hoyas take a few years. Give it bright light with a little gentle direct sun, avoid repotting it often since they bloom better slightly root-bound, and never cut off the bare spur a flower cluster grew from, because it reblooms from the same one.',
      },
      {
        q: 'Why are my hoya leaves wrinkled?',
        a: 'That’s the thirst signal — give it a thorough soak and they should plump up within a couple of days. If they don’t, check the roots: root rot from overwatering causes the same wrinkling, because the damaged roots can’t take up water.',
      },
    ],
  },
  {
    slug: 'nerve-plant',
    commonName: 'Nerve Plant',
    scientificName: 'Fittonia albivenis',
    alsoKnownAs: ['Fittonia', 'Mosaic Plant', 'Silver Nerve', 'Silver Threads'],
    metaTitle: 'Nerve Plant Care: Why It Keeps Fainting + Pet Safety',
    metaDescription:
      'How often to water a fittonia, why it collapses dramatically and recovers, the humidity it needs, and why nerve plants are non-toxic to cats and dogs.',
    reviewed: '2026-09-02',
    summary:
      'The nerve plant is the drama queen of small houseplants: it faints flat when it gets thirsty and springs back up within hours of a drink. Once you know the fainting is theatre rather than death, it’s easy — and the ASPCA lists it as non-toxic to cats and dogs.',
    quickFacts: {
      water: 'Every 3–5 days; keep the soil lightly moist at all times',
      light: 'Medium, indirect light; no direct sun',
      difficulty: 'Easy in the right spot, difficult in a dry room',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'High humidity is essential — this is the whole plant',
    },
    sections: {
      watering: [
        'Keep the soil lightly moist, checking every few days — in practice that usually means watering every three to five days. Fittonias have shallow roots and small pots and they dry out fast, especially in a warm room. They don’t want to be soggy, but they won’t tolerate drying out fully either.',
        'The famous collapse is your reminder: when it runs dry the whole plant goes limp and flat, as though it has died. Water it and it stands back up within a few hours, usually with no lasting damage. It’s alarming the first time and completely routine after that — though repeatedly letting it faint does eventually cost you leaves.',
      ],
      light: [
        'Medium, indirect light. Fittonia grows on the rainforest floor and burns in direct sun, so a north or east window, or a shaded spot in a brighter room, is what it wants. Under a desk lamp or a grow light works well too.',
        'Too little light makes it leggy and washes out the pink or white veining that is the entire point of the plant. If yours has gone sparse and dull, move it somewhere brighter but keep it out of the sun beam.',
      ],
      problems: [
        'A collapsed, flat plant means it’s thirsty. Water it thoroughly and check again in a few hours. If it doesn’t stand back up after a good soak, look at the roots — sitting wet causes rot, which produces exactly the same wilting.',
        'Brown, crispy leaf edges mean the air is too dry. This is the single hardest thing about a fittonia in a normal home: it wants humidity that a heated room simply doesn’t have. A terrarium, a closed jar, a bathroom, or a cluster of plants under a cloche all solve it permanently.',
        'Yellowing, mushy leaves at the base mean too much water sitting in the pot. Fittonias want moist, not wet, and a pot without a drainage hole is a fast way to lose one.',
      ],
      sharedCare: [
        'A fittonia is a bad plant to share on a rota and a great plant to share as a visible signal, because it announces its own neglect. When it faints, everybody can see it needs water — no note required.',
        'That said, three to five days is a short leash for a shared household. If nobody in the house is reliable on that timescale, put it in a closed terrarium or a big jar with a lid, where it keeps itself humid and goes weeks without you. That isn’t a compromise; it’s genuinely how these plants grow best indoors.',
      ],
      honestBit: [
        'My take: buy a fittonia for a terrarium or a bathroom, not for a shelf in a heated living room. In the right microclimate it’s one of the prettiest and easiest small plants there is. In dry air it’s a slow, sad, crispy-edged disappointment, and no amount of misting will fix that.',
        'It also earns its place if you have pets, because it’s small, it’s safe, and it can live at any height. The ASPCA lists nerve plant as non-toxic to cats and dogs, which means it can sit on a low table or a bedside without you thinking about it — rare for something this decorative.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a nerve plant?',
        a: 'Every three to five days — keep the soil lightly moist and never let it dry out fully. Small pots and shallow roots mean fittonias dry fast, especially in a warm room.',
      },
      {
        q: 'Why does my fittonia keep collapsing?',
        a: 'It’s thirsty. Nerve plants wilt dramatically flat when the soil dries out, and recover within hours of watering. It’s normal behaviour rather than damage, though repeated faints will eventually cost leaves. If a good soak doesn’t revive it, check the roots for rot.',
      },
      {
        q: 'Are nerve plants safe for cats and dogs?',
        a: 'Yes. The ASPCA lists nerve plant (Fittonia) as non-toxic to both cats and dogs, so it’s fine at floor level or on a bedside table in a home with pets.',
      },
      {
        q: 'Why are my fittonia leaves going brown and crispy at the edges?',
        a: 'Dry air. Fittonias need genuinely high humidity, more than a heated room provides. A terrarium, a covered jar, a bathroom, or grouping it with other plants under a cloche fixes it far more effectively than misting.',
      },
    ],
  },
];

export function findCareGuide(slug: string): CareGuide | undefined {
  return CARE_GUIDES.find((g) => g.slug === slug);
}
