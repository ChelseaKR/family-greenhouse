/**
 * Programmatic species care pages — the SEO scale lever.
 *
 * Each entry is one page at `/care/[slug]`, targeting "how often to water
 * [plant]" / "[plant] care" / "why is my [plant] dying". One template
 * (`CareGuidePage.tsx`) renders all of them, so growing the surface = adding
 * data entries, not writing components.
 *
 * Entries are meant to be GROUNDED: every fact from a cited source, the prose
 * original. Perenual is NOT a source for these pages: its free plan is for
 * personal use only, and it is switched off in production (license audit,
 * 2026-11-03). What the record shows today: the pet line comes from the
 * ASPCA-cited table (`careToxicity.ts`); haworthia, burro's tail, blue
 * echeveria, begonia and lily cite university extension pages (#1022); the
 * eight watering guides added 2026-11-03 (string of pearls through corn plant)
 * cite extension and RHS pages read that day; the four holiday guides added
 * 2026-11-04 (amaryllis, Norfolk Island pine, cyclamen, kalanchoe) cite
 * extension pages read that day; and since #1079 every guide
 * records its sources in `careSources`, so no water, light or humidity line
 * rests on an unrecorded source. The
 * generator prompt that produces this shape is
 * `docs/growth/prompts/02-species-care-page.md`.
 * The first three were a hand-reviewed sample so the content quality and the
 * architecture could be judged before scaling; there are 45 now, still short
 * of the ~150 species the surface is sized for.
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
  /**
   * Three hand-picked guides a reader of this one is likely to want next:
   * the plant people confuse it with, or the one that fits the same spot.
   * Rendered as "Related plants"; every slug must resolve (careGuides.test).
   */
  related: string[];
  metaTitle: string;
  metaDescription: string;
  /**
   * The visible H1 and the Article `headline`, when a guide's searchers ask
   * something narrower than "<Name> care". Set only where Search Console
   * shows the page earning impressions for that question (2026-10-29: "how
   * often to water zz plant" was 96 of the ZZ page's 120 impressions at
   * positions 5-40). Defaults to `<commonName> care`.
   */
  heading?: string;
  /**
   * ISO date a human last checked this guide's FACTS against source data —
   * the review discipline the module header demands, especially for
   * `quickFacts.water` and `quickFacts.toxicity`. Feeds `datePublished`.
   *
   * It is deliberately NOT the page's modification date: see `updated`.
   */
  reviewed: string;
  /**
   * ISO date this guide's content last CHANGED — the page's modification
   * date. Feeds `dateModified`, `article:modified_time`, the visible "Last
   * updated" line, and the sitemap's `<lastmod>`.
   *
   * Split out from `reviewed` because one field was answering two different
   * questions and drifted on the second. `reviewed` means "somebody verified
   * these facts"; a copy edit changes the page without re-verifying anything,
   * and re-verifying changes nothing on the page. Publishing one as the other
   * is only harmless while no edit happens between reviews — and two did:
   *
   *   #649 (2026-09-05) rewrote the `metaTitle` of six guides
   *   #651 (2026-09-05) turned twelve prose mentions of /pet-safe into links
   *
   * Neither touched `reviewed`, so twelve guides went on advertising a
   * `<lastmod>` and a `dateModified` older than their own content — by 80
   * days on peace-lily, heartleaf-philodendron, zz-plant, aloe-vera,
   * dieffenbachia and calathea. `<lastmod>` is the one sitemap field that is
   * a factual claim, and understating it is how a crawler decides a URL whose
   * title just changed does not need refetching.
   *
   * MUST be bumped to the ship date whenever any content field below changes.
   * Values here were reconstructed from `git log` over this file; the four
   * guides whose only recorded write is the repository's root commit
   * (2026-07-05, history begins there) keep `reviewed`, because no change to
   * them is on record and inventing a later date would overstate freshness.
   */
  updated: string;
  summary: string;
  quickFacts: {
    water: string;
    light: string;
    difficulty: string;
    /**
     * The pet line shown in "At a glance" and in the /pet-safe directory. It
     * must open with the verdict the cited ASPCA listing gives (see
     * `careToxicity.ts`): "Toxic", "Mildly toxic" or "Non-toxic" when the
     * listing states one for both animals, and "Unknown" when there is no
     * listing. careGuides.test holds the two together.
     */
    toxicity: string;
    humidity: string;
  };
  sections: {
    watering: string[];
    light: string[];
    problems: string[];
    /** How to make more of it: the method that works, and the one that does not. */
    propagation: string[];
    /** The differentiator: keeping it alive in a shared home. */
    sharedCare: string[];
    /** Founder voice — one real opinion, light humor ok. */
    honestBit: string[];
  };
  /**
   * Care questions only. The pet-toxicity question is generated by the page
   * from the cited table (`careToxicity.ts`), so a hand-written answer can
   * never disagree with its source; careGuides.test rejects one here.
   */
  faqs: { q: string; a: string }[];
  /**
   * Where the guide's water, light and humidity advice comes from: a US
   * university extension page, the Missouri Botanical Garden Plant Finder or
   * the RHS. Rendered under "Where this care advice comes from" on the page.
   * Every published guide needs at least one (careGuides.test), so no care
   * fact rests on an unrecorded source. The pet line is cited separately, from
   * the ASPCA table (`careToxicity.ts`), and is not listed here.
   */
  careSources: CareSource[];
}

/** One page a guide's care advice was checked against. */
export interface CareSource {
  /** The organization that publishes the page, as it names itself. */
  publisher: string;
  /** The page's own title. */
  title: string;
  url: string;
  /** ISO date the page was read and the guide compared with it. */
  accessed: string;
}

export const CARE_GUIDES: CareGuide[] = [
  {
    slug: 'pothos',
    commonName: 'Pothos',
    scientificName: 'Epipremnum aureum',
    alsoKnownAs: ['Devil’s Ivy', 'Golden Pothos', 'Money Plant'],
    related: ['heartleaf-philodendron', 'hoya', 'english-ivy'],
    metaTitle: 'How Often to Water a Pothos: When the Soil Is Dry',
    heading: 'Pothos care: how often to water it',
    metaDescription:
      'Water a pothos when the soil has dried out, not on a fixed day count. It wants bright, indirect light and no direct sun. Plus why the leaves go yellow.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'Pothos is the plant people mean when they say “I can’t keep anything alive, except this one.” It’s forgiving, fast-growing, and tells you clearly when something’s wrong — if you know what to look for.',
    quickFacts: {
      water: 'When the soil has dried out; it is better kept too dry than too wet',
      light: 'Bright, indirect light; survives low light, but the variegation fades',
      difficulty: 'Very easy',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals)',
      humidity:
        'Ordinary room air is fine; the sources differ, and one suggests a pebble tray for very dry air',
    },
    sections: {
      watering: [
        'Water a pothos when the soil has dried out, and skip the calendar. Push a finger into the pot: dry means water it, still damp means wait. The extension sources give no number of days, because how fast the pot dries depends on your room, the light and the season.',
        'If you are going to get it wrong, get it wrong on the dry side. Penn State Extension says a pothos is better kept too dry than too wet: too little water makes the leaves droop for a while, and too much leads to root rot. A pot with a drainage hole and a mix that drains well does most of the work.',
      ],
      light: [
        'Bright, indirect light is the spot to aim for: near a window, but out of direct sun. Penn State Extension warns that direct sun turns the leaves yellow. Pothos does survive low light for a long time, which is why it ends up on dim shelves, but there the cream-and-green marbling fades toward plain green.',
        'The sources split on humidity. North Carolina State Extension suggests a humidifier or a tray of wet pebbles to raise it, and Illinois Extension lists low humidity among its conditions. In practice, ordinary room air works, and a pebble tray is worth trying only if the air in your home is very dry.',
      ],
      problems: [
        'Yellow leaves have two usual suspects. One is too much water: the instinct when a plant looks sad is to give it more, and with pothos that can be the thing hurting it, so let the soil dry before the next drink. The other is direct sun, which Penn State Extension says yellows the leaves.',
        'Brown, crispy tips point the other way — underwatering, or very dry air. Crispy edges on an otherwise green leaf means it got too thirsty at some point.',
        'Limp, mushy stems at the soil line are root rot, the one genuinely dangerous problem, and it comes from sitting in soggy soil. Pothos forgives a missed watering; it does not forgive a pot with no drainage hole.',
      ],
      propagation: [
        'Pothos is the easiest plant on this site to propagate. Cut a length of vine just below a node (the small bump where a leaf meets the stem, often with a brown aerial root nub), strip the leaf nearest the cut end, and stand it in a glass of water so at least one node is underwater.',
        'Roots usually appear in two to four weeks. Pot it up once they are an inch or two long, or skip the water stage and push the cut nodes straight into damp potting mix. A cutting with no node will stay green for weeks and never root, so the node is the part that matters.',
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
        a: 'When the soil has dried out, rather than on a set number of days. The extension sources give no interval. Check with a finger, water when it is dry, and when unsure, wait: it is better kept too dry than too wet.',
      },
      {
        q: 'Why are my pothos leaves turning yellow?',
        a: 'Two common causes. Too much water, especially in a pot that does not drain, leads to root rot, so let the soil dry between waterings. Direct sun also yellows the leaves, according to Penn State Extension, so move it out of any direct beam.',
      },
      {
        q: 'Can pothos survive in low light?',
        a: 'Yes. It survives low light for long periods, though the variegation fades toward solid green. Bright, indirect light keeps it more colorful.',
      },
      {
        q: 'How do you propagate pothos?',
        a: 'Cut a piece of vine just below a node, put the node in water, and pot it once the roots are an inch or two long, usually after two to four weeks. The node is essential: a cutting without one will not root.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Epipremnum aureum (Pothos)',
        url: 'https://plants.ces.ncsu.edu/plants/epipremnum-aureum/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Penn State Extension',
        title: 'Pothos as a Houseplant',
        url: 'https://extension.psu.edu/pothos-as-a-houseplant',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Illinois Extension',
        title: 'Pothos',
        url: 'https://extension.illinois.edu/houseplants/pothos',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'snake-plant',
    commonName: 'Snake Plant',
    scientificName: 'Dracaena trifasciata',
    alsoKnownAs: ['Sansevieria', 'Mother-in-Law’s Tongue'],
    related: ['zz-plant', 'aloe-vera', 'jade-plant'],
    metaTitle: 'How to Care for a Snake Plant: Water Once the Soil Is Dry',
    heading: 'How to care for a snake plant',
    metaDescription:
      'Water a snake plant only once the soil has dried, and very little in winter. It takes anything from low light to some sun; overwatering is what kills it.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The snake plant is as close to unkillable as houseplants get — and the one way people do kill it is kindness. It wants to be left alone, and most plant deaths here are an excess of attention, not a lack of it.',
    quickFacts: {
      water: 'Once the soil has dried out; very little in winter',
      light: 'Anything from low light to a few hours of direct sun',
      difficulty: 'Very easy — famously hard to kill',
      toxicity: 'Mildly toxic to cats and dogs if eaten',
      humidity: 'Dry household air is fine',
    },
    sections: {
      watering: [
        'Water a snake plant once the soil has dried out. Illinois Extension says to let it dry completely between waterings, and North Carolina State Extension says to let it dry from spring to autumn. Overwatering is the main reason these plants fail, and the roots rot in soil that stays wet, so a pot with a drainage hole matters.',
        'In winter, water far less. North Carolina State Extension puts it at once every one to two months. If you are not sure whether it needs water, it almost certainly does not. An [aloe vera](/care/aloe-vera) on the same windowsill also wants to dry out between drinks.',
      ],
      light: [
        'Snake plants are unbothered by light. They tolerate very low light, which is why they end up in offices and hallways, and Illinois Extension says they grow in anything from a dim interior to full sun. North Carolina State Extension suggests a spot with two to six hours of direct sun.',
        'Low humidity and cool rooms are fine too. North Carolina State Extension says it tolerates dry air and temperatures around 50°F.',
      ],
      problems: [
        'Soft, mushy, yellowing leaves at the base mean root rot — and root rot means too much water. This is the one real way to kill a snake plant. If you catch it early, stop watering, let it dry out hard, and it often recovers.',
        'Wrinkled or curling leaves are the rare opposite: it’s actually thirsty. Give it a proper soak and the leaves plump back up within a day or two.',
        'Leaves flopping over instead of standing upright usually means it’s been sitting in too-wet soil for too long, or the pot is too big and holds water it can’t use.',
      ],
      propagation: [
        'The quickest way to get a second snake plant is division: when you repot, slide it out, cut through the rhizome (the thick horizontal root) with a clean knife so each piece has leaves and roots, and pot each piece separately. Water lightly and let it settle for a few weeks.',
        'Leaf cuttings also work. Cut a leaf into 3–4 inch sections, keep track of which end was the bottom, let them dry for a day, and set the bottom end in barely damp soil or water. It is slow, often a couple of months before roots and longer before a new shoot, and a leaf cutting from a yellow-edged variety usually grows back plain green.',
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
        a: 'Once the soil has dried out, and as little as once every one to two months in winter, according to North Carolina State Extension. The sources give no fixed summer interval. If you are unsure, wait: overwatering is the main way snake plants die.',
      },
      {
        q: 'Why is my snake plant going soft and mushy?',
        a: 'The usual cause is root rot from too much water. Stop watering, let the soil dry out fully, and remove any mushy leaves. Make sure the pot drains.',
      },
      {
        q: 'Can a snake plant live in low light?',
        a: 'Yes. It tolerates very low light, and it also handles bright windows and some direct sun.',
      },
      {
        q: 'How long do snake plants live?',
        a: 'A long time. Snake plants are slow and tough, and many are kept for a decade or more. Because you can divide the rhizome when you repot, the same plant can keep going, and multiplying, far longer than that.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Dracaena trifasciata (Snake Plant)',
        url: 'https://plants.ces.ncsu.edu/plants/dracaena-trifasciata/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Illinois Extension',
        title: 'Mother-in-Law Tongue',
        url: 'https://extension.illinois.edu/houseplants/mother-law-tongue',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'monstera',
    commonName: 'Monstera',
    scientificName: 'Monstera deliciosa',
    alsoKnownAs: ['Swiss Cheese Plant', 'Split-Leaf Philodendron'],
    related: ['heartleaf-philodendron', 'fiddle-leaf-fig', 'bird-of-paradise'],
    metaTitle: 'How Often to Water a Monstera + Why No Leaf Holes',
    heading: 'Monstera care: how often to water it',
    metaDescription:
      'Water a monstera thoroughly, then let the top 1–2 inches of soil dry. The light it needs to grow leaf holes, and why leaves turn yellow or brown.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The monstera is the plant everyone wants for those dramatic split leaves — and the one people are surprised they have to earn. The holes aren’t automatic; they’re a reward for getting the light right.',
    quickFacts: {
      water: 'Thoroughly, once the top 1–2 inches of soil are dry',
      light: 'Bright light near a window; the sources differ on direct sun',
      difficulty: 'Easy to moderate',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalates)',
      humidity: 'Likes medium to high humidity; tolerates average rooms',
    },
    sections: {
      watering: [
        'Give a monstera a thorough drink, then wait until the top inch or two of soil has dried before the next one. That is Penn State Extension’s rule. Soil that never dries leads to root rot, so the pot must drain. There is no fixed interval in the sources, so let the soil make the call.',
        'Water less in winter, when it grows more slowly. A [bird of paradise](/care/bird-of-paradise) also wants less water in winter than in summer.',
      ],
      light: [
        'Light is what makes the famous holes. University of Wisconsin–Madison Extension says the leaves will not develop their perforations when the light is too low, and the splits come as the plant matures. In a dim spot it also gets leggy, with long bare stems.',
        'The sources differ on sun. Penn State Extension says bright light near a sunny window but not direct sun. University of Wisconsin–Madison Extension says bright light in summer and direct sun in winter. A spot near a bright window, out of strong summer sun, fits both.',
      ],
      problems: [
        'Yellow leaves usually mean overwatering — the same story as most houseplants. Check that the soil is drying between waterings and that the pot actually drains.',
        'Brown, crispy edges point to dry air or letting it get too thirsty. Monsteras like a bit more humidity than the average living room; a grouping of plants or the occasional misting helps, though it’s not essential.',
        'No splits on new leaves? That’s not a disease — it’s a light problem. A young monstera also simply isn’t old enough yet. Give it brighter light and time, and the new leaves come in with windows.',
      ],
      propagation: [
        'Propagate a monstera from a stem cutting that includes a node, ideally one with an aerial root already growing from it. A leaf with only its stalk and no node can root, but it will never grow a new plant. Cut just below the node, keep one or two leaves, and root it in water or damp sphagnum moss.',
        'Expect roots in about two to six weeks, faster in a warm, bright spot. Pot it into a chunky, free-draining mix once the roots are a few inches long, and give it a moss pole early if you want large, split leaves later.',
      ],
      sharedCare: [
        'A monstera is a big, visible, second-living-room-member kind of plant — which is exactly why its care slips through the cracks in a shared home. It’s too established to look thirsty quickly, so “it seems fine” becomes everyone’s reason not to water it, right up until it isn’t fine.',
        'For a plant this slow to complain, the move is a shared schedule rather than vibes. Decide who checks the soil and when, so the monstera isn’t quietly relying on four people each assuming one of the others did it. (A plant this expensive is worth a reminder neither of you can ignore.)',
      ],
      honestBit: [
        'Unpopular opinion: most “my monstera won’t fenestrate” problems are light problems wearing a costume. People reach for humidifiers and fertilizer and moss poles when the plant just needs to be a meter closer to the window. Fix light first; fix everything else second.',
        'And the moss pole is genuinely worth it once the plant is a year or two in — monsteras are climbers, and a supported, climbing monstera produces bigger, holier leaves than one flopping over the side of its pot. That part of the hype is real.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a monstera?',
        a: 'Water thoroughly, then wait until the top 1–2 inches of soil are dry, and water less in winter. The extension sources give no fixed number of days. Always let it drain: wet soil causes root rot.',
      },
      {
        q: 'Why doesn’t my monstera have holes in its leaves?',
        a: 'Usually not enough light, or the plant is still young. The splits develop as a monstera matures in bright light. Move it brighter and give it time.',
      },
      {
        q: 'Why are my monstera’s leaves turning yellow?',
        a: 'The sources do not tie yellow leaves to one cause, so check the basics: soil that stays wet and a pot that does not drain lead to root rot. Brown edges are different: University of Wisconsin–Madison Extension links them to humidity that is too low.',
      },
    ],
    careSources: [
      {
        publisher: 'Penn State Extension',
        title: 'Monstera as a Houseplant',
        url: 'https://extension.psu.edu/monstera-as-a-houseplant',
        accessed: '2026-11-03',
      },
      {
        publisher: 'University of Wisconsin–Madison Extension',
        title: 'Swiss-Cheese Plant, Monstera deliciosa',
        url: 'https://hort.extension.wisc.edu/articles/monstera-deliciosa/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'spider-plant',
    commonName: 'Spider Plant',
    scientificName: 'Chlorophytum comosum',
    alsoKnownAs: ['Airplane Plant', 'Ribbon Plant', 'Spider Ivy'],
    related: ['parlor-palm', 'boston-fern', 'hoya'],
    metaTitle: 'Spider Plant Care: How Often to Water It + Brown Tips',
    heading: 'Spider plant care: how often to water it',
    metaDescription:
      'Water a spider plant when the soil has dried slightly, and less in winter. It wants medium to bright light. Why the leaf tips go brown, and the babies.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'Water a spider plant thoroughly once the soil has dried slightly. It forgives missed waterings, shrugs off ordinary light, and hands you free copies of itself. Its one famous complaint, brown leaf tips, is usually about what’s in your tap water, not about your skill.',
    quickFacts: {
      water: 'Water thoroughly once the soil has dried slightly; less in winter',
      light: 'Medium to bright, indirect light; avoid midday sun',
      difficulty: 'Very easy',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA), though cats love chewing it',
      humidity: 'Average household humidity is fine; very dry air browns the tips',
    },
    sections: {
      watering: [
        'Water a spider plant thoroughly, then let the soil dry slightly before the next drink. University of Wisconsin–Madison Extension and Clemson Cooperative Extension both give that rule, and neither gives a number of days. Its thick roots store water, so it survives an uneven schedule.',
        'Water less in winter. The real danger is soil that stays wet: overwatering or a slow-draining mix leads to root rot. If you are not sure it needs water, wait a day or two.',
      ],
      light: [
        'Medium to bright light keeps a spider plant growing well indoors all year. Clemson Cooperative Extension says it does best in bright, indirect light, and North Carolina State Extension says medium light and that it can tolerate deep shade.',
        'Keep it out of strong direct sun. Clemson says some direct light is fine, but midday sun may scorch the leaves. There’s a reason this is the classic hanging-basket plant.',
      ],
      problems: [
        'Brown leaf tips are the spider plant complaint, and the usual culprits are the fluoride and chlorine in tap water, or very dry air. Switching to distilled, filtered, or rain water fixes it for most people. Existing brown tips never turn green again; snip them off at an angle and the plant looks fine.',
        'Yellow, limp leaves and mush at the base mean overwatering. The tuberous roots are a built-in water tank, and topping up a full tank rots it. Let the soil dry out fully and make sure the pot actually drains.',
        'No babies? A spider plant only sends out runners when it’s mature, slightly root-bound, and getting decent light. A young plant in a dim corner and a roomy pot has no reason to reproduce. Snug pot, brighter spot, patience.',
      ],
      propagation: [
        'Spider plants propagate themselves. The small plantlets (spiderettes) that dangle from the runners are ready once they show little root nubs at the base. Snip one off and sit its base in water, or pin it onto a pot of damp soil while it is still attached and cut the runner once it has rooted.',
        'Either way it takes a week or two and works almost every time. A crowded, pot-bound plant can also be divided at repotting by teasing the clump apart into sections that each have roots.',
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
        a: 'When the soil has dried slightly, with a thorough watering each time, and less in winter. The extension sources give no fixed number of days. Its thick roots store water, so it forgives a late watering far better than a constantly wet pot.',
      },
      {
        q: 'Why are my spider plant’s leaf tips turning brown?',
        a: 'Several causes, according to the extension sources: fluoride or chlorine in tap water, salts or too much fertilizer, low humidity, and soil that got too dry. University of Wisconsin–Madison Extension suggests distilled water or rainwater. Existing brown tips do not recover, so snip them off.',
      },
    ],
    careSources: [
      {
        publisher: 'University of Wisconsin–Madison Extension',
        title: 'Spider plant, Chlorophytum comosum',
        url: 'https://hort.extension.wisc.edu/articles/spider-plant-chlorophytum-comosum/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Spider Plant',
        url: 'https://hgic.clemson.edu/factsheet/spider-plant/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Chlorophytum comosum (Spider Plant)',
        url: 'https://plants.ces.ncsu.edu/plants/chlorophytum-comosum/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'peace-lily',
    commonName: 'Peace Lily',
    scientificName: 'Spathiphyllum',
    alsoKnownAs: ['Spath', 'Closet Plant', 'White Sail Plant'],
    related: ['anthurium', 'chinese-evergreen', 'lily'],
    metaTitle: 'Peace Lily Care: When to Water It + Is It Toxic?',
    heading: 'Peace lily care: how often to water it',
    metaDescription:
      'Water a peace lily when the soil has dried slightly; it wilts to warn you. Toxic to cats and dogs if chewed. Why the leaves brown, and why it won’t flower.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The peace lily is the rare plant that tells you out loud when it’s thirsty — it wilts dramatically, then springs back within hours of a drink. That theatrical droop makes it one of the easiest plants to read, and one of the most over-watered when people panic at the first sad leaf.',
    quickFacts: {
      water: 'Keep it moist, not soggy, and let it dry slightly between waterings',
      light: 'Bright, indirect light for flowers; tolerates low light; no direct sun',
      difficulty: 'Easy',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals)',
      humidity: 'Average rooms are fine; very dry air can brown the leaf tips',
    },
    sections: {
      watering: [
        'Keep a peace lily moist but never soggy, and let it dry slightly between waterings. That is the advice of Clemson Cooperative Extension and North Carolina State Extension, and neither gives a number of days. If the soil dries out too far, the plant wilts and the leaf edges yellow, so treat the droop as a sign you waited too long, not as your schedule.',
        'Never leave the pot standing in a saucer of water: Clemson says that leads to root rot. North Carolina State Extension adds that watering from below works well for this plant.',
      ],
      light: [
        'Clemson Cooperative Extension says a peace lily tolerates low light but grows best in bright, indirect light, and that young plants or plants in too little light usually do not flower. North Carolina State Extension says it prefers partial to deep shade. Either way, a dim corner keeps it alive but may not bring the white blooms people buy it for.',
        'Keep it out of direct sun, which scorches the broad leaves. Brown leaf tips can come from too much sun, too little water or low humidity. Despite the name it is not a true lily; for the plant that is, see the [lily](/care/lily) guide.',
      ],
      problems: [
        'Drooping leaves are usually just thirst — water it and watch it recover. If it droops even when the soil is wet, that’s the opposite problem: overwatering and the start of root rot. Check the soil before you reach for the watering can, because the same wilt has two opposite causes.',
        'Brown leaf tips point to dry air, or to fluoride and salts in tap water. Peace lilies are sensitive to both; switching to filtered or distilled water and nudging up the humidity usually settles it. Snip the brown off at an angle — it won’t turn green again.',
        'No flowers is almost always a light problem. A peace lily in a dark corner stays leafy and never blooms. Move it somewhere brighter (still indirect) and the white spathes tend to follow. If you want a houseplant that keeps flowering for months in bright, indirect light, the [anthurium](/care/anthurium) is the one to read about next.',
      ],
      propagation: [
        'Peace lilies are propagated by division, not cuttings. When the plant has filled its pot, ease it out in spring, find the natural clumps (crowns) in the root ball, and gently pull or cut them apart so each section keeps several leaves and a good share of roots.',
        'Pot each section in fresh mix at the same depth it was growing, water it in, and keep it out of strong light for a week or two while it recovers. Some drooping right after division is normal.',
      ],
      sharedCare: [
        'The peace lily is a gift in a shared home because it asks for help in a language everyone understands: when it needs water, it flops. Anyone walking past can see it and act, which is more than you can say for the plants that look fine right up until they’re dead.',
        'The trap is the same droop working against you. If three people each see the wilt and each water it, the plant gets watered three times and rots. So the rule is one waterer, or a shared note of who did it last — let the plant’s honesty work for you instead of triggering a pile-on. (Family Greenhouse logs who watered and when, but a sticky note on the pot does the same job.)',
      ],
      honestBit: [
        'My take: the name does this plant a disservice. People hear “lily,” assume it’s the cat-killer their vet warned them about, and either avoid it or panic. It isn’t a true lily at all — it won’t cause the kidney failure that real lilies (Lilium) do. It’s toxic in the ordinary mouth-irritation way, which is worth knowing but isn’t the emergency the name implies.',
        'If you want to be sure about any plant before it comes home to a pet, run it through the [free pet-safe checker](/pet-safe) first — two seconds, no signup, and it spells out cats versus dogs rather than a vague “toxic.”',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a peace lily?',
        a: 'When the soil has dried slightly. Keep it moist but not soggy, and do not let it sit in standing water, which causes root rot. It wilts when it gets too dry. The extension sources give no fixed number of days.',
      },
      {
        q: 'Why is my peace lily drooping?',
        a: 'Most often thirst: the extension sources say it wilts when the soil dries out too much. If it droops while the soil is still wet, check that the pot drains, because standing water rots the roots.',
      },
      {
        q: 'Why won’t my peace lily flower?',
        a: 'Usually too little light, or a plant under a year old, according to Clemson Cooperative Extension. Move it to bright, indirect light, out of direct sun, and give it time.',
      },
    ],
    careSources: [
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Peace Lily',
        url: 'https://hgic.clemson.edu/factsheet/peace-lily/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Spathiphyllum (Peace Lily)',
        url: 'https://plants.ces.ncsu.edu/plants/spathiphyllum/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'heartleaf-philodendron',
    commonName: 'Heartleaf Philodendron',
    scientificName: 'Philodendron hederaceum',
    alsoKnownAs: ['Sweetheart Plant', 'Philodendron', 'Philodendron scandens'],
    related: ['pothos', 'monstera', 'hoya'],
    metaTitle: 'Heartleaf Philodendron Care: Keep It Lightly Moist',
    heading: 'Heartleaf philodendron care: how often to water it',
    metaDescription:
      'Keep a heartleaf philodendron’s soil lightly moist, never soggy, and water less in winter. It copes with low light, and it’s toxic to cats and dogs if chewed.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The heartleaf philodendron is the plant people confuse with pothos, and for good reason — same trailing habit, same near-indestructible temperament, same forgiving nature. It’s one of the genuinely easy ones, and a great vine for a beginner who wants something prettier than they had to work for.',
    quickFacts: {
      water: 'Keep the soil lightly and evenly moist, never soggy; less in winter',
      light: 'Bright, indirect light; tolerates very low light',
      difficulty: 'Very easy',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals)',
      humidity: 'Prefers more humidity, but tolerates the dry air of most homes',
    },
    sections: {
      watering: [
        'Keep a heartleaf philodendron’s soil lightly moist. Clemson Cooperative Extension says evenly moist but not soggy, and North Carolina State Extension says slightly moist. That makes it thirstier than its look-alike, the pothos, which the extension sources say to let dry between waterings. Neither source gives a number of days.',
        'Slow down in winter. The one reliable way to kill it is soggy soil: a mix that drains slowly, or a pot left standing in water, leads to root rot.',
      ],
      light: [
        'Bright, indirect light suits it best, and it should stay out of direct sun. It is also one of the plants the extension sources single out for tolerating very low light, which is why it ends up on shelves and in bathrooms.',
        'Clemson Cooperative Extension says high humidity is ideal but that philodendrons tolerate the low humidity of most homes. North Carolina State Extension says it appreciates misting.',
      ],
      problems: [
        'Yellow leaves are usually overwatering, the same story as most trailing plants. Let the soil dry between waterings and confirm the pot drains. A single old leaf yellowing low on the vine is normal aging, not a problem.',
        'Brown, crispy tips point the other way — too dry, or very dry air. A miss here and there is fine; consistent crisping means it’s getting too thirsty or the room is parched.',
        'Long, bare, leggy vines mean it’s reaching for light. Move it brighter, and pinch the growing tips to push it to branch and fill out rather than race for the window.',
      ],
      propagation: [
        'Propagate it exactly like a pothos: cut a piece of vine just below a node, remove the lowest leaf, and put the node in water or straight into damp potting mix. Roots usually show in two to three weeks.',
        'Several cuttings potted together make a fuller plant much faster than one. Pinching a leggy vine back and rooting the tips is also the easiest way to thicken up a sparse plant.',
      ],
      sharedCare: [
        'The heartleaf philodendron has the same shared-home trap as pothos: it’s so easy that everyone assumes someone else is handling it, and it limps along on neglect until it doesn’t. The failure mode isn’t a difficult plant — it’s “I thought you watered it.”',
        'The fix is unglamorous and reliable: one named owner, or an out-loud agreement about who waters on which day. The cuttings root in a glass of water in a week or two, so it’s also a great plant to split between housemates — everyone gets a start, everyone has a reason to keep theirs alive. (Family Greenhouse can track whose vine each cutting becomes, but a labelled jar works too.)',
      ],
      honestBit: [
        'My take: if you already have a pothos and want a second easy vine that looks a bit more refined, this is the one to get — the heart-shaped leaves are softer and tidier, and it’s every bit as forgiving. Don’t agonise over telling them apart; care for them identically and both will thrive.',
        'It is, however, toxic to cats and dogs if chewed — the whole philodendron genus carries calcium oxalate crystals. A trailing vine is exactly the kind of dangling temptation a cat bats at, so hang it high. If you’re weighing it against a pet-safe pick, the [free pet-safe checker](/pet-safe) gives you the cats-versus-dogs answer in a couple of seconds.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a heartleaf philodendron?',
        a: 'Often enough to keep the soil lightly and evenly moist, never soggy, and less in winter. The extension sources give no fixed number of days. Make sure the pot drains.',
      },
      {
        q: 'What’s the difference between a philodendron and a pothos?',
        a: 'They look alike, and their light needs are the same: bright, indirect light, with tolerance for low light. Watering differs. The extension sources say to keep a philodendron lightly moist and to let a pothos dry between waterings. Heartleaf philodendron leaves are thinner, softer, and a deeper matte green with a more pointed heart shape; pothos leaves are thicker, glossier, and often variegated. The [pothos care guide](/care/pothos) covers the other plant.',
      },
      {
        q: 'Why is my philodendron getting leggy?',
        a: 'Long, bare vines with big gaps between leaves are a common sign of too little light. Move it somewhere brighter, still out of direct sun, and pinch the growing tips to encourage it to branch and fill out.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Philodendron hederaceum (Heartleaf Philodendron)',
        url: 'https://plants.ces.ncsu.edu/plants/philodendron-hederaceum/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Philodendron',
        url: 'https://hgic.clemson.edu/factsheet/philodendron-pothos-monstera/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'zz-plant',
    commonName: 'ZZ Plant',
    scientificName: 'Zamioculcas zamiifolia',
    alsoKnownAs: ['Zanzibar Gem', 'Zamioculcas', 'Zuzu Plant'],
    related: ['snake-plant', 'chinese-evergreen', 'parlor-palm'],
    metaTitle: 'How Often to Water a ZZ Plant: About Every 2 Weeks',
    heading: 'ZZ plant care: how often to water it',
    metaDescription:
      'Water a ZZ plant about every 2 weeks in summer, once the soil is dry, and about once a month in winter. Plus the light it takes and why stems go mushy.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The ZZ plant is the one you buy when you’ve decided you’re bad with plants. Thick underground rhizomes store water for weeks, the glossy leaves shrug off dim light, and the only real way to kill it is to care too much. It’s as close to a houseplant you can ignore as exists.',
    quickFacts: {
      water: 'About every 2 weeks in summer, once dry; monthly in winter',
      light: 'Low to bright, indirect light; no direct sun',
      difficulty: 'Very easy — famously hard to kill',
      toxicity: 'Unknown: the ASPCA plant list has no entry for the ZZ plant',
      humidity: 'Grows in ordinary room air',
    },
    sections: {
      watering: [
        'Water a ZZ plant thoroughly, then let the soil dry before the next drink. North Carolina State Extension says twice a month in summer, and only if the soil has dried out completely. Iowa State University Extension says a thorough watering every 7 to 14 days is usually fine. Those potato-like rhizomes under the soil store water, so the plant copes with drought far better than with wet feet.',
        'In winter, when it is not actively growing, North Carolina State Extension says to water only once a month. The single most useful habit with a ZZ is restraint: if the soil is still damp, it does not need water.',
      ],
      light: [
        'ZZ plants tolerate very low light, even rooms lit only by fluorescent bulbs, which is why they end up in lobbies and offices. Both extension sources say they do best in bright, indirect light.',
        'Avoid direct sun. North Carolina State Extension says it can scald and brown the leaves, and Iowa State University Extension warns about direct afternoon sun.',
      ],
      problems: [
        'Yellowing stems and leaves, especially with a soft mushy base, mean overwatering and rhizome rot — the one genuine way to kill a ZZ. Stop watering, let it dry out hard, and check the rhizomes are firm rather than soft. Caught early, it often recovers.',
        'Wrinkled stems or curling leaflets are the rare opposite: it’s actually thirsty, which takes real neglect to achieve. A proper soak fixes it within a day or two.',
        'A few yellow lower leaves on an otherwise firm plant are usually just normal aging. It’s the soft, mushy, spreading kind of yellowing you watch for, not the occasional dropped leaf.',
      ],
      propagation: [
        'The reliable way to multiply a ZZ is division. When you repot, you will see the potato-like rhizomes; separate the clump into pieces that each have a rhizome, stems and roots, and pot them up in a gritty, fast-draining mix. Water sparingly until new growth appears.',
        'Single stems and even individual leaflets will root in water or barely damp soil, but slowly: it can take several months for a cutting to grow a rhizome and longer still for a new shoot. It works, it just needs patience.',
      ],
      sharedCare: [
        'The ZZ’s superpower — needing almost nothing — is also its shared-home trap. Two people who each “just topped it up” twice a month have, between them, watered a drought plant four times, and a ZZ killed by enthusiasm is far more common than one killed by neglect.',
        'So the rule here is the opposite of fussier plants: agree that one person waters it, and everyone else keeps their watering can away. Less coordination, not more — the coordination you want is simply “hands off, it’s fine.”',
      ],
      honestBit: [
        'My take: the ZZ is the plant to buy when every other plant has died on you, because the one mistake it punishes, watering too much, is the easiest habit to stop. Water less than feels right and it will very likely outlive your interest in it.',
        'On pets we don’t give a verdict for this one. The ASPCA plant list, the source this site uses for pet toxicity, has no entry for the ZZ plant, and we won’t guess. If you have a pet that chews, keep it out of reach, or pick a hardy plant with a cited answer, such as the [parlor palm](/care/parlor-palm), from the [free pet-safe checker](/pet-safe).',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a ZZ plant?',
        a: 'About every two weeks in summer, and only once the soil has dried; about once a month in winter. North Carolina State Extension gives twice a month in summer, and Iowa State University Extension says every 7 to 14 days is usually fine. Its rhizomes store water, so when unsure, wait.',
      },
      {
        q: 'Why is my ZZ plant turning yellow?',
        a: 'Soft, mushy yellowing at the base is overwatering and rhizome rot — the main ZZ killer. Stop watering, let it dry out fully, and check the rhizomes are firm. A few yellow lower leaves on an otherwise healthy plant are just normal aging.',
      },
      {
        q: 'Can a ZZ plant survive in low light?',
        a: 'Yes. It grows in very low light, even under fluorescent lights alone, though both extension sources say it does best in bright, indirect light.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Zamioculcas zamiifolia (ZZ Plant)',
        url: 'https://plants.ces.ncsu.edu/plants/zamioculcas-zamiifolia/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Iowa State University Extension',
        title: 'The ZZ Plant',
        url: 'https://yardandgarden.extension.iastate.edu/article/2009/2-4/Zamioculcas.html',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'aloe-vera',
    commonName: 'Aloe Vera',
    scientificName: 'Aloe vera',
    alsoKnownAs: ['Medicine Plant', 'Burn Plant', 'Aloe'],
    related: ['jade-plant', 'snake-plant', 'haworthia'],
    metaTitle: 'How Often to Water Aloe Vera: When the Top Inch Is Dry',
    heading: 'Aloe vera care: how often to water it',
    metaDescription:
      'Water aloe vera well when the top inch of soil is dry, and much less in winter. It wants a sunny window. Plus why the leaves go mushy or sunburned.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'Aloe vera is a succulent that stores water in its leaves, so it shrugs off a missed drink and suffers from too many. Give it a sunny window, water it well only when the top of the soil has dried, and never leave it standing in water. Most aloe deaths are kindness, not neglect.',
    quickFacts: {
      water: 'Water well when the top inch of soil is dry; much less in winter',
      light: 'Full sun to bright, indirect light, such as a sunny window',
      difficulty: 'Easy, if you under-water it',
      toxicity: 'Toxic to cats and dogs if eaten (per the ASPCA)',
      humidity: 'No figure in the sources; it is drought-tolerant and grown in room air',
    },
    sections: {
      watering: [
        'Water an aloe when the top inch of soil is dry to the touch, and when you do, water it well. UF/IFAS Gardening Solutions gives that top-inch rule, and Penn State Extension says to water thoroughly once the surface is dry during the growing season, from early spring to early fall. Neither gives a number of days.',
        'From fall through winter, cut back: Penn State Extension says to keep the soil only barely moist then, just enough that the leaves do not shrivel. Aloe stores water in its leaves, stems and roots, so it tolerates dry spells, and the same source advises erring on the side of underwatering.',
        'Never let it sit in water. Use a pot with good drainage holes, empty the saucer, and avoid a pot much bigger than the plant, since extra soil holds moisture that can rot the roots. A [jade plant](/care/jade-plant) is another succulent that wants its soil to dry between waterings.',
      ],
      light: [
        'Aloe wants a lot of light. Penn State Extension says it grows best, keeps its color and flowers in full to partial sun, and that indoors it belongs near a sunny window. Turn the pot now and then so every side gets light.',
        'If it has been somewhere dim, move it into stronger light gradually: UF/IFAS Gardening Solutions warns that a sudden jump from low to bright light can sunburn it. A smaller rosette that looks like a miniature aloe, the [haworthia](/care/haworthia), wants a gentler east or west window.',
      ],
      problems: [
        'Mushy, translucent, or brown leaves at the base mean overwatering and rot — by far the most common way aloe dies. Stop watering, let it dry out hard, and repot into gritty mix if the soil stays wet. Soft leaves are almost never thirst.',
        'Thin, curled, or puckered leaves are the genuine thirst signal, and it takes real neglect to get there. A proper soak plumps them back up within a few days.',
        'Pale, stretched, flopping growth means not enough light. Aloe leaves should be firm and upright; when they splay out and lean, move it to your sunniest window.',
        'Brown or reddish patches on leaves that have been moved into stronger sun are sunburn. Move the plant back from the strongest sun a little and step the exposure up more slowly next time.',
      ],
      propagation: [
        'Aloe is propagated from its offsets, the small "pups" that grow around the base of the mother plant. Once a pup is a few inches tall and has some roots of its own, separate it with a clean knife at repotting time.',
        'Let the cut end dry for a day or two, then pot it in a gritty cactus mix and wait about a week before the first light watering. Cut leaves from the mother plant almost always rot instead of rooting, so stick to pups.',
      ],
      sharedCare: [
        'Aloe is a classic “killed by teamwork” plant in a shared home. Because it needs watering so rarely, two well-meaning people each giving it an occasional drink adds up to a soggy, rotting succulent. The plant that asks for almost nothing gets too much from too many hands.',
        'The fix is to make “leave it alone” the explicit plan: one person waters it, on a long interval, and everyone else admires it from a distance with the watering can elsewhere. For a plant this drought-loving, good shared care mostly means agreeing not to help.',
      ],
      honestBit: [
        'My take: keep one in the kitchen — snapping off a leaf for the cool gel inside really does take the sting out of a minor burn, and that’s a genuinely useful plant to have within reach. Just don’t over-love it; the number-one cause of a dead aloe is a watering schedule meant for a fern.',
        'Worth being clear on the pet question, because the “medicine plant” reputation misleads people: the ASPCA lists aloe as toxic to cats and dogs, naming saponins and anthraquinones and listing vomiting, lethargy and diarrhea as the signs. Its listing calls the gel edible, but the plant is still on the toxic list, so treat the whole plant as something to keep out of reach. If a pet has eaten some, call your vet or a poison hotline rather than waiting to see what happens. The [aloe vera pet-safety page](/pet-safe/aloe-vera) shows the cat and dog verdicts beside the ASPCA listing, and the [free pet-safe checker](/pet-safe) covers other plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an aloe vera?',
        a: 'When the top inch of soil is dry, water it well, and cut back from fall through winter so the soil stays only barely moist. The extension sources give no fixed number of days. Never leave it standing in water: overwatering and root rot are the main way aloe dies.',
      },
      {
        q: 'Why is my aloe vera going mushy or brown?',
        a: 'Soft, mushy leaves usually go with too much water and rotting roots. Stop watering until the top of the soil is dry, empty any standing water, and check that the pot drains. Brown or discolored patches after a move into strong sun are more likely sunburn.',
      },
      {
        q: 'Why is my aloe vera flopping over?',
        a: 'Usually too little light. Aloe wants a sunny window, with full to partial sun. Move it somewhere brighter, gradually if it has been in a dim spot, and new growth should come in firmer.',
      },
      {
        q: 'How do I know when my aloe vera needs water?',
        a: 'Check the soil: when the top inch is dry to the touch, it is time to water well. In winter, give only enough to keep the leaves from shriveling. Shriveled leaves mean it has gone too dry, and soft, mushy leaves usually mean too much water.',
      },
      {
        q: 'Does an aloe vera need direct sun?',
        a: 'It does best in full to partial sun, near a sunny window. Bright, indirect light also works. If it has been somewhere dim, move it into stronger light gradually, or the leaves can sunburn.',
      },
      {
        q: 'How do you propagate an aloe vera?',
        a: 'Use the pups that grow around the base. When a pup is a few inches tall and has roots of its own, separate it with a clean knife, let the cut end dry for a day or two, and pot it in gritty cactus mix. Wait about a week before a light watering. Cut leaves almost always rot instead of rooting.',
      },
    ],
    careSources: [
      {
        publisher: 'Penn State Extension',
        title: 'Aloe, a Hardy Houseplant',
        url: 'https://extension.psu.edu/aloe-a-hardy-houseplant',
        accessed: '2026-11-03',
      },
      {
        publisher: 'UF/IFAS Gardening Solutions',
        title: 'Aloe Vera',
        url: 'https://gardeningsolutions.ifas.ufl.edu/plants/ornamentals/aloe-vera/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'dieffenbachia',
    commonName: 'Dieffenbachia',
    scientificName: 'Dieffenbachia',
    alsoKnownAs: ['Dumb Cane', 'Leopard Lily'],
    related: ['chinese-evergreen', 'peace-lily', 'rubber-plant'],
    metaTitle: 'Dieffenbachia (Dumb Cane) Care: Watering, Light + Toxicity',
    metaDescription:
      'How often to water a dieffenbachia, the light it likes, why the leaves yellow or brown, and why it’s one to keep away from pets and kids.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'Dieffenbachia gives you big, splashy, tropical leaves for not much effort — a lot of visual payoff for an easy plant. The catch is in the old name, dumb cane: its sap is among the harsher of the common houseplants, so it’s a striking plant that comes with a real keep-out-of-reach asterisk.',
    quickFacts: {
      water: 'Water thoroughly, then wait until the top inch of soil is dry',
      light: 'Bright, filtered light; tolerates lower light; shield it from hot direct sun',
      difficulty: 'Easy to moderate',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals, per the ASPCA)',
      humidity: 'Prefers relatively high humidity',
    },
    sections: {
      watering: [
        'Water a dieffenbachia thoroughly, then let the top inch of soil dry before the next drink. Clemson Cooperative Extension and North Carolina State Extension both give that rule, and UF/IFAS Gardening Solutions says to keep the routine fairly regular, since uneven watering can brown the leaf tips. None of them gives a number of days.',
        'The usual killer is too much water. Overly frequent watering or a mix that drains slowly leads to root rot, so never leave the pot standing in water.',
      ],
      light: [
        'Bright, filtered light suits it from spring to fall, according to Clemson Cooperative Extension, which adds that it tolerates low light with slower growth. UF/IFAS Gardening Solutions says it will take full shade. North Carolina State Extension says to protect it from direct sun, while Clemson says bright light, even direct sun, is best in winter, so the strong summer sun is the one to avoid.',
        'If it is stretching and leaning toward the window, or its growth has slowed or stopped, it needs more light: move it somewhere brighter. Both UF/IFAS and North Carolina State say it prefers relatively high humidity, and keep it away from cold drafts.',
      ],
      problems: [
        'Yellow lower leaves usually mean overwatering; let the soil dry more between drinks and confirm the pot drains. A soft, mushy, darkening stem base is stem rot — the serious version of the same problem, and a reason to cut back hard on water immediately.',
        'Brown, crispy leaf edges point to dry air, underwatering, or cold drafts. Dieffenbachia likes a bit more humidity than the average room and dislikes sitting near a cold window or an air-conditioning vent.',
        'Drooping that doesn’t recover after watering, especially with a soft base, is stem rot rather than thirst. Caught early, you can sometimes save the plant by cutting above the rot and re-rooting a healthy section of cane.',
      ],
      propagation: [
        'Dieffenbachia roots from pieces of its cane. Cut the top off a leggy plant to root as a tip cutting, and slice the bare cane below into 2–3 inch sections that each carry at least one node; lay them on their side, half buried, in damp mix. Wear gloves when you cut it.',
        'Tip cuttings also root in water. Either way, warmth and bright indirect light speed things up, and new shoots usually appear within a few weeks. The cut stump left in the pot will often resprout as well.',
      ],
      sharedCare: [
        'In a shared home, dieffenbachia’s steady, even-moisture preference makes a shared schedule worthwhile — it doesn’t wilt theatrically like a peace lily, so it can quietly drift into too-dry or too-wet without anyone clocking it until the leaves complain. Agree who checks the soil and when, so it isn’t silently relying on four people who each assume someone else did it.',
        'The bigger shared-home point with this one is placement, not watering. It is one of the harsher plants for pets that chew, so in a house with pets, or small children who put things in their mouths, the right move is to put it somewhere nobody chews or grabs it — high shelf, out of reach — and make that a deliberate, agreed decision rather than wherever it happened to land.',
      ],
      honestBit: [
        'My take: this is a beautiful plant I’d happily recommend to a household with no pets, and one I’d think twice about for anyone with a chewer. The ASPCA lists it as toxic to cats and dogs, and the signs it lists go beyond a mildly sore mouth: intense burning of the mouth, tongue and lips, drooling, vomiting and difficulty swallowing.',
        'If you’re not sure a plant is right for your home, that’s exactly what the [free pet-safe checker](/pet-safe) is for — it gives you a plain cats-versus-dogs verdict in a couple of seconds, and points you to genuinely safe alternatives if dieffenbachia is the wrong fit.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a dieffenbachia?',
        a: 'Water thoroughly, then wait until the top inch of soil is dry before watering again. The extension sources give no fixed number of days. Keep the routine fairly regular, and make sure the pot drains: overly frequent watering leads to root rot.',
      },
      {
        q: 'Why are my dieffenbachia leaves turning yellow?',
        a: 'Yellowing has more than one cause. Clemson Cooperative Extension links yellow, smaller leaves to a lack of nutrients, and soggy soil leads to root rot, so check drainage before you water again. Brown tips can come from uneven watering or too much fertilizer.',
      },
      {
        q: 'Why is my dieffenbachia leggy and leaning?',
        a: 'It is reaching for light. Move it to a brighter spot, out of strong summer sun, and turn the pot now and then so it grows evenly.',
      },
    ],
    careSources: [
      {
        publisher: 'UF/IFAS Gardening Solutions',
        title: 'Dieffenbachia',
        url: 'https://gardeningsolutions.ifas.ufl.edu/plants/houseplants/dieffenbachia/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Dieffenbachia',
        url: 'https://hgic.clemson.edu/factsheet/dieffenbachia/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Dieffenbachia seguine',
        url: 'https://plants.ces.ncsu.edu/plants/dieffenbachia-seguine/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'calathea',
    commonName: 'Calathea',
    scientificName: 'Goeppertia (formerly Calathea)',
    alsoKnownAs: ['Rattlesnake Plant', 'Peacock Plant', 'Goeppertia'],
    related: ['nerve-plant', 'boston-fern', 'parlor-palm'],
    metaTitle: 'Calathea Care: How Often to Water + Are They Pet-Safe?',
    metaDescription:
      'How often to water a calathea, the humidity and water quality it demands, why the leaves curl or crisp, and why it’s a pet-safe choice.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'Calatheas have the most beautiful foliage of any common houseplant and the shortest temper. The trade-off is honest: stunning patterned leaves that fold up at night like praying hands, in exchange for fussiness about water, humidity, and what comes out of your tap. The pay-off, if you want it, is real.',
    quickFacts: {
      water: 'Keep the soil moist but not soggy',
      light: 'Bright, indirect light; no direct sun',
      difficulty: 'Moderate to fussy',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'High humidity, above 60% by one source; dry air browns the edges',
    },
    sections: {
      watering: [
        'Keep a calathea’s soil moist but never soggy or wet. That is North Carolina State Extension’s advice, and it gives no number of days, so check the soil with a finger rather than the calendar. Unlike the succulents on this site, it should not dry out hard between drinks: the same source says leaves curl when the plant gets too little water or the air is too dry. Overwatering causes root rot.',
        'Water quality matters. North Carolina State Extension says to use rainwater or distilled water, because the fluoride in tap water can turn the leaves brown.',
      ],
      light: [
        'Bright, indirect light is what both sources recommend. The RHS suggests an east-facing windowsill, and both warn that direct sun scorches the leaves.',
        'Too little light makes the bright coloring fade. Humidity matters as much as light: North Carolina State Extension gives above 60% and suggests a humidifier or a tray of wet pebbles. The leaves fold and move through the day in response to light and temperature, which is normal.',
      ],
      problems: [
        'Brown, crispy leaf edges are the signature calathea complaint, and the usual culprits are dry air and tap water. Raise the humidity and switch to filtered or distilled water; existing brown edges won’t turn green again, so trim them and judge by the new growth.',
        'Curling leaves that don’t unfurl by day mean it’s too dry — either thirsty soil or parched air. A good drink and more humidity usually relax them. (A gentle nightly curl that opens each morning, by contrast, is just the plant’s normal rhythm.)',
        'Yellowing leaves point to overwatering or soggy soil — the line between “evenly moist” and “waterlogged” is narrow with calatheas. Make sure the pot drains and the soil isn’t staying wet for days.',
      ],
      propagation: [
        'Calatheas are propagated by division only; stem and leaf cuttings will not root. In spring, ease the plant out of its pot and separate the clumps, keeping each section with several leaves and plenty of roots.',
        'Pot the divisions in a moist, airy mix, water them in, and keep the humidity high while they settle. Expect a sulk of a few weeks with some curled or browned leaves before new growth starts.',
      ],
      sharedCare: [
        'Calathea is the high-maintenance member of a shared collection, so it benefits most from one clear owner rather than a committee. Its needs are specific — filtered water, steady moisture, real humidity — and they’re easy to get wrong when several people each do their own version of “looking after it.”',
        'If you do share it, the thing to write down isn’t just when it was watered but how: filtered water, not tap. A grouping with other plants, or a spot in a naturally humid room like a bright bathroom, does a lot of the humidity work for you and takes some pressure off the schedule. (Family Greenhouse can hold those care notes against the plant so they don’t live only in one person’s head.)',
      ],
      honestBit: [
        'My take: the good news that makes calathea worth the trouble — it’s genuinely pet-safe. The ASPCA lists calatheas as non-toxic to both cats and dogs, which is rare for a plant this showy. If you’ve got a leaf-chewing cat and you’re tired of hanging everything out of reach, a calathea is one of the few statement plants you can put at floor level without worry.',
        'So the honest pitch is this: calathea asks more of you than almost anything else here, but it pays you back with both the best foliage and a clean bill of health for your pets. If pet safety is the deciding factor, the [free pet-safe checker](/pet-safe) confirms it — and lists other safe choices if you’d rather start with something more forgiving.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a calathea?',
        a: 'Often enough to keep the soil moist but not soggy. The extension sources give no fixed number of days, so check with a finger. Use rainwater or distilled water, since fluoride in tap water can brown the leaves.',
      },
      {
        q: 'Why are my calathea’s leaves turning brown and crispy at the edges?',
        a: 'The two causes North Carolina State Extension names are low humidity and fluoride in tap water. Raise the humidity and switch to rainwater or distilled water. Trim the damaged edges and watch the new growth.',
      },
      {
        q: 'Why are my calathea leaves curling?',
        a: 'Curling comes from low humidity or too little water, so check the soil and raise the humidity. Leaves that fold and move with the light through the day are normal.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Goeppertia roseopicta (Rose-Painted Calathea)',
        url: 'https://plants.ces.ncsu.edu/plants/goeppertia-roseopicta/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'RHS',
        title: 'Calatheas',
        url: 'https://www.rhs.org.uk/plants/calathea',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'fiddle-leaf-fig',
    commonName: 'Fiddle Leaf Fig',
    scientificName: 'Ficus lyrata',
    alsoKnownAs: ['Fiddle-Leaf Fig', 'Banjo Fig', 'Ficus lyrata'],
    related: ['rubber-plant', 'bird-of-paradise', 'monstera'],
    metaTitle: 'Fiddle Leaf Fig Care: Watering + Is It Toxic to Dogs?',
    heading: 'Fiddle leaf fig care and pet safety',
    metaDescription:
      'A fiddle leaf fig is toxic to cats and dogs if chewed (the ASPCA lists Ficus species as toxic). Keep the soil moist but well-drained and the light bright.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The fiddle leaf fig is the most photographed and most returned houseplant there is. It isn’t difficult so much as inflexible: it wants one bright spot and the same routine every week, and it registers a complaint about anything else.',
    quickFacts: {
      water: 'Keep it moist but well-drained; it is sensitive to overwatering',
      light: 'Bright light; the sources differ on direct sun, so shield it from afternoon sun',
      difficulty: 'Moderate — fussy about change, not about care',
      toxicity: 'Toxic to cats and dogs if chewed (the ASPCA lists Ficus species as toxic)',
      humidity: 'Medium humidity; keep it away from heating and cooling vents',
    },
    sections: {
      watering: [
        'A fiddle leaf fig wants soil that is moist but well-drained. North Carolina State Extension says it is sensitive to overwatering, and that leaves can drop from too much water or from too little. Neither source gives a number of days, so check the soil with a finger before each drink.',
        'When you do water, water thoroughly and let the pot drain, then empty the saucer so the roots are not left standing in water.',
      ],
      light: [
        'This is a plant that wants a lot of light, but the sources differ on sun. The RHS lists full sun and a south- or west-facing aspect. North Carolina State Extension says bright, indirect light or partial shade, protected from afternoon sun, and warns that too much direct sun scorches the leaves. A bright window with morning sun, or a bright spot shaded from hot afternoon sun, fits both.',
        'It does best in medium humidity and above 55°F. North Carolina State Extension says brown spots can appear when room temperatures swing near heating or cooling vents, so keep it away from them. Turn the pot a little each time you water so it grows evenly.',
      ],
      problems: [
        'Brown spots in the middle of a leaf, with a dark edge, usually mean root rot from too much water or a pot with no drainage. Brown patches that start at the leaf edge and creep inward are more often underwatering or dry air. It’s worth looking closely before you reach for the watering can, because the two look similar and the fixes are opposite.',
        'Sudden leaf drop after you move it, repot it, or turn the heating on is a stress response, not a death sentence. Put it somewhere bright and stable, water on your normal schedule, and stop fussing. Most recover once the conditions stop changing.',
        'Bare, leggy stems with leaves only at the top mean not enough light. New growth won’t fill in the bottom on its own — you can prune the top to force branching, but the real fix is a brighter spot.',
      ],
      propagation: [
        'Fiddle leaf figs root from stem cuttings. Take a cutting with at least one node and a leaf or two, let the milky sap stop running, and root it in water or a damp, airy mix in bright indirect light. Rooting is slow, often three to six weeks or more.',
        'For a thick, woody branch, air layering is more reliable: wound the stem, wrap it in damp sphagnum moss and plastic, and cut it free once roots fill the moss. A single leaf will sometimes root, but it rarely grows into a plant.',
      ],
      sharedCare: [
        'The fiddle leaf fig is the plant most likely to be killed by two people caring for it kindly. It is sensitive to overwatering, so if you each water it “when it looks a bit dry,” it gets twice what it needs and suffers quietly from the bottom.',
        'Make it a one-owner plant, or write down the date every time it gets watered so the second person can see it’s been done. This is the plant where a shared log earns its keep — the damage from double-watering takes weeks to show, and by then the cause is invisible.',
      ],
      honestBit: [
        'My honest take: don’t buy one first. A fiddle leaf fig is a plant for someone who already knows how their home behaves in winter — where the drafts are, which window still gets light in February, how fast a pot dries out. Learn that on a pothos, then buy the fig.',
        'And if yours drops a few leaves in the first month home, that’s normal and almost everybody panics about it. Give it one bright spot, a steady week, and no interventions. The plant isn’t asking for more attention; it’s asking for less change.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a fiddle leaf fig?',
        a: 'The extension sources give no fixed number of days. Keep the soil moist but well-drained, check it with a finger, and water thoroughly when it is drying out, then empty the saucer. It is sensitive to overwatering.',
      },
      {
        q: 'Why is my fiddle leaf fig dropping leaves?',
        a: 'North Carolina State Extension says leaf drop can come from too much or too little water, and brown spots from temperature swings near heating or cooling vents. Check the soil before you water, and keep it in one bright, stable spot away from vents.',
      },
      {
        q: 'What kind of light does a fiddle leaf fig need?',
        a: 'A lot of light. The RHS lists full sun and a south- or west-facing aspect, and North Carolina State Extension says bright, indirect light with protection from afternoon sun, since too much direct sun scorches the leaves. A bright window with morning sun suits both.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Ficus lyrata (Fiddle-leaf Fig)',
        url: 'https://plants.ces.ncsu.edu/plants/ficus-lyrata/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'RHS',
        title: 'Ficus lyrata, fiddle-leaf fig',
        url: 'https://www.rhs.org.uk/plants/7207/ficus-lyrata/details',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'rubber-plant',
    commonName: 'Rubber Plant',
    scientificName: 'Ficus elastica',
    alsoKnownAs: ['Rubber Tree', 'Rubber Fig', 'Ficus elastica'],
    related: ['fiddle-leaf-fig', 'money-tree', 'dieffenbachia'],
    metaTitle: 'Rubber Plant Care: When to Water a Ficus Elastica',
    heading: 'Rubber plant care: how often to water it',
    metaDescription:
      'Water a rubber plant (Ficus elastica) thoroughly, then let the soil dry slightly, and water less in fall and winter. It wants bright light. Why leaves drop.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'A rubber plant is what you buy when you want the drama of a fiddle leaf fig without the temperament. Same big glossy leaves, same architectural shape, a fraction of the sulking — it’s the easiest large statement plant you can own.',
    quickFacts: {
      water: 'Water thoroughly, then let the soil dry slightly; less from fall to late winter',
      light: 'Bright, indirect light; adapts to lower light',
      difficulty: 'Easy',
      toxicity: 'Toxic to cats and dogs if chewed (the ASPCA lists Ficus species as toxic)',
      humidity: 'Prefers humid air but tolerates the dry air of most homes',
    },
    sections: {
      watering: [
        'Water a rubber plant thoroughly, then let the soil dry slightly to the touch before the next drink. That is Clemson Cooperative Extension’s rule, and neither source gives a number of days. Use a pot with drainage holes and empty the saucer after watering.',
        'North Carolina State Extension says to water less from fall to late winter, when it is dormant. Soil that stays too wet can yellow the leaves, and overly frequent watering leads to root rot, so when in doubt, wait.',
      ],
      light: [
        'Bright light gives you the best leaves, and Clemson Cooperative Extension says it does especially well with morning light from an east window. It adapts to lower light too.',
        'North Carolina State Extension says to protect it from afternoon sun. Wipe the big leaves with a damp cloth when they get dusty; both extension sources recommend it.',
      ],
      problems: [
        'Leaves dropping from the bottom of the plant is the classic rubber plant complaint, and it’s usually overwatering — soggy soil starves the roots of air and the plant sheds from the bottom up. Let it dry out properly and check the pot actually drains.',
        'Yellow leaves point the same way: too much water, too often. A single yellow leaf at the base of an otherwise healthy plant is just aging, and nothing to worry about.',
        'Brown, crispy edges mean the opposite — it got too dry, or it’s sitting next to a radiator. Curling leaves that don’t relax after a drink usually mean cold: rubber plants dislike drafty spots and doorways in winter.',
      ],
      propagation: [
        'Rubber plants are propagated from tip or stem cuttings with at least one node. Let the milky sap stop running, then root the cutting in water or damp mix in a warm, bright spot; it can take a month or more.',
        'Air layering is the more reliable method for a thick stem: wound it, wrap the spot in damp sphagnum moss and plastic, and cut below the new roots once they show. Cutting the top off also makes the parent plant branch below the cut.',
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
        a: 'Water thoroughly, then let the soil dry slightly to the touch before watering again, and water less from fall to late winter. The extension sources give no fixed number of days. When in doubt, wait.',
      },
      {
        q: 'Why is my rubber plant losing its bottom leaves?',
        a: 'There are several causes. North Carolina State Extension says it is normal for some bottom leaves to yellow and drop, and that overwatering, temperature drops and cold drafts also cause leaf loss. Clemson Cooperative Extension adds too little light and dry air. Let the soil dry slightly between waterings, check that the pot drains, and keep it away from cold drafts.',
      },
      {
        q: 'Do rubber plants need direct sunlight?',
        a: 'No. Bright light is best, with morning sun from an east window ideal, and it should be protected from hot afternoon sun.',
      },
    ],
    careSources: [
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Rubber Plant',
        url: 'https://hgic.clemson.edu/factsheet/rubber-plant/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Ficus elastica (Rubber Plant)',
        url: 'https://plants.ces.ncsu.edu/plants/ficus-elastica/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'bird-of-paradise',
    commonName: 'Bird of Paradise',
    scientificName: 'Strelitzia reginae',
    alsoKnownAs: ['Crane Flower', 'Strelitzia', 'Bird of Paradise Flower'],
    related: ['monstera', 'fiddle-leaf-fig', 'money-tree'],
    metaTitle: 'Bird of Paradise Plant Care: Watering, Light + Blooms',
    heading: 'Bird of paradise plant care',
    metaDescription:
      'Water a bird of paradise plant generously in summer and less in winter. It needs as much bright light as you can give it indoors, and may never bloom there.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'A bird of paradise is the closest thing to a small tree that will live in a flat. It’s genuinely easy to keep alive and genuinely hard to make flower indoors — worth knowing which of those you’re buying it for.',
    quickFacts: {
      water: 'Generously in spring and summer; drier in winter',
      light: 'As much bright light as you can give it, including some direct sun',
      difficulty: 'Easy to keep, hard to flower indoors',
      toxicity: 'Toxic to cats and dogs if eaten (per the ASPCA)',
      humidity: 'Likes moderate humidity, around 60%; homes are often drier',
    },
    sections: {
      watering: [
        'In spring and summer, water a bird of paradise thoroughly. These are big plants with big leaves that lose a lot of water, and the sources differ on how dry to let them get. University of Wisconsin–Madison Extension and Clemson Cooperative Extension say to let the mix dry slightly between waterings indoors. The RHS says to keep the compost moist but not saturated, which can mean daily watering in warm weather. Check the soil rather than counting days.',
        'In winter, water less. All the sources agree that it needs far less water when the light is low and growth slows, and the RHS says to let the compost get fairly dry between waterings.',
        'Whatever the season, let the pot drain fully afterward. A mix that drains slowly, or watering too often, leads to root rot.',
      ],
      light: [
        'Give it the brightest spot you have. Clemson Cooperative Extension says it prefers full sun, and University of Wisconsin–Madison Extension says it needs nearly full sun in summer and as much light as possible in winter to bloom. A large sunny window is the place for it.',
        'If you are hoping for the orange-and-blue flower, light is most of the answer and patience is the rest. Plants flower only once they are mature: the RHS says five to ten years old, and Clemson says seedlings can take four to ten years or more. Keeping it a little snug in its pot helps. Treat the flower as a bonus and the leaves as the point.',
      ],
      problems: [
        'Split leaves are normal and not a problem. In the wild the splits let wind through instead of tearing the whole leaf off; indoors they happen from handling, drafts and simple age. A split leaf isn’t damaged, and cutting them off just leaves you with less plant.',
        'Brown, crispy leaf edges usually mean dry air, underwatering, or minerals building up in the soil. Water more thoroughly — a proper flush through the pot, not a sip — and consider filtered water if your tap is hard.',
        'Yellowing lower leaves with damp soil is overwatering, the most likely cause in winter. Yellowing across the whole plant with dry soil means it’s thirsty and probably needs a bigger pot.',
        'If the leaves are healthy but the plant is outgrowing its pot, with roots pushing out of the drainage hole or the pot drying out within days, repot in spring into a pot one size up. It flowers best when snug, so do not jump to a much bigger pot. If you would rather have a similar tropical look with a clean pet record, the [parlor palm](/care/parlor-palm) is the guide to read next.',
      ],
      propagation: [
        'A mature bird of paradise can be divided. In spring, take it out of its pot and cut or pull apart sections of the root mass that each have a few stems and healthy roots, then pot them in a well-drained mix.',
        'It can also be grown from seed, but slowly: a seedling usually takes years to reach flowering size. Division is the practical route for a houseplant.',
      ],
      sharedCare: [
        'This is a plant that changes what it wants twice a year, which is exactly the sort of thing that gets lost between two people. The summer routine and the winter routine are genuinely different, and a housemate who learned the July routine will drown it in January.',
        'The fix is to write down the rule and not just the date: generous in summer, much less in winter, always check the soil first. A shared note attached to the plant beats one person privately remembering the seasonal switch.',
      ],
      honestBit: [
        'My take: buy it for the leaves. Almost every bird of paradise sold as a houseplant is bought by somebody imagining the flower, and most of them will never see one indoors. That’s fine — the foliage alone is the best value-per-pound of any large houseplant.',
        'Worth being straight about the pet question too, because it comes up constantly and the internet is split: the ASPCA lists Strelitzia reginae as toxic to both cats and dogs. The ASPCA lists mild nausea, vomiting and drowsiness, caused mainly by the fruit and seeds, but it is not one of the pet-safe options. If a pet has eaten some, call your vet or a poison hotline. The [bird of paradise pet-safety page](/pet-safe/bird-of-paradise) shows the verdicts beside the ASPCA listing. If that’s your deciding factor, a parlor palm gives you a similar shape with a clean record.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a bird of paradise?',
        a: 'Generously in spring and summer, and much less in winter. The sources give no fixed number of days and differ on summer dryness: two extension sources say let the mix dry slightly between waterings, and the RHS says keep it moist but not saturated. Check the soil, and do not carry the summer routine into winter.',
      },
      {
        q: 'Why are my bird of paradise leaves splitting?',
        a: 'That’s normal. The splits are how the leaves survive wind in the wild, and indoors they come from handling, drafts and age. It isn’t a sign of poor care and there’s nothing to fix.',
      },
      {
        q: 'Why won’t my bird of paradise flower indoors?',
        a: 'Usually not enough light, or the plant is still too young. It needs to be mature, which the RHS puts at five to ten years old, with a snug pot and as much light as you can give it. Grow it for the leaves and treat a flower as a surprise.',
      },
      {
        q: 'How much light does a bird of paradise need indoors?',
        a: 'As much as you can give it: a large, sunny window, with full sun if possible. It will not flower without strong light.',
      },
      {
        q: 'Why are my bird of paradise leaves turning brown?',
        a: 'The sources do not tie brown edges to one cause. Check the basics: water thoroughly in spring and summer, raise the humidity in dry winter rooms, and make sure the pot drains, since soggy soil leads to root rot.',
      },
      {
        q: 'Which plant does this guide cover when people say “bird of paradise”?',
        a: 'Strelitzia reginae, the houseplant with the orange-and-blue flower. The name is also used for a different shrub, Caesalpinia gilliesii, which the ASPCA lists separately and warns against confusing with Strelitzia. The white bird of paradise, Strelitzia nicolai, is a close relative with its own listing status that we have not recorded, so we make no claim about it here.',
      },
    ],
    careSources: [
      {
        publisher: 'University of Wisconsin–Madison Extension',
        title: 'Bird of Paradise, Strelitzia reginae',
        url: 'https://hort.extension.wisc.edu/articles/bird-of-paradise-strelitzia-reginae/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Bird of Paradise',
        url: 'https://hgic.clemson.edu/factsheet/bird-of-paradise/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Strelitzia reginae (Bird of Paradise)',
        url: 'https://plants.ces.ncsu.edu/plants/strelitzia-reginae/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'RHS',
        title: 'How to grow strelitzia',
        url: 'https://www.rhs.org.uk/plants/strelitzia/how-to-grow-strelitzia',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'anthurium',
    commonName: 'Anthurium',
    scientificName: 'Anthurium andraeanum',
    alsoKnownAs: ['Flamingo Flower', 'Flamingo Lily', 'Painter’s Palette', 'Tail Flower'],
    related: ['peace-lily', 'orchid', 'christmas-cactus'],
    metaTitle: 'Anthurium Not Flowering? Why, Plus Watering and Light',
    heading: 'Anthurium care: why it stops flowering',
    metaDescription:
      'An anthurium with healthy leaves and no flowers usually needs brighter, indirect light. Why old blooms turn green, and when to water it.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The anthurium is the houseplant that actually keeps flowering — those waxy red or pink blooms hold for weeks and come back for months on end. The catch is that it stops the moment the light isn’t good enough, and most people blame the water.',
    quickFacts: {
      water: 'When the top inch of soil is dry',
      light: 'Bright, indirect light; too little light stops flowering',
      difficulty: 'Easy to keep alive, moderate to keep flowering',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals, per the ASPCA)',
      humidity: 'Likes high humidity, 60 to 80% by one source',
    },
    sections: {
      watering: [
        'Water an anthurium when the top inch of soil feels dry. That is North Carolina State Extension’s rule, and neither source gives a number of days. The RHS recommends an open, fast-draining mix and rainwater or filtered water, since anthuriums dislike tap water.',
        'They are very sensitive to standing wet: both sources say soggy soil rots the roots. If the pot sits inside a decorative outer cover, tip the water out of it after every watering.',
      ],
      light: [
        'Bright, indirect light is the whole game with anthuriums. Both sources say too little light reduces or stops flowering, which is how you end up with a green plant that somebody insists is “not doing anything.” Move it near a window, out of the direct beam, and the blooms usually return.',
        'Direct sun, especially in summer, scorches the leaves. They also like warmth and humid air: North Carolina State Extension gives 60 to 80% humidity and warns against cold drafts.',
      ],
      problems: [
        'Flowers turning green as they age is normal. Anthurium blooms fade to green before they finish, so a green “flower” is an old one rather than a sick plant. Cut the stem back to the base and let the plant put its energy into the next one.',
        'Yellowing leaves usually mean too much water or a pot that won’t drain. Brown, crispy tips point the other way: dry air, or minerals from hard tap water building up in the mix.',
        'No flowers at all, on a plant with healthy leaves, is a light problem nine times out of ten. The tenth time it’s a plant that needs feeding — a diluted, high-phosphorus feed every few weeks in spring and summer makes a real difference.',
        'A healthy anthurium in good light can keep producing flowers for months at a time, and each flower stays showy for several weeks before it ages to green. A plant that has been blooming for a long stretch and then pauses is not necessarily in trouble, so check the light and the roots before changing the watering.',
      ],
      propagation: [
        'Anthuriums are usually propagated by division. When repotting, separate offshoots or clumps that each have their own roots and a few leaves, and pot them in a chunky, airy mix like orchid bark blended with potting soil.',
        'A stem section with aerial roots will also root in damp sphagnum moss. Keep new divisions warm and humid, and expect them to put out leaves before they flower again.',
      ],
      sharedCare: [
        'Anthuriums make a good shared plant because they’re visibly expressive: when it’s happy it flowers, and everybody in the house can see that. That’s a lot more motivating than an evergreen which looks identical whether you’re doing well or badly by it.',
        'The bit to agree on is the outer pot. If one person waters and another tips out the cover, neither of you knows whether it’s standing in water right now. Make emptying the cover part of watering, not a separate job somebody else might have done.',
      ],
      honestBit: [
        'My take: an anthurium is the best gift plant on this list. It flowers for months, the blooms look almost artificial in a good way, and it survives the sort of care a brand-new plant owner gives. Just don’t put it on a shelf away from the window and then wonder why it stopped performing.',
        'And be honest about the pet side before it goes anywhere low: the ASPCA lists anthurium as toxic to cats and dogs. It’s the same calcium oxalate irritation as pothos and peace lily — a painful mouth rather than an emergency — but with a plant this vividly colored at coffee-table height, it’s worth deciding where it lives before it arrives. The ASPCA lists oral irritation, swelling of the mouth, tongue and lips, drooling, vomiting and difficulty swallowing. If a pet has chewed it, call your vet or a poison hotline. The [anthurium pet-safety page](/pet-safe/anthurium) shows the verdicts beside the ASPCA listing. (The listing is for flamingo flower, Anthurium scherzeranum; this guide treats the whole genus with the same caution.)',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an anthurium?',
        a: 'When the top inch of soil is dry. Water thoroughly, and always tip out any water left standing in the decorative outer pot, since soggy soil rots the roots.',
      },
      {
        q: 'Why is my anthurium not flowering, or why has it stopped?',
        a: 'Usually not enough light. Both sources say too little light reduces flowering, and North Carolina State Extension also names a lack of nutrients. Move it to bright, indirect light near a window and feed it through spring and summer, and flowers usually return.',
      },
      {
        q: 'Why are my anthurium flowers turning green?',
        a: 'That’s the normal way the bloom ages, not a problem. Each flower fades to green after several weeks. Cut the spent stem back to the base so the plant can put its energy into the next one.',
      },
      {
        q: 'When do anthuriums bloom, and how long do the flowers last?',
        a: 'In good light an anthurium can flower for months at a time, and each flower lasts several weeks before fading to green. If yours has gone quiet, the usual fix is brighter indirect light, plus a diluted high-phosphorus feed every few weeks in spring and summer.',
      },
      {
        q: 'Why are my anthurium flowers fading or dying?',
        a: 'A flower that fades to green after several weeks is aging normally. Cut the stem back to the base. If the whole plant is also yellowing or wilting, check whether the pot is standing in water inside a decorative cover, since soggy soil rots the roots.',
      },
      {
        q: 'Why are my anthurium leaves turning yellow?',
        a: 'Usually too much water or a pot that does not drain; North Carolina State Extension also names a lack of nutrients. Tip out any water in the outer pot after watering and let the top inch dry before the next drink.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Anthurium andraeanum (Flamingo Flower)',
        url: 'https://plants.ces.ncsu.edu/plants/anthurium-andraeanum/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'RHS',
        title: 'Anthuriums',
        url: 'https://www.rhs.org.uk/plants/anthuriums',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'chinese-evergreen',
    commonName: 'Chinese Evergreen',
    scientificName: 'Aglaonema',
    alsoKnownAs: ['Aglaonema', 'Silver Bay', 'Chinese Evergreen Plant'],
    related: ['zz-plant', 'dieffenbachia', 'peace-lily'],
    metaTitle: 'Chinese Evergreen Care: When to Water, Low Light OK',
    heading: 'Chinese evergreen care: watering and light',
    metaDescription:
      'Water a Chinese evergreen (aglaonema) when the top inch or two of soil is dry. It takes low to medium light. Toxic to pets if chewed.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'If you have a room with bad light and you’ve already killed something in it, this is the plant. Aglaonema is the best-looking thing that genuinely tolerates a dim corner, and it comes in pink and red varieties that look like they ought to be much harder.',
    quickFacts: {
      water: 'When the top inch or two of soil is dry',
      light: 'Low to medium indirect light; no direct sun',
      difficulty: 'Very easy',
      toxicity: 'Toxic to cats and dogs if chewed (calcium oxalate crystals, per the ASPCA)',
      humidity: 'Average household humidity is fine by one source; the RHS suggests misting',
    },
    sections: {
      watering: [
        'Water when the top inch or two of soil is dry. Clemson Cooperative Extension’s test is two fingers in the soil: dry means water, cool and damp means wait. Neither source gives a number of days, and the RHS says to let it dry a little more between waterings in winter.',
        'These are more likely to be overwatered than underwatered. Clemson says they tolerate drought, and that overwatering or a slow-draining mix leads to root rot. If the soil is damp, put the can down.',
      ],
      light: [
        'Low to medium indirect light is what it is known for, and Clemson Cooperative Extension says the solid green kinds grow in low light, such as a heavily shaded spot indoors. The RHS prefers bright, filtered light, so a brighter spot is fine too, as long as no direct sun reaches the leaves.',
        'The colored varieties need more light than the plain green ones: Clemson puts the variegated types at low to moderate light. Keep the plain dark-green types for the dimmest corners and the colorful ones nearer a window. Direct sun can scorch all of them.',
      ],
      problems: [
        'Yellow leaves are overwatering, nearly always. Chinese evergreens are slow, quiet plants, so a soggy pot shows up as gradual yellowing rather than sudden collapse — which means it can go on for weeks before anybody notices.',
        'Curling leaves with brown edges point at dry air, cold, or hard tap water. They dislike being next to a drafty door or above a radiator, and a spot below about 15°C makes them unhappy fast.',
        'Leggy growth with long bare stems means either not enough light or simply age — older plants naturally lose their lower leaves and go a bit trunk-like. You can cut a leggy stem back hard in spring and it will resprout.',
      ],
      propagation: [
        'Chinese evergreens are easiest to multiply by division at repotting: separate the clump into sections that each keep stems and roots, and pot them in fresh mix.',
        'Stem cuttings also root, in water or damp soil, if each piece has a couple of leaves and at least one node. Rooting takes a few weeks, longer in a cool room.',
      ],
      sharedCare: [
        'The Chinese evergreen is the ideal plant for the shared room nobody quite owns: a hallway, a landing, a home office two people use. It goes weeks without complaint, so it survives the gap where everyone assumes somebody else has it in hand.',
        'That same forgiveness is the trap. Because it never looks urgent, it can quietly go far too long without anyone checking it. Pin it to a regular soil check rather than a tight schedule, and it will outlast almost everything else in the house.',
      ],
      honestBit: [
        'My take: aglaonema is the answer to the question people actually ask, which is not “what’s the prettiest plant” but “what will survive in this specific bad corner.” It’s what I recommend when somebody describes a room with one small north-facing window.',
        'Be aware of the toxicity before you put one at ankle height, though. It’s an aroid, the same family as dieffenbachia and peace lily, and the ASPCA lists it as toxic to cats and dogs. A chewed leaf means a burning mouth and drooling — unpleasant enough that a shelf is a better home than the floor if you have a cat that samples things.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a Chinese evergreen?',
        a: 'When the top inch or two of soil is dry, and a little less in winter. The extension sources give no fixed number of days. It tolerates drought, and overwatering leads to root rot, so when the soil is still damp, wait.',
      },
      {
        q: 'Can a Chinese evergreen live in low light?',
        a: 'Yes. Clemson Cooperative Extension says the solid green varieties grow in low light. The variegated ones, including the pink and red kinds, need low to moderate light.',
      },
      {
        q: 'Why are my Chinese evergreen leaves turning yellow?',
        a: 'The sources do not name one cause. Check for soggy soil and a pot that does not drain, which lead to root rot, and keep it away from cold: Clemson says it is sensitive to temperatures below 50°F.',
      },
    ],
    careSources: [
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Chinese Evergreen (Aglaonema)',
        url: 'https://hgic.clemson.edu/factsheet/chinese-evergreen-aglaonema-care-cultivation-growing-guide/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'RHS',
        title: 'Aglaonema modestum, Chinese evergreen',
        url: 'https://www.rhs.org.uk/plants/707/aglaonema-modestum/details',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'jade-plant',
    commonName: 'Jade Plant',
    scientificName: 'Crassula ovata',
    alsoKnownAs: ['Money Plant', 'Lucky Plant', 'Friendship Tree', 'Crassula'],
    related: ['aloe-vera', 'burros-tail', 'snake-plant'],
    metaTitle: 'How to Water a Jade Plant: Deeply, Then Let It Dry',
    heading: 'Jade plant care: how to water it',
    metaDescription:
      'Water a jade plant deeply, then let the soil dry, and keep it on the dry side in winter. It wants four or more hours of direct sun. Why leaves drop.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'A jade plant is a slow-growing succulent tree that will happily outlive you if you leave it alone. Almost every jade plant that dies was loved to death with a weekly watering it never asked for.',
    quickFacts: {
      water: 'Water deeply, then let the soil dry; keep it on the dry side in winter',
      light: 'Four or more hours of direct sun a day',
      difficulty: 'Very easy, if you can resist watering it',
      toxicity: 'Toxic to cats and dogs if eaten (per the ASPCA)',
      humidity: 'The warm, dry air of most homes suits it',
    },
    sections: {
      watering: [
        'Water a jade plant deeply, then let the soil dry before the next drink, and never let it sit in water. The sources differ on how dry: Penn State Extension says to wait until the soil is completely dry, and University of Wisconsin–Madison Extension says that in spring and summer it can be watered liberally and allowed to dry slightly. Neither gives a number of days.',
        'In winter, when it is semi-dormant, keep it on the dry side. Both too much and too little water can make the leaves drop: Wisconsin says overwatering drops leaves and rots the stem, and that drought can also cause spotting and leaf drop.',
      ],
      light: [
        'Jade wants real light: both extension sources say four or more hours of direct sun a day, and Penn State says it will thrive in a south-facing window. With enough light the growth stays compact and the leaf edges can take on a red tinge, which is a sign of a happy plant.',
        'In low light it stretches, with drooping stems and a plant that leans toward the window. If yours has gone lanky, that is a light problem, and no amount of water or feeding will fix it. Two smaller succulents with their own guides, the [burro’s tail](/care/burros-tail) and the [blue echeveria](/care/blue-echeveria), want the same bright window.',
      ],
      problems: [
        'Leaves dropping at the slightest touch is the classic overwatering signal, and so are soft, yellowing, translucent leaves at the base. Stop watering entirely, let it dry out hard, and it usually recovers — jade is remarkably resilient once the soil is dry again.',
        'Wrinkled, shrivelled leaves are the far rarer opposite: it’s genuinely thirsty. Give it a thorough soak and they plump back up within a few days.',
        'White powdery patches or cottony spots in the leaf joints are mealybugs, which love jade plants. Dab them off with a cotton bud dipped in rubbing alcohol and check again a week later — they hide in the crevices and come straight back if you only do it once.',
      ],
      propagation: [
        'Jade roots readily from a stem cutting or even a single plump leaf. Take a cutting a few inches long, let the cut end dry and callus for a few days, then set it in a gritty, barely damp cactus mix.',
        'Hold off on real watering until it resists a gentle tug, which usually means it has rooted (often two to four weeks). A fallen leaf can root and sprout a tiny plant on its own if it lands on soil.',
      ],
      sharedCare: [
        'Jade is the plant most likely to be killed by a well-meaning housemate. It looks like a normal leafy plant rather than obviously a succulent, so the instinct is to water it on the same routine as everything else, and soil that never dries is what rots it.',
        'If it lives in a shared space, label it or say it plainly: this one gets water only when the soil has dried, and it’s meant to look dry. It’s one of the few plants where “do nothing” is the correct instruction, and it needs saying out loud precisely because it’s so counterintuitive.',
      ],
      honestBit: [
        'My take: a jade plant is a fifty-year plant. People buy them as small desk succulents and don’t realize they’re looking at something that becomes a proper miniature tree with a thick trunk if it’s simply left to get on with it. The main skill is patience and the main danger is enthusiasm.',
        'The pet answer disappoints people, because jade looks so innocuous: the ASPCA lists it as toxic to both cats and dogs, causing vomiting, depression and an unsteady, wobbly gait. Unusually, nobody is quite sure which compound is responsible. If a pet has eaten a real mouthful, that’s worth a call to the vet rather than a wait-and-see.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a jade plant?',
        a: 'Deeply, and only after the soil has dried, keeping it on the dry side in winter. The extension sources give no fixed number of days, and they differ on how dry: Penn State says completely dry, Wisconsin says slightly dry in spring and summer.',
      },
      {
        q: 'Why is my jade plant dropping leaves?',
        a: 'Watering, in either direction. University of Wisconsin–Madison Extension says overwatering causes leaf drop and stem rot, and that drought can cause leaf drop too. Check the soil and the drainage before you change anything.',
      },
      {
        q: 'Why is my jade plant leggy and floppy?',
        a: 'Not enough light. Jade needs four or more hours of direct sun a day to stay compact; in a dim spot it stretches toward the window. Move it somewhere brighter and prune the stretched growth.',
      },
      {
        q: 'How long does a jade plant live?',
        a: 'Jade plants are famously long-lived. With bright light and sparse watering they are commonly kept for decades, slowly turning into small trees, and are often passed down from one generation to the next.',
      },
    ],
    careSources: [
      {
        publisher: 'University of Wisconsin–Madison Extension',
        title: 'Jade Plant, Crassula ovata',
        url: 'https://hort.extension.wisc.edu/articles/jade-plant-crassula-ovata/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Penn State Extension',
        title: 'Jade Plant, A No Fuss Houseplant',
        url: 'https://extension.psu.edu/jade-plant-a-no-fuss-houseplant',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'english-ivy',
    commonName: 'English Ivy',
    scientificName: 'Hedera helix',
    alsoKnownAs: ['Common Ivy', 'Hedera', 'Needlepoint Ivy', 'Glacier Ivy'],
    related: ['pothos', 'hoya', 'boston-fern'],
    metaTitle: 'English Ivy Indoor Care: Watering, Light, and Pet Safety',
    heading: 'English ivy care indoors',
    metaDescription:
      'English ivy indoors wants a cool, bright room and soil that dries only half an inch down between waterings. How to beat pests, and why it is not pet-safe.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'English ivy is a beautiful trailing plant that is far fussier indoors than its reputation as an unstoppable outdoor weed suggests. It wants a cool, bright room, and in a warm dry living room it is more prone to pests and sulks.',
    quickFacts: {
      water: 'Water thoroughly when the top half-inch of soil is dry; never soggy',
      light: 'Bright light, but not direct sun',
      difficulty: 'Moderate indoors — easy in a cool, bright room',
      toxicity: 'Toxic to cats and dogs if eaten (per the ASPCA)',
      humidity: 'Prefers moderate humidity; tolerates normal home levels',
    },
    sections: {
      watering: [
        'Water ivy thoroughly, then let the top half-inch of soil dry before watering again. That is Clemson Cooperative Extension’s rule, and it gives no number of days. Ivy does not want to dry out hard like a succulent, and it will not tolerate standing in water: a slow-draining mix or watering too often leads to root rot.',
        'It does best in a cool room. Clemson gives 50 to 70°F by day and a little cooler at night, so a cool, bright spot suits it better than a warm living room.',
      ],
      light: [
        'Most ivies grow best in bright light, but not direct sun. They tolerate low to medium light with slower growth, though the variegated kinds may turn all green there.',
        'Clemson Cooperative Extension says a north, east or west window works, as do grow lights. Ivy prefers moderate humidity and tolerates the lower levels in most homes; a tray of wet pebbles raises it if you need to.',
      ],
      problems: [
        'Fine webbing between the leaves, and a dusty, stippled, faded look, is spider mites — and English ivy indoors is a magnet for them. Warm dry air is what invites them in. Rinse the whole plant thoroughly in the shower, raise the humidity, and check weekly, because mites rebound fast from a single treatment.',
        'Brown, dry leaf edges and steady leaf drop usually mean the air is too dry or the room too warm. Moving it somewhere cooler often fixes more than any watering change will.',
        'Bare, straggly stems with leaves only at the ends mean not enough light. Cut the stems back by a third in spring; ivy responds well to a hard trim and comes back bushier.',
      ],
      propagation: [
        'English ivy roots very easily from stem cuttings. Cut 4–6 inch lengths of vine just below a node, strip the lower leaves, and stand them in water or push them into damp potting mix.',
        'Roots usually show within one to three weeks. Potting several cuttings together gives a fuller plant, and trailing stems that touch the soil will often root where they lie.',
      ],
      sharedCare: [
        'Ivy is the plant that most rewards somebody actually looking at it. Spider mites are invisible for a fortnight and obvious once they’ve won, so it needs a person who turns a leaf over now and then rather than a person who waters on a timer.',
        'If two of you share it, the useful habit isn’t splitting the watering but agreeing that whoever waters also gives it ten seconds of inspection — undersides of leaves, new growth at the tips. That’s the whole maintenance routine, and it only works if it belongs to the job rather than to a particular person.',
      ],
      honestBit: [
        'My honest take: most people would be happier with a pothos. Ivy looks like the easy trailing plant and isn’t — it wants cool and bright at the same time, which describes very few centrally heated homes. It’s genuinely lovely in a cold bright hallway and genuinely miserable above a radiator.',
        'And a real warning if you have pets: the ASPCA lists English ivy as toxic to cats and dogs, with the foliage more toxic than the berries. Trailing plants are exactly the ones a cat can reach, because the plant comes down to them. If you want the trailing look with a clean pet record, a spider plant or a hoya does the same job.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water English ivy indoors?',
        a: 'Water thoroughly, then wait until the top half-inch of soil is dry before the next drink. The extension sources give no fixed number of days. Do not leave it standing in water.',
      },
      {
        q: 'Why does my English ivy keep getting spider mites?',
        a: 'Mites are among the most common pests of indoor ivy, and Clemson Cooperative Extension says cooler temperatures and higher humidity help prevent common pests. Rinse the whole plant in the shower, move it somewhere cooler, and re-check weekly; one treatment is rarely enough.',
      },
      {
        q: 'Why is my English ivy going brown and dropping leaves?',
        a: 'The sources do not name a single cause. Check the basics: a room warmer than the 50 to 70°F ivy prefers, very dry air, soil that stays soggy, and pests such as mites. Move it somewhere cooler and bright, and look under the leaves.',
      },
      {
        q: 'Can English ivy grow indoors?',
        a: 'Yes. English ivy is a common indoor plant as long as it gets bright light and a cool room. Warm, dry air makes pests more likely; a cooler spot and regular checks under the leaves help keep it healthy.',
      },
    ],
    careSources: [
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Growing English Ivy Indoors',
        url: 'https://hgic.clemson.edu/factsheet/growing-english-ivy-indoors/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'boston-fern',
    commonName: 'Boston Fern',
    scientificName: 'Nephrolepis exaltata',
    alsoKnownAs: ['Sword Fern', 'Nephrolepis', 'Boston Sword Fern'],
    related: ['calathea', 'nerve-plant', 'asparagus-fern'],
    metaTitle: 'Boston Fern Care: Pet-Safe, Keep the Soil Evenly Moist',
    heading: 'Boston fern care: watering and pet safety',
    metaDescription:
      'Boston ferns are non-toxic to cats and dogs (per the ASPCA). Keep the soil evenly moist, never saturated, and give it high humidity. Why fronds go brown.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'A Boston fern is one of the few genuinely pet-safe plants that also looks like something. It’s also the plant most likely to shed brown fronds across your floor in January, and those two facts are worth weighing against each other honestly.',
    quickFacts: {
      water: 'Keep the soil evenly moist but not saturated; less in winter',
      light: 'Bright to medium indirect light; no direct sun',
      difficulty: 'Moderate — easy to keep alive, harder to keep beautiful',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'High humidity; dry winter air browns the tips',
    },
    sections: {
      watering: [
        'Boston ferns want the soil evenly moist, not saturated. North Carolina State Extension says never to let it dry out, while University of Wisconsin–Madison Extension says it does best with consistent moisture but is the most drought-tolerant of the common ferns, so a single missed watering is not the end. Neither source gives a number of days: check the soil by touch.',
        'In winter, water less. North Carolina State Extension says the plant is dormant then and overwatering can lead to root rot.',
      ],
      light: [
        'Bright but indirect, or medium-bright. University of Wisconsin–Madison Extension suggests an east window, or a south or west window behind a sheer curtain or far enough back that no direct sun reaches it.',
        'Humidity matters as much as light. North Carolina State Extension says it needs high humidity and suggests a kitchen or bathroom, or a tray of wet pebbles, and Wisconsin says the tips and edges can brown in dry rooms, especially in winter.',
      ],
      problems: [
        'Brown, crispy fronds and leaflets shedding all over the floor is the signature Boston fern complaint, and it’s almost always dry air. Central heating in winter is brutal on them. Grouping plants together, a pebble tray, a humidifier, or a bright bathroom all help far more than misting does.',
        'Yellowing fronds with soggy soil is overwatering — the one direction people don’t expect from a fern. Damp is the target; waterlogged still causes rot.',
        'A fern that looks fine on top and dead underneath usually just needs its old fronds cut out. Boston ferns constantly renew from the center, and clearing the browned-off outer fronds at the base is normal maintenance rather than surgery.',
      ],
      propagation: [
        'Boston ferns are propagated by division or from their runners. At repotting, cut the root ball into a few sections that each keep fronds and roots, and pot them separately in a moist, peaty mix.',
        'The fern also sends out thin, fuzzy runners; where one touches damp soil it can root and form a small new plant you can cut free. Keep new divisions humid while they establish.',
      ],
      sharedCare: [
        'This is a plant that wants steady moisture and humid air, and it shows dry spells in its fronds. That makes it a bad candidate for “whoever gets to it,” and a good candidate for one named owner with a recurring reminder.',
        'If it does live in a shared house, the honest advice is to put it somewhere the humidity does the work for you — a bright bathroom is the classic answer — so the schedule matters less. A fern in a steamy bathroom forgives a forgetful household in a way that a fern in a heated living room never will. If you are comparing it with the feathery [asparagus fern](/care/asparagus-fern), note that they are different plants with different pet-safety listings.',
      ],
      honestBit: [
        'My take: the Boston fern is the plant I most often recommend and most often warn about in the same breath. If pet safety is your hard constraint, it’s one of the best-looking safe options there is. If you also want low effort, it’s the wrong plant, and a spider plant or a parlor palm will serve you better.',
        'One thing worth knowing that has genuinely caught people out: not everything sold as a “fern” is one. Asparagus fern isn’t a true fern at all, and the ASPCA lists it as toxic to cats and dogs. True ferns like this one are the safe group — but check the actual plant, not the word on the label.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a Boston fern?',
        a: 'Often enough to keep the soil evenly moist but never saturated, and less in winter. The extension sources give no fixed number of days, so check by touch.',
      },
      {
        q: 'Why is my Boston fern turning brown and dropping everywhere?',
        a: 'Dry air is the usual suspect, especially in heated rooms in winter: University of Wisconsin–Madison Extension says the tips and edges brown in dry interiors. Raise the humidity with a tray of wet pebbles or a move to a bright kitchen or bathroom, and keep the soil evenly moist.',
      },
      {
        q: 'Does misting a Boston fern help?',
        a: 'The sources recommend steadier ways to raise humidity: a tray of wet pebbles or a naturally humid room such as a kitchen or bathroom. Those work without anyone having to remember a daily job.',
      },
    ],
    careSources: [
      {
        publisher: 'University of Wisconsin–Madison Extension',
        title: 'Boston Fern, Nephrolepis exaltata var. Bostoniensis',
        url: 'https://hort.extension.wisc.edu/articles/boston-fern-nephrolepis-exaltata-bostoniensis/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Nephrolepis exaltata (Boston Fern)',
        url: 'https://plants.ces.ncsu.edu/plants/nephrolepis-exaltata/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'money-tree',
    commonName: 'Money Tree',
    scientificName: 'Pachira aquatica',
    alsoKnownAs: ['Pachira', 'Guiana Chestnut', 'Malabar Chestnut', 'Braided Money Tree'],
    related: ['parlor-palm', 'rubber-plant', 'calathea'],
    metaTitle: 'Money Tree Care: Pet-Safe, Moist but Well-Drained Soil',
    heading: 'Money tree care: watering and pet safety',
    metaDescription:
      'The ASPCA lists the money tree as non-toxic to cats and dogs. Keep its soil moist but well-drained, never standing in water, in bright, indirect light.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The braided money tree is a genuinely good houseplant hiding behind a gimmicky presentation. It’s easy, it’s forgiving, and — unusually for a plant this size — the ASPCA lists it as non-toxic to cats and dogs.',
    quickFacts: {
      water: 'Keep the mix moist but well-drained; never leave it standing in water',
      light: 'Bright, indirect light or partial shade; no hot direct sun',
      difficulty: 'Easy',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'Thrives in humid air; low humidity can yellow the leaves',
    },
    sections: {
      watering: [
        'North Carolina State Extension says a money tree prefers a moist, well-drained potting mix. It does not tolerate standing water, which can cause root rot, and soil that gets too dry can make it drop leaves. Neither source gives a number of days or a depth to check, so feel the soil and water before it dries out completely, then let the pot drain. That is a similar approach to a [monstera](/care/monstera).',
        'Water thoroughly, empty the saucer, and keep it in an open, free-draining mix, as the RHS recommends.',
      ],
      light: [
        'Bright, indirect light suits it, and both sources say it also grows in partial shade. Direct sun can scorch the leaves, so a sheer curtain or a bit of distance from a sunny window helps.',
        'It thrives in humid air at 65 to 75°F, according to North Carolina State Extension. Turn the pot now and then so every side gets light, since a braided trunk cannot correct itself later.',
      ],
      problems: [
        'Yellow leaves dropping off is the classic sign of too much water. The trunk should feel firm; if the base is soft or spongy, that’s rot and the watering needs to stop immediately.',
        'Brown, crispy leaf edges usually mean dry air or underwatering, and sometimes minerals from hard tap water. It’s a milder complaint than yellowing and much easier to correct.',
        'Leaf drop right after you bring it home is normal acclimation, not a crisis. Give it a stable bright spot and a consistent schedule and it settles within a few weeks. Repeated leaf drop later on is usually a light or watering problem.',
      ],
      propagation: [
        'Money trees can be grown from stem cuttings: take a cutting with a couple of leaves and at least one node and root it in water or damp mix in a warm, bright spot. It is slow and can take a month or more.',
        'A cutting grows into a single stem. The braided trunks you see in stores are several young plants woven together by the grower, so a cutting will not reproduce the braid on its own.',
      ],
      sharedCare: [
        'Money trees are frequently office plants and gift plants, which means they are frequently nobody’s plant — everyone likes it, nobody waters it, and it dies slowly in a corner. A plant that never looks urgent is exactly the kind that falls through the gaps.',
        'It’s a good candidate for a shared reminder rather than a shared habit. A regular soil check, and one person confirming it was actually done, is enough to keep it going.',
      ],
      honestBit: [
        'My take: if you want a floor-standing plant and you have a cat that chews, this is the one. Most large statement plants — fiddle leaf figs, rubber plants, bird of paradise, dracaenas — are toxic. Pachira is on the ASPCA non-toxic list and gets to five or six feet indoors. That combination is rarer than it should be.',
        'A naming warning worth taking seriously, though. “Money plant” is used for at least three different plants — this one, pothos, and jade — and the other two are both toxic to pets. If somebody hands you a “money plant,” find out what it actually is before you decide where it can live.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a money tree?',
        a: 'The extension sources give no fixed number of days. Keep the potting mix moist but well-drained, never leave it standing in water, and do not let it dry out so far that it drops leaves.',
      },
      {
        q: 'Why are my money tree leaves turning yellow and falling off?',
        a: 'North Carolina State Extension names low humidity and a lack of nutrients for yellow leaves, and soil that is too dry for leaf drop. Standing water causes root rot. Check the humidity and the soil before you change the watering.',
      },
      {
        q: 'Why is my money tree leaning to one side?',
        a: 'It may be growing toward the light. Rotate the pot a little each time you water so every side gets its share, since braided trunks cannot straighten themselves out later.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Pachira aquatica (Money Tree)',
        url: 'https://plants.ces.ncsu.edu/plants/pachira-aquatica/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'RHS',
        title: 'Pachira aquatica',
        url: 'https://www.rhs.org.uk/plants/12078/pachira-aquatica/details',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'christmas-cactus',
    commonName: 'Christmas Cactus',
    scientificName: 'Schlumbergera',
    alsoKnownAs: ['Holiday Cactus', 'Thanksgiving Cactus', 'Zygocactus', 'Schlumbergera'],
    related: ['blue-echeveria', 'jade-plant', 'poinsettia'],
    metaTitle: 'How to Care for a Christmas Cactus: When to Water It',
    heading: 'How to care for a Christmas cactus',
    metaDescription:
      'Water a Christmas cactus when the top inch of soil is dry, in bright, filtered light. Why it drops buds and how to make it bloom again.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'A Christmas cactus is a jungle plant wearing a desert plant’s costume. It isn’t a succulent that wants neglect — it wants regular water and shade — and once you know that, it’s easy, long-lived and safe around pets.',
    quickFacts: {
      water: 'When the top inch of soil is dry; water thoroughly',
      light: 'Bright, filtered light; avoid strong sun',
      difficulty: 'Easy to grow, moderate to re-flower',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'High humidity, according to University of Minnesota Extension',
    },
    sections: {
      watering: [
        'Water when the top inch of soil feels dry, not on a fixed schedule; UF/IFAS Gardening Solutions puts it exactly that way. Water thoroughly, until it runs out the bottom. Keep the soil moist but not wet: this is not a desert cactus, and UF says letting the soil dry out makes the flowers drop.',
        'After it has finished blooming, water less often, and increase again in spring or early summer, as University of Minnesota Extension advises. While it is in bud, keep things steady: improper watering is one cause of bud drop, though UF says the usual cause is a change in its surroundings, especially heat.',
      ],
      light: [
        'Bright, filtered light. UF/IFAS Gardening Solutions says to keep it within 6 feet of a window and that any window except a north one works. University of Minnesota Extension warns that too much sun can leave the stems pale and sunburned.',
        'Light is also how you get it to flower. It sets buds in response to long nights and cool temperatures: University of Minnesota Extension says at least 12 hours of complete darkness each night at 60 to 65°F, and that at 55°F nights it blooms in about 5 to 6 weeks. Above 65°F it is unlikely to bloom. UF suggests starting about mid-October for flowers by Christmas.',
      ],
      problems: [
        'Buds forming and then dropping before they open is the classic complaint, and the cause is almost always change: it got moved, the temperature swung, or it dried out at the wrong moment. Once it’s budding, put it where it will stay and keep the watering steady.',
        'Limp, wrinkled, floppy segments can mean either extreme, which is unhelpful but true. Check the soil: dry means water it, soggy means root rot, and you should let it dry out hard and consider repotting.',
        'Reddish or purple segment edges are usually too much direct sun, occasionally cold. Move it out of the beam and the new growth comes back green.',
      ],
      propagation: [
        'Christmas cactus is one of the easiest plants to share. Twist off a piece two or three segments long at a joint, let it dry for a day, then push the bottom segment upright into a gritty, barely damp mix.',
        'Roots usually form in two to three weeks. Several cuttings in one pot make a fuller plant sooner, which is how a single cutting from a relative’s plant becomes a family heirloom.',
      ],
      sharedCare: [
        'Christmas cactus is the plant most likely to be inherited. They live for decades and get handed down, which means the one in your house may well have a routine that predates you — worth asking about, because these plants really do settle into a spot.',
        'The shared-care rule here is a seasonal one: from autumn, don’t move it and don’t leave a light on in its room at night. That’s a request other people in the house cannot possibly guess at, so it needs saying rather than assuming. Once the buds are set, it can come back somewhere everyone can see it. The [poinsettia](/care/poinsettia) is the other seasonal plant that tends to arrive as a gift for the whole house.',
      ],
      honestBit: [
        'My take: the reason your Christmas cactus doesn’t flower is almost never the watering. It’s that its room has a lamp on in the evening. Six weeks of genuinely dark nights in autumn is the whole trick, and it costs nothing.',
        'The other good news is the pet one. The ASPCA lists Christmas cactus as non-toxic to cats and dogs, which puts it in a very small group of plants that flower reliably indoors and are safe at floor level. If you want winter color in a house with animals, this is the pick.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a Christmas cactus?',
        a: 'When the top inch of soil is dry, not on a fixed schedule, and thoroughly, until water runs out the bottom. Keep it moist but not wet, and water less after it has bloomed.',
      },
      {
        q: 'Why is my Christmas cactus dropping its buds?',
        a: 'Usually a change in its surroundings, especially heat, according to UF/IFAS Gardening Solutions. Drafts, sudden temperature swings, dry soil and improper watering can also do it. Once buds appear, leave it in place and keep the watering steady.',
      },
      {
        q: 'How do I make a Christmas cactus bloom again?',
        a: 'Give it long, uninterrupted nights and cool temperatures in fall: at least 12 hours of darkness each night at 60 to 65°F for about six weeks, according to University of Minnesota Extension. A spare room where nobody turns a lamp on in the evening does it.',
      },
      {
        q: 'How long does a Christmas cactus live?',
        a: 'For decades, with basic care. Christmas cactus is one of the classic heirloom houseplants, and a plant grown from a cutting of a relative’s cactus is the same plant, still going.',
      },
    ],
    careSources: [
      {
        publisher: 'UF/IFAS Gardening Solutions',
        title: 'Christmas Cactus Preparation',
        url: 'https://gardeningsolutions.ifas.ufl.edu/plants/houseplants/christmas-cactus/christmas-cactus-preparation/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'University of Minnesota Extension',
        title: 'Holiday cacti',
        url: 'https://extension.umn.edu/garden-and-home/yard-and-garden/gardening-in-minnesota/holiday-cacti',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'parlor-palm',
    commonName: 'Parlor Palm',
    scientificName: 'Chamaedorea elegans',
    alsoKnownAs: ['Parlour Palm', 'Neanthe Bella Palm', 'Good Luck Palm', 'Chamaedorea'],
    related: ['money-tree', 'sago-palm', 'zz-plant'],
    metaTitle: 'Parlor Palm Care: Watering, Low Light, and Pet Safety',
    metaDescription:
      'How often to water a parlor palm, why it works in low light, what brown tips mean, and why it is one of the best pet-safe plants you can buy.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The parlor palm has been the standard indoor palm since the Victorians, and for good reason: it handles low light, it’s genuinely pet-safe, and it looks tropical while asking for almost nothing.',
    quickFacts: {
      water: 'When the surface of the soil has dried; less in winter',
      light: 'Bright, indirect light is best; tolerates low light; no direct sun',
      difficulty: 'Easy',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'Prefers moderate humidity; brown tips in very dry air',
    },
    sections: {
      watering: [
        'Water a parlor palm when the surface of the soil has dried, and not while it is still damp. That is the RHS rule, and North Carolina State Extension says to let it dry slightly between waterings. Neither gives a number of days. It handles a short dry spell far better than a soggy pot, because roots left standing in water rot.',
        'Water less in winter, when growth slows. A dim corner plus a damp pot is the combination to avoid.',
      ],
      light: [
        'Both sources say bright, indirect light gives the best growth, and North Carolina State Extension suggests a north- or east-facing window. It also tolerates low light, which is why it is sold as a low-light plant, but the RHS says too little light can yellow the leaves and slow growth. If your spot is dimmer still, or you would rather water less often, a [ZZ plant](/care/zz-plant) copes with very low light and goes about two weeks between summer waterings.',
        'Keep it out of direct sun, especially in summer, when it scorches the fronds. So the one mistake to avoid is putting it on a sunny windowsill because it looks tropical. If a sunny spot is what you have, a [bird of paradise](/care/bird-of-paradise) wants exactly that.',
      ],
      problems: [
        'Brown, crispy frond tips are the most common complaint and usually mean dry air, though hard tap water and inconsistent watering both contribute. Trim the brown off with scissors if it bothers you, raise the humidity, and judge by the new growth.',
        'Yellowing fronds across the whole plant point at overwatering. Parlor palms grow slowly and a rotting root system shows up gradually, so it’s worth checking the soil actually dries out between waterings.',
        'Fine webbing and stippled, dusty-looking fronds are spider mites, which like the same warm dry air that causes the brown tips. Rinse the plant in the shower and raise the humidity — conveniently, the two fixes are the same fix.',
      ],
      propagation: [
        'Parlor palms do not root from cuttings. They grow from seed, and that is slow; most of what you buy is a pot of several seedlings grown together.',
        'You can carefully separate those seedlings into smaller pots when repotting, but palms resent root disturbance, so expect a sulk afterward. Most people are better off buying a new plant than dividing one.',
      ],
      sharedCare: [
        'A parlor palm is one of the best plants for a household that isn’t very good at plants. It tolerates a missed watering and lower light, and it doesn’t die dramatically when the routine slips — which makes it forgiving of the gap where everybody assumed somebody else had it.',
        'It’s also a good one for the room the pets live in, precisely because it’s safe. Households often end up with every plant exiled to a high shelf; this is one you can put on the floor and stop thinking about. Do not confuse it with the [sago palm](/care/sago-palm), which only looks like a palm and is the opposite for pets.',
      ],
      honestBit: [
        'My take: the parlor palm is the most useful plant on this whole site. It’s the answer to “low light AND pet-safe AND low effort,” which is the combination most people actually need and very few plants satisfy. It isn’t exciting. It’s just right almost every time.',
        'Buy a full pot rather than a single stem if you have the choice. Parlor palms don’t branch — each stem grows on its own — so a sparse plant stays sparse forever. Nurseries plant several together for a fuller look, and that’s what you want.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a parlor palm?',
        a: 'When the surface of the soil has dried, and less in winter. The sources give no fixed number of days. It tolerates a missed watering much better than a soggy pot.',
      },
      {
        q: 'Why are my parlor palm tips turning brown?',
        a: 'Dry air is the usual cause, with hard tap water and uneven watering contributing. Raise the humidity, keep the watering consistent, and trim the brown tips off if you want it tidy — the existing damage won’t turn green again.',
      },
      {
        q: 'Can a parlor palm live in low light?',
        a: 'It tolerates low light, but both sources say bright, indirect light is best for growth, and the RHS says too little light can yellow the leaves. Keep it out of direct sun, which scorches the fronds.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Chamaedorea elegans (Parlor Palm)',
        url: 'https://plants.ces.ncsu.edu/plants/chamaedorea-elegans/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'RHS',
        title: 'How to grow chamaedorea',
        url: 'https://www.rhs.org.uk/plants/chamaedorea/growing-guide',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'orchid',
    commonName: 'Moth Orchid',
    scientificName: 'Phalaenopsis',
    alsoKnownAs: ['Phalaenopsis', 'Phal', 'Moon Orchid', 'Supermarket Orchid'],
    related: ['christmas-cactus', 'anthurium', 'african-violet'],
    metaTitle: 'How to Water a Moth Orchid: Soak, Drain, About Weekly',
    heading: 'Moth orchid care: how to water it',
    metaDescription:
      'Water a moth orchid (phalaenopsis) about once a week: soak the bark, then drain it completely. What the roots tell you, and how to get it to flower again.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The supermarket orchid is not a delicate specialist plant — it’s an easy plant that almost everybody waters wrong. Get the watering right and a phalaenopsis will flower for months, rest, and then do it again for years.',
    quickFacts: {
      water: 'About once a week; soak the bark, then drain completely',
      light: 'Bright, indirect light, such as an east window',
      difficulty: 'Easy, once you stop watering it like a normal plant',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: '40 to 60%; most homes are drier than that in winter',
    },
    sections: {
      watering: [
        'An orchid grows in bark, not soil. Water it about once a week: University of Maryland Extension says that at normal room temperatures it should not need watering more often than that, and the RHS says weekly through the growing season, a little less in winter. Take the inner pot to the sink, let water run through the bark until it has soaked in, then let it drain completely before it goes back in its cover. Never leave it standing in water: watering too often rots the roots.',
        'The roots help you judge. University of Maryland Extension says aerial roots turn from dull silver or white to pale green once they have had enough water. The RHS adds that a clear pot lets you see whether the bark below the surface is still moist, and warns against letting the roots dry out completely.',
      ],
      light: [
        'Bright, indirect light, out of direct summer sun. An east window suits it, and the sources also name north and west windows. University of Maryland Extension says leaves in the right light are light green; very dark, stiff leaves mean too little light, and yellow-green leaves with reddish edges mean too much.',
        'Light is also the flowering lever: too little light is the most common reason a moth orchid does not flower. A cool spell helps too. Iowa State University Extension says fall nights of 55 to 60°F help start flower development. Humidity matters as well: the same source gives 40 to 60%, and most homes fall below that in winter, so a tray of damp gravel under the pot helps.',
      ],
      problems: [
        'Wrinkled, floppy, leathery leaves mean the plant can’t take up water, and confusingly the usual cause is overwatering that has rotted the roots. Tip it out and look: healthy roots are firm and green or silver, dead ones are brown, flat and mushy. Cut the dead ones off and repot into fresh bark.',
        'Flowers dropping after a couple of months isn’t a failure — that’s the end of a normal flowering cycle. The plant isn’t dying, it’s resting. Keep watering it, keep it in good light, and it will spike again.',
        'Roots wandering out of the pot into the air are completely normal and should be left alone. Phalaenopsis are epiphytes and aerial roots are simply how they live; stuffing them back into the pot does more harm than leaving them be.',
      ],
      propagation: [
        'Moth orchids are not propagated from cuttings. Occasionally a flower spike grows a baby plant, called a keiki, with its own leaves and roots. Leave it attached until its roots are about 2 inches long, then cut it free and pot it in orchid bark.',
        'Phalaenopsis grows from a single central stem, so it cannot be divided like a clumping plant. For most people, the way to get more orchids is a keiki or a new plant.',
      ],
      sharedCare: [
        'Orchids get given as gifts, and gift plants are the ones that fall between people. Worse, an orchid that has finished flowering looks like it’s finished full stop, so it quietly gets abandoned on a shelf while still perfectly alive.',
        'The thing worth sharing isn’t the schedule, it’s the fact that a spent orchid is not a dead orchid. Enormous numbers of them are binned in month three by somebody who didn’t know they reflower. And while we’re dispelling things: the ice-cube trick people pass around isn’t a good idea — a proper soak and a full drain is. An [African violet](/care/african-violet) is the easier flowering plant to start with if the orchid routine feels like too much.',
      ],
      honestBit: [
        'My take: three things fix nearly every orchid problem, and none of them are complicated. Take it out of the decorative pot to water it. Let it drain completely. Put it in an east window. That’s genuinely most of orchid care, and everything else is refinement.',
        'And a nice bonus if you have animals: the ASPCA lists the moth orchid as non-toxic to cats and dogs. Given how many houseplants that flower this dramatically are toxic, an orchid on a low table in a house with a cat is a rare, easy yes.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an orchid?',
        a: 'About once a week, not more often at normal room temperatures. Take the inner pot to the sink, run water through the bark until it soaks in, and let it drain completely before returning it to its cover pot. Silver-white aerial roots turning pale green tell you it has had enough.',
      },
      {
        q: 'How do I get my orchid to flower again?',
        a: 'More light and a cool spell. Move it to a bright east window, and give it a few weeks of cooler fall nights, around 55 to 60°F. Low light is the most common reason an otherwise healthy orchid never flowers again.',
      },
      {
        q: 'Why are my orchid leaves wrinkled and floppy?',
        a: 'University of Maryland Extension names low humidity and too little water as causes of wrinkled leaves. Check the roots too: if they are brown and mushy, they have rotted from watering too often, and the plant cannot take up water. Trim the dead roots and repot into fresh bark.',
      },
    ],
    careSources: [
      {
        publisher: 'Iowa State University Extension and Outreach',
        title: 'What is the proper care for a moth orchid?',
        url: 'https://yardandgarden.extension.iastate.edu/faq/what-proper-care-moth-orchid',
        accessed: '2026-11-03',
      },
      {
        publisher: 'RHS',
        title: 'How to grow Phalaenopsis (moth orchids)',
        url: 'https://www.rhs.org.uk/plants/phalaenopsis/growing-guide',
        accessed: '2026-11-03',
      },
      {
        publisher: 'University of Maryland Extension',
        title: 'Care of Phalaenopsis Orchids (Moth Orchids)',
        url: 'https://extension.umd.edu/resource/care-phalaenopsis-orchids-moth-orchids',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'hoya',
    commonName: 'Hoya',
    scientificName: 'Hoya carnosa',
    alsoKnownAs: ['Wax Plant', 'Porcelain Flower', 'Hindu Rope Plant', 'Wax Flower'],
    related: ['pothos', 'spider-plant', 'orchid'],
    metaTitle: 'Hoya (Wax Plant) Care: When to Water + Pet Safety',
    heading: 'Hoya care: the wax plant and porcelain flower',
    metaDescription:
      'Water a hoya (wax plant, porcelain flower) thoroughly, then let the mix dry almost completely. Bright, indirect light helps it flower. Pet-safe per the ASPCA.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'A hoya is a trailing plant with thick, almost plastic-feeling leaves that stores its own water and asks very little of you. It’s slow, it’s nearly indestructible, and Hoya carnosa is on the ASPCA non-toxic list — which makes it the pet-safe answer to a hanging pothos.',
    quickFacts: {
      water: 'Water thoroughly, then let the mix dry almost completely; very little in winter',
      light: 'Bright, indirect light; too much sun can scorch or redden the leaves',
      difficulty: 'Very easy',
      toxicity: 'Non-toxic to cats and dogs (the ASPCA lists Hoya carnosa as non-toxic)',
      humidity: 'Adapts to average indoor humidity; 40 to 60% is ideal',
    },
    sections: {
      watering: [
        'Water thoroughly so the whole root zone is wet, then let the mix dry almost completely before watering again. Iowa State University Extension says a hoya is happiest a little on the dry side, and UF/IFAS Gardening Solutions says to let the top third to half of the soil dry out between waterings. Neither gives a number of days.',
        'In winter, or in lower light, water much less: UF says very sparingly. The quickest way to lose one is overwatering in a mix that drains poorly.',
      ],
      light: [
        'Bright, indirect light keeps it healthy and is what gets it to flower. Iowa State University Extension says light is the main driver of blooming, and that many hoyas that never flower are simply not getting enough of it. Too much light can scorch the leaves or turn them red, and low light gives thin, stretched growth.',
        'If you want the flowers, and they are worth wanting, there is one rule that catches everybody out: do not cut off the bare little stalk a flower cluster grew from. Many hoyas rebloom from the same spur year after year, and pruning it off means starting over.',
      ],
      problems: [
        'Yellowing leaves that feel soft mean too much water. It’s the main way hoyas are killed, and it takes a while to show because the plant is so slow — by the time leaves yellow, the roots have usually been sitting wet for weeks.',
        'Wrinkled, dimpled leaves are the honest thirst signal, and a thorough soak fixes them within a couple of days. If a soak doesn’t fix them, check the roots, because rot produces the same symptom.',
        'No flowers on an otherwise healthy plant usually means not enough light, or a plant that’s still too young — hoyas often need a few years before they bloom. Repotting frequently also delays it; they flower better when slightly root-bound.',
      ],
      propagation: [
        'Hoyas root well from stem cuttings with at least one or two nodes. Root them in water, damp sphagnum moss or a chunky, airy mix, and keep them warm and bright. Roots usually appear in two to four weeks.',
        'Don’t cut off the leafless spurs where flowers formed, either on the cutting or the parent; hoyas reflower from the same spurs.',
      ],
      sharedCare: [
        'Hoyas are ideal for households that travel or forget. It is happiest a little on the dry side, so a missed watering does far less harm than an extra one.',
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
        a: 'Thoroughly, and then not again until the mix has dried almost completely, with very little water in winter. The extension sources give no fixed number of days.',
      },
      {
        q: 'Why won’t my hoya flower?',
        a: 'Usually not enough light, or the plant is still young, since hoyas often take several years to mature. Give it bright, indirect light, avoid repotting it often, since they bloom better slightly potbound, and never cut off the bare spur a flower cluster grew from, because it reblooms from the same one.',
      },
      {
        q: 'Why are my hoya leaves wrinkled?',
        a: 'Often thirst, so check the soil and give it a thorough soak if it is dry. If the soil is wet, check the roots instead: overwatering in a poorly drained mix damages them, and damaged roots cannot take up water.',
      },
    ],
    careSources: [
      {
        publisher: 'Iowa State University Extension and Outreach',
        title: 'All About Hoyas',
        url: 'https://yardandgarden.extension.iastate.edu/how-to/all-about-hoyas',
        accessed: '2026-11-03',
      },
      {
        publisher: 'UF/IFAS Gardening Solutions',
        title: 'Hoya',
        url: 'https://gardeningsolutions.ifas.ufl.edu/plants/houseplants/hoya/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'nerve-plant',
    commonName: 'Nerve Plant',
    scientificName: 'Fittonia albivenis',
    alsoKnownAs: ['Fittonia', 'Mosaic Plant', 'Silver Nerve', 'Silver Threads'],
    related: ['calathea', 'begonia', 'african-violet'],
    metaTitle: 'Nerve Plant Care: Water Twice a Week, Keep It Moist',
    heading: 'Nerve plant care: how often to water it',
    metaDescription:
      'Water a nerve plant about twice a week; keep the soil moist, not waterlogged. It wilts when thirsty, recovers fast, and it’s non-toxic to cats and dogs.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The nerve plant is the drama queen of small houseplants: it faints flat when it gets thirsty and springs back up within hours of a drink. Once you know the fainting is theatre rather than death, it’s easy — and the ASPCA lists it as non-toxic to cats and dogs.',
    quickFacts: {
      water: 'About twice a week; keep the soil moist but never waterlogged',
      light: 'Bright to medium light; no direct sun',
      difficulty: 'Easy in the right spot, difficult in a dry room',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'Humid air, though the sources differ on how much',
    },
    sections: {
      watering: [
        'Keep the soil moist. North Carolina State Extension recommends watering about twice a week, and the RHS says fittonias do not like waterlogged compost. Overwatering can cause root rot, so the pot must drain.',
        'The famous collapse is your reminder: when it runs dry the whole plant wilts dramatically, and it usually perks up soon after a thorough watering. It is alarming the first time and routine after that, but check the soil before it gets that far.',
      ],
      light: [
        'Bright to medium light, out of direct sun, which scorches the leaves. North Carolina State Extension says it does well under fluorescent lights too, and that dry air, drafts or direct sun can make the leaves shrivel and fall.',
        'The sources differ on humidity. The RHS says humid air is essential and suggests a bathroom or terrarium. North Carolina State Extension says medium humidity, and that air that is too humid can make the leaves wither. Another plant that wants gentle light, the [begonia](/care/begonia), has its own guide.',
      ],
      problems: [
        'A collapsed, flat plant means it’s thirsty. Water it thoroughly and check again in a few hours. If it doesn’t stand back up after a good soak, look at the roots — sitting wet causes rot, which produces exactly the same wilting.',
        'Brown, crispy leaf edges mean the air is too dry. This is the single hardest thing about a fittonia in a normal home: it wants humidity that a heated room simply doesn’t have. A terrarium, a closed jar, a bathroom, or a cluster of plants under a cloche all solve it permanently.',
        'Yellowing, mushy leaves at the base mean too much water sitting in the pot. Fittonias want moist, not wet, and a pot without a drainage hole is a fast way to lose one.',
      ],
      propagation: [
        'Nerve plants root quickly from stem tip cuttings a few inches long with a node or two. Put them in water or damp potting mix, and keep them humid, under a clear cover or in a closed jar, while they root.',
        'Roots usually appear within a couple of weeks. Pinching the tips off to root them also keeps the parent plant bushy instead of leggy.',
      ],
      sharedCare: [
        'A fittonia is a bad plant to share on a rota and a great plant to share as a visible signal, because it announces its own neglect. When it faints, everybody can see it needs water — no note required.',
        'That said, about twice a week is a short leash for a shared household. If nobody in the house is reliable on that timescale, put it in a closed terrarium or a big jar with a lid, where it keeps itself humid and goes weeks without you. That isn’t a compromise; it’s genuinely how these plants grow best indoors. For a small flowering plant that is more forgiving of a missed day, the [African violet](/care/african-violet) is the other pet-safe windowsill option.',
      ],
      honestBit: [
        'My take: buy a fittonia for a terrarium or a bathroom, not for a shelf in a heated living room. In the right microclimate it’s one of the prettiest and easiest small plants there is. In dry air it’s a slow, sad, crispy-edged disappointment, and no amount of misting will fix that.',
        'It also earns its place if you have pets, because it’s small, it’s safe, and it can live at any height. The ASPCA lists nerve plant as non-toxic to cats and dogs, which means it can sit on a low table or a bedside without you thinking about it — rare for something this decorative.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a nerve plant?',
        a: 'About twice a week, according to North Carolina State Extension, keeping the soil moist but never waterlogged. Small pots dry fast, especially in a warm room.',
      },
      {
        q: 'Why does my fittonia keep collapsing?',
        a: 'Usually thirst. Nerve plants wilt dramatically when the soil dries out and usually recover soon after a thorough watering. If a good soak does not revive it, check the roots for rot.',
      },
      {
        q: 'Why are my fittonia leaves going brown and crispy at the edges?',
        a: 'Dry air, drafts and direct sun can all make the leaves shrivel, according to North Carolina State Extension. The RHS says humid air is essential and suggests a bathroom or terrarium, while North Carolina State says medium humidity and warns that too much can make the leaves wither. Raise the humidity a little and keep it out of drafts and sun.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Fittonia albivenis (Nerve Plant)',
        url: 'https://plants.ces.ncsu.edu/plants/fittonia-albivenis/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'RHS',
        title: 'Fittonia',
        url: 'https://www.rhs.org.uk/plants/fittonia',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'african-violet',
    commonName: 'African Violet',
    scientificName: 'Saintpaulia ionantha',
    alsoKnownAs: ['Saintpaulia', 'African violets'],
    related: ['nerve-plant', 'orchid', 'spider-plant'],
    metaTitle: 'African Violet Care: Watering, Light + Pet Safety',
    metaDescription:
      'How to water an African violet without spotting the leaves, the light it blooms in, and why the ASPCA lists it as non-toxic to cats and dogs.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'African violets bloom almost all year on a bright windowsill, and they have one rule that matters more than the rest: keep cold water off the leaves. The ASPCA lists the African violet as non-toxic to cats and dogs, so it can sit where a curious pet can reach it.',
    quickFacts: {
      water: 'Keep the mix moist but not soggy; water the soil, not the leaves',
      light: 'Moderate to bright, indirect light; a north or northeast window works well',
      difficulty: 'Easy once you learn the watering trick',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: '40 to 60% helps it thrive',
    },
    sections: {
      watering: [
        'Keep an African violet’s potting mix moist but not soggy, and never let the pot sit in water. University of Minnesota Extension says root rot from overwatering is one of the most common reasons they die. Use room-temperature water, ideally distilled, rain or reverse-osmosis water. Neither source gives a number of days.',
        'Water the mix, not the leaves: water left on the leaves causes spots. To water from below, stand the pot in about an inch of room-temperature water until the surface of the soil feels moist, then take it out and let it drain.',
      ],
      light: [
        'Bright, cool light is what makes an African violet bloom. University of Minnesota Extension says north, northwest or northeast windows work well, and South Dakota State University Extension says moderate to bright, indirect light. To flower it also needs a proper night: 8 to 10 hours of darkness a day.',
        'If it makes yellowing leaves and long stems and no flowers, it wants more light. Brown spots on the leaves and flowers, or leaves curling downward, can mean too much. Humidity of 40 to 60% helps it thrive. Turn the pot now and then so it grows evenly.',
      ],
      problems: [
        'Pale rings or spots on the leaves almost always mean cold water landed on them. Use room-temperature water and keep it on the soil, and new leaves will come in clean. Old spotted leaves do not recover, so you can pick them off.',
        'Soft, mushy leaves and a collapsing crown point to rot from wet soil. African violets have fine roots that suffocate in soggy mix, so use a light, airy potting mix made for them and a pot with a drainage hole. Rot at the crown is hard to reverse.',
        'Leaves that stay healthy but never bloom are a light problem far more often than a fertilizer problem. Move the plant brighter before you change anything else.',
      ],
      propagation: [
        'African violets propagate from a single leaf. Cut a healthy leaf with an inch or two of stem, set the stem in a light, damp potting mix so the leaf sits just above the surface, and keep it warm and bright. Roots form in a few weeks and tiny plantlets show up at the base of the stem after that.',
        'Separate the plantlets once they have a few leaves of their own and pot them up individually. The method is slow, usually a couple of months before you see plants, but it is dependable and costs nothing.',
      ],
      sharedCare: [
        'In a shared home, the one rule worth writing on the pot is “water the saucer, not the leaves,” because a well-meaning housemate pouring from the top is how violets end up with leaf spots.',
        'A violet that needs its soil checked regularly fits a simple rota, and it is small enough to move to whoever has the best bright, cool sill. Because it is cited as non-toxic to cats and dogs, it is also a reasonable choice for a household where the pets have free run of the shelves.',
      ],
      honestBit: [
        'My take: African violets get a reputation as fussy, and it is mostly the watering. Once you stop watering from above, they are close to the easiest flowering plant you can own, and a healthy one will bloom for most of the year with no help from you.',
        'The ASPCA lists the African violet as non-toxic to cats and dogs, which is why it is one of the few flowering plants I am relaxed about leaving within reach. Cited as non-toxic is not the same as safe to eat in quantity, so if a pet eats a lot and seems unwell, call your vet. The [pet-safety page for African violet](/pet-safe/african-violet) shows the listing, and the [free pet-safe checker](/pet-safe) covers the plants on your own shelves.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an African violet?',
        a: 'Often enough to keep the potting mix moist but not soggy, never leaving it standing in water. The extension sources give no fixed number of days. Use room-temperature water on the soil, not the leaves.',
      },
      {
        q: 'Why does my African violet have spots on its leaves?',
        a: 'Water left on the leaves causes spots, according to both extension sources. Water the soil or from below, gently shake off any drops, and the new leaves will grow in clean. Brown spots can also mean too much light.',
      },
      {
        q: 'Why is my African violet not blooming?',
        a: 'Usually light. African violets need moderate to bright, indirect light, and enough darkness at night, to bloom. Move yours somewhere brighter, such as a north or northeast window, and give it a few weeks.',
      },
    ],
    careSources: [
      {
        publisher: 'University of Minnesota Extension',
        title: 'African violets',
        url: 'https://extension.umn.edu/garden-and-home/yard-and-garden/gardening-in-minnesota/african-violets',
        accessed: '2026-11-03',
      },
      {
        publisher: 'South Dakota State University Extension',
        title: 'African Violet: Houseplant How-To',
        url: 'https://extension.sdstate.edu/african-violet-houseplant-how',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'poinsettia',
    commonName: 'Poinsettia',
    scientificName: 'Euphorbia pulcherrima',
    alsoKnownAs: ['Christmas Flower', 'Christmas Star', 'Euphorbia'],
    related: ['christmas-cactus', 'anthurium', 'rubber-plant'],
    metaTitle: 'Poinsettia Care and Pet Safety: Past the Holidays',
    metaDescription:
      'How to water a poinsettia, the light it needs, how to keep it alive after the holidays, and what the ASPCA says about poinsettias and cats and dogs.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'A poinsettia is the one houseplant most people bring home in December and lose by February, usually from too much water or a cold drafty doorway. It can last for months with a bright window and a careful hand, and the ASPCA lists it as toxic to cats and dogs.',
    quickFacts: {
      water: 'When the soil surface is dry to the touch; then drain fully',
      light: 'Bright, indirect light near a sunny window',
      difficulty: 'Moderate: easy to keep through winter, hard to rebloom',
      toxicity: 'Toxic to cats and dogs (per the ASPCA); usually mild mouth and stomach irritation',
      humidity: 'No figure in the sources; keep it away from heat vents and drafts',
    },
    sections: {
      watering: [
        'Check a poinsettia’s soil daily with a finger, and when the surface is dry to the touch, water until it runs out of the bottom, then let it drain. Iowa State University Extension gives that rule. Never leave it standing in water: University of Delaware Cooperative Extension says to remove the decorative foil or punch holes in it, and to empty the saucer if water is still there after a few hours.',
        'Too much and too little water both cause trouble, so check the soil before you add any. Iowa State says overwatering yellows and drops the lower leaves and can rot the roots, and that a dry plant wilts and drops leaves early. If the plant is drooping and the soil is wet, more water is the wrong answer.',
      ],
      light: [
        'Give it bright, indirect light near a sunny window, as University of Delaware Cooperative Extension advises, and keep the bracts from touching cold glass. Keep it away from heat vents, radiators and cold drafts: temperatures below 50°F damage it.',
        'Room temperatures of roughly 60 to 70°F, with nights around 60 to 62°F, suit it best, according to the same source. Cool rooms combined with wet soil encourage root rot. The bracts are modified leaves, and they fade slowly whatever you do.',
      ],
      problems: [
        'Dropping leaves usually come from one of three things: soggy soil, a cold draft, or a sudden move from the store. Check the soil first, then check where the plant is standing, and hold it steady in one good spot.',
        'Yellowing lower leaves on a plant that has been well cared for are often just age. If the whole plant yellows and the stems are soft at the base, the roots have rotted and the plant is unlikely to recover.',
        'A sticky white sap from a broken stem is normal for the Euphorbia family. It is a skin and mouth irritant, so keep it away from your face and out of reach of pets.',
      ],
      propagation: [
        'Poinsettias can be rooted from stem cuttings about four to six inches long, taken in late spring or early summer from a plant that has been grown on. Let the milky sap stop flowing, dip the cut end in rooting hormone, and keep the cutting warm and humid. Wear gloves, because the sap irritates skin.',
        'Getting a plant to color up again is a different job. It needs about 14 hours of uninterrupted darkness every night for several weeks in autumn, and most people find that harder than propagating. Treat a second-year color-up as a bonus rather than the goal.',
      ],
      sharedCare: [
        'A poinsettia usually arrives as a gift for the whole house, so name one person who waters it, because a plant everyone waters is how the pot ends up soggy.',
        'It is also one to decide about where the pets are, since the ASPCA lists it as toxic to cats and dogs. Put it on a shelf or table the animals do not use, and tell guests who bring one over that it is not a plant to leave at nose height.',
      ],
      honestBit: [
        'My take: treat a poinsettia as a lovely seasonal plant that happens to live through the winter if you are careful, and do not feel bad if it does not survive to next Christmas. Most of the disappointment comes from a pot that sat wet in its foil.',
        'On pets, the poinsettia’s reputation is worse than the listing suggests. The ASPCA lists it as toxic to cats and dogs, with the milky sap irritating the mouth and stomach, and it is rarely serious. Still keep it out of reach, and if a pet has eaten some and seems unwell, call your vet or a poison hotline. The [pet-safety page for poinsettia](/pet-safe/poinsettia) shows the listing, and the [free pet-safe checker](/pet-safe) covers your other plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a poinsettia?',
        a: 'When the soil surface is dry to the touch; check it daily. Water until it drains from the bottom, let it drain completely, and never leave it standing in the foil sleeve or a full saucer. The extension sources give no fixed number of days.',
      },
      {
        q: 'Why is my poinsettia dropping its leaves?',
        a: 'Usually water or cold. Overwatering yellows and drops the lower leaves, a dry plant drops leaves too, and temperatures below 50°F damage it. Check that the pot drains and keep it away from vents and doors.',
      },
      {
        q: 'How do I keep a poinsettia after Christmas?',
        a: 'Keep it near a bright, sunny window in indirect light, water only when the soil surface is dry, and keep it warm. The colored bracts fade over several weeks, and the plant itself can stay green for the rest of the year.',
      },
    ],
    careSources: [
      {
        publisher: 'Iowa State University Extension and Outreach',
        title: 'How often should I water my poinsettia?',
        url: 'https://yardandgarden.extension.iastate.edu/faq/how-often-should-i-water-my-poinsettia',
        accessed: '2026-11-03',
      },
      {
        publisher: 'University of Delaware Cooperative Extension',
        title: 'Caring for Poinsettias',
        url: 'https://www.udel.edu/academics/colleges/canr/cooperative-extension/fact-sheets/poinsettias/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'sago-palm',
    commonName: 'Sago Palm',
    scientificName: 'Cycas revoluta',
    alsoKnownAs: ['Cycad', 'Cycas', 'King Sago'],
    related: ['parlor-palm', 'jade-plant', 'snake-plant'],
    metaTitle: 'Sago Palm Care and Pet Safety: Watering and Light',
    metaDescription:
      'How often to water a sago palm, how much light it needs, why the fronds yellow, and why the ASPCA lists it as toxic to cats and dogs.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The sago palm is a slow, sturdy plant that is not really a palm, and it is easy to keep alive indoors if you do not overwater it. It is also one of the most dangerous houseplants for pets: the ASPCA lists it as toxic to cats and dogs.',
    quickFacts: {
      water: 'Keep it evenly moist, letting the surface nearly dry between waterings',
      light: 'Bright, filtered sun for 4 to 6 hours a day; no harsh direct sun',
      difficulty: 'Easy to keep, very slow to grow',
      toxicity: 'Toxic to cats and dogs (per the ASPCA); severe, a vet emergency if eaten',
      humidity: 'No figure in the sources',
    },
    sections: {
      watering: [
        'The Missouri Botanical Garden says a sago palm needs regular, consistent moisture, with the soil surface nearly drying out between waterings, and North Carolina State Extension says the soil should be moist and well-drained. Neither gives a number of days. Water thoroughly so it drains from the bottom. That is a wetter routine than [aloe vera](/care/aloe-vera), which waits until the top inch is dry.',
        'What it will not tolerate is overwatering or poor drainage: North Carolina State Extension says either can rot the roots. Use a pot with a drainage hole and never leave it standing in water. Established plants tolerate some drought.',
      ],
      light: [
        'Indoors, both sources recommend filtered sun for 4 to 6 hours a day, such as through a curtain on an east, west or south window. North Carolina State Extension says it prefers bright but indirect light and that harsh sun can damage the fronds.',
        'If you move a plant that has lived in shade into stronger light, do it gradually, and keep it out of harsh direct sun. Scorched fronds do not turn green again.',
      ],
      problems: [
        'Yellow fronds are most often overwatering, especially in winter, when the plant is barely growing. They can also be a sign of poor light or of nutrient shortage. Check the soil and trunk first, because rot is the problem you cannot undo.',
        'New growth arrives in a single flush, usually once a year. A sago that stays put for months is not necessarily unhealthy; it is just slow, and it should flush when the days lengthen and it is warm.',
        'Brown, crispy frond tips are usually dry air or a build-up of minerals from tap water. Trim the brown tips and flush the soil with plain water now and then.',
      ],
      propagation: [
        'The usual method is to remove the small offsets, called pups, that grow at the base of an older plant. Cut or pull a pup away with a bit of root, let the wound dry for a few days, and pot it in a gritty mix. Rooting is slow and not every pup takes.',
        'Seed is a poor option for a home grower, since the seeds are the most dangerous part of the plant and sprout slowly. Wear gloves and wash your hands after handling either pups or seeds.',
      ],
      sharedCare: [
        'In a shared home, a sago palm needs very little care and very clear information, so the person who owns it should tell every housemate and guest that it is a plant to keep away from pets.',
        'It is slow, drought-tolerant and easy to forget, which makes the risk too much care rather than too little. Agree on one person to water it when the soil surface is nearly dry, and put the pot where no pet can chew a frond.',
      ],
      honestBit: [
        'My take: the sago palm is a handsome, architectural plant, and in a house with a dog or a cat I would not own one. The reason is not subtle.',
        'The ASPCA lists the sago palm as toxic to cats and dogs, and every part is a risk, especially the seeds, which can cause liver failure and are often fatal even with treatment. If a pet has eaten any of it, treat it as an emergency and call your vet or a poison hotline straight away. The [pet-safety page for sago palm](/pet-safe/sago-palm) shows the listing, and the [free pet-safe checker](/pet-safe) covers other plants in your home.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a sago palm?',
        a: 'Often enough to keep the soil evenly moist, letting the surface nearly dry between waterings, according to the Missouri Botanical Garden. The sources give no fixed number of days. Water until it drains, and never leave it standing in water: overwatering and poor drainage rot the roots.',
      },
      {
        q: 'Why are my sago palm fronds turning yellow?',
        a: 'The sources do not name one cause. Check the watering first: soggy soil and poor drainage rot the roots. Then check the light, since indoors it wants filtered sun for 4 to 6 hours a day.',
      },
      {
        q: 'Is a sago palm a real palm?',
        a: 'No. It is a cycad, and the Missouri Botanical Garden notes it is botanically closer to conifers than to palms. That is why its care is different from a [parlor palm](/care/parlor-palm)’s.',
      },
    ],
    careSources: [
      {
        publisher: 'Missouri Botanical Garden',
        title: 'Cycas revoluta (Plant Finder)',
        url: 'https://plantfinder.mobot.org/PlantFinderDetails.aspx?taxonid=279640',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Cycas revoluta (Sago Palm)',
        url: 'https://plants.ces.ncsu.edu/plants/cycas-revoluta/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'asparagus-fern',
    commonName: 'Asparagus Fern',
    scientificName: 'Asparagus densiflorus',
    alsoKnownAs: ['Sprenger Fern', 'Emerald Fern', 'Foxtail Fern'],
    related: ['boston-fern', 'spider-plant', 'english-ivy'],
    metaTitle: 'Asparagus Fern Care: Watering + Pet Safety',
    metaDescription:
      'How to water an asparagus fern, why it drops needles, the light it wants, and why the ASPCA lists it as toxic to cats and dogs.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The asparagus fern looks like a soft, feathery fern, but it belongs to the asparagus family, and it is not a true fern. It is easy to grow in a bright room, and the ASPCA lists it as toxic to cats and dogs.',
    quickFacts: {
      water: 'Keep the soil consistently moist but well-drained; less in winter',
      light: 'Bright, indirect light or filtered sun; no hot afternoon sun',
      difficulty: 'Easy in bright light, drops needles if it dries out',
      toxicity: 'Toxic to cats and dogs (per the ASPCA); berries and sap can cause illness',
      humidity: 'Does not need high humidity',
    },
    sections: {
      watering: [
        'Water an asparagus fern regularly from spring to autumn, keeping the soil consistently moist but well-drained. That is the Missouri Botanical Garden’s advice, and it gives no number of days. Its tuberous roots help it cope with a dry spell, but it should not sit in water.',
        'In winter it appreciates a rest with less water. If the plant drops needles after a dry spell, water it normally and be patient.',
      ],
      light: [
        'Bright, indirect light or filtered sun keeps the foliage full and green. The Missouri Botanical Garden warns that hot afternoon sun can yellow the leaves, and says it tolerates full shade, though the foliage may turn a lighter green.',
        'Because the plant arches and trails, it looks best on a shelf, a stand or a hanging basket where the stems have room. It does not need high humidity. Turn the pot occasionally so it grows evenly.',
      ],
      problems: [
        'Yellow, dropping needles are usually dryness or a sudden change in light. Check the soil, move the plant to a brighter spot if it has been in shade, and give it a few weeks before you decide it has failed.',
        'A pot crammed with pale, round, tuberous roots is a plant that needs repotting. If water runs straight through, or roots push up out of the soil, move it into a pot one size up.',
        'The stems carry small thorns, so wear gloves when you repot or prune. Tiny white or red berries that appear on a mature plant are one more reason to keep it away from pets.',
      ],
      propagation: [
        'The easiest way to make more is by division. Slide the plant out of its pot, and cut or pull the root clump into two or three sections, each with healthy tuberous roots and several shoots. Pot each into fresh mix and keep it evenly moist until it settles.',
        'Wear gloves, because the thorns and the roots are both tough. Spring is the best time, as the plant is about to put on growth.',
      ],
      sharedCare: [
        'In a shared household, whoever has the plant on their shelf should be the one who waters it, because an asparagus fern that dries out once drops needles over everyone’s floor.',
        'Its steady watering suits a shared rota. Because the ASPCA lists it as toxic to cats and dogs, put it somewhere the pets cannot reach, and do not mistake it for a Boston fern, which has a different listing.',
      ],
      honestBit: [
        'My take: people buy an asparagus fern because it looks like a fern and then assume it has a fern’s reputation for being safe around pets. It does not. The two plants look related and are not.',
        'The ASPCA lists the asparagus fern as toxic to cats and dogs, and eating the berries can cause vomiting, abdominal pain or diarrhea, while repeated skin contact can cause an allergic rash. Keep it out of reach, and call your vet or a poison hotline if a pet has eaten some. The [pet-safety page for asparagus fern](/pet-safe/asparagus-fern) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an asparagus fern?',
        a: 'Often enough to keep the soil consistently moist but well-drained, with less water in winter. The sources give no fixed number of days. Its tuberous roots help it through a late watering, but it should not sit in a full saucer.',
      },
      {
        q: 'Why is my asparagus fern dropping needles?',
        a: 'Check the basics: soil that has dried out, too little light, or too much hot sun, which the Missouri Botanical Garden says can yellow the leaves. Water it normally, put it somewhere bright out of afternoon sun, and give it a few weeks.',
      },
      {
        q: 'Is an asparagus fern a true fern?',
        a: 'No. It belongs to the asparagus family and reproduces by seed and division rather than spores. That is why it is treated separately from a Boston fern.',
      },
    ],
    careSources: [
      {
        publisher: 'Missouri Botanical Garden',
        title: "Asparagus densiflorus 'Sprengeri' (Plant Finder)",
        url: 'https://plantfinder.mobot.org/PlantFinderDetails.aspx?kempercode=b578',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Texas A&M AgriLife Extension',
        title: 'Sprengeri or Asparagus Fern',
        url: 'https://aggie-horticulture.tamu.edu/ornamental/a-reference-guide-to-plant-care-handling-and-merchandising/selected-foliage-flowering-plants/foliage-plants/sprengeri-or-asparagus-fern/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'haworthia',
    commonName: 'Haworthia',
    scientificName: 'Haworthia',
    alsoKnownAs: ['Haworthia species'],
    related: ['aloe-vera', 'jade-plant', 'snake-plant'],
    metaTitle: 'Haworthia Care: Watering, Light + Pet Safety',
    metaDescription:
      'How often to water a haworthia, the light it wants, why it stretches or shrivels, and why the ASPCA lists it as non-toxic to cats and dogs.',
    reviewed: '2026-10-22',
    updated: '2026-11-03',
    summary:
      'Haworthia is a small, slow rosette of thick, pointed leaves that looks like a miniature aloe and asks for even less. It wants a bright window, a fast-draining mix and a dry spell between waterings. The ASPCA lists it as non-toxic to cats and dogs.',
    quickFacts: {
      water:
        'Weekly in summer if the mix drains well, less in winter; let it dry between waterings',
      light: 'An east or west window with a few hours of direct light a day, or plant lights',
      difficulty: 'Easy: wet soil is the main way to lose one',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'No figure in the extension source; average household air is what it is grown in',
    },
    sections: {
      watering: [
        'Water a haworthia and then let the potting mix dry before you water again. University of Wisconsin–Madison Extension says that in a well-drained mix a haworthia can be watered weekly in the summer, and less often in winter. The roots dislike staying wet, and prolonged wet soil can lead to root rot.',
        'Drainage matters as much as the schedule. Use a pot with a drainage hole and a mix that drains quickly: the same source suggests blending commercial potting mix with equal parts perlite, aquarium gravel, poultry grit or pumice, and advises against sand. When you repot, which it puts at every two to three years, choose a pot about the same volume as the root system.',
      ],
      light: [
        'The extension guidance is an east or west window with a few hours of direct light each day. A south window can also work if the sun is filtered, and haworthias grow well under plant lights.',
        'Too little light shows up as leaves that stretch out and lose color. If your plant is getting longer and paler instead of staying a tight rosette, it wants a brighter spot.',
      ],
      problems: [
        'Root rot is the serious one. It follows poor drainage or too much water, and the signs the extension source lists are growth that stops and leaves that shrivel. A shriveled haworthia in wet soil needs less water, not more, so check the roots before you reach for the can.',
        'Mealybugs, which look like small cottony masses in the joints of leaves and stems, can be picked off by hand or treated with rubbing alcohol on a cotton swab. Stretched, pale growth means the light is too low.',
        'Temperature is forgiving. The Wisconsin source gives an optimum of 75 to 90°F and says a haworthia can tolerate temperatures into the low 40s °F as long as the soil is not continuously wet.',
      ],
      propagation: [
        'Most haworthias grow in a cluster, producing small new plants, called offsets, from the base. These offsets are the easy way to make more.',
        'The Wisconsin source also describes leaf propagation: cut a mature leaf with a little stem tissue and let the wound dry before you pot it. Seed is possible but slow, so offsets are the practical method.',
      ],
      sharedCare: [
        'In a shared home, a haworthia suits a household where watering is one person’s weekly job, since several people each adding a splash is how a succulent ends up in wet soil.',
        'The ASPCA lists it as non-toxic to cats and dogs. It looks like a small [aloe vera](/care/aloe-vera), though, and the ASPCA lists aloe as toxic to cats and dogs, so check which plant you actually own before you tell a housemate it is fine to leave on the floor.',
      ],
      honestBit: [
        'My take: a haworthia is a good first succulent for a bright desk or sill, and a bad one for anyone who waters on a schedule without looking at the soil.',
        'The ASPCA lists haworthia (Haworthia species) as non-toxic to cats and dogs. That listing covers haworthia, not the aloe it resembles. Non-toxic is not the same as safe to eat in quantity, so if a pet eats a lot and seems unwell, call your vet. The [pet-safety page for haworthia](/pet-safe/haworthia) shows the listing, and the [free pet-safe checker](/pet-safe) covers your other plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a haworthia?',
        a: 'In a well-drained mix, about weekly in summer and less in winter, and always after the mix has dried. University of Wisconsin–Madison Extension gives that range and warns that prolonged wet soil leads to root rot.',
      },
      {
        q: 'Why is my haworthia stretching or losing color?',
        a: 'Usually too little light. Move it to an east or west window with a few hours of direct light a day, or put it under a plant light.',
      },
      {
        q: 'What is the difference between a haworthia and a small aloe?',
        a: 'They look alike from a distance, but they are different plants with different ASPCA listings. If yours is an aloe, read the aloe vera guide instead.',
      },
    ],
    careSources: [
      {
        publisher: 'University of Wisconsin–Madison Extension',
        title: 'Haworthias – Super Succulents for Small Spaces',
        url: 'https://hort.extension.wisc.edu/articles/haworthias-super-succulents-for-small-spaces/',
        accessed: '2026-10-22',
      },
    ],
  },
  {
    slug: 'burros-tail',
    commonName: 'Burro’s Tail',
    scientificName: 'Sedum morganianum',
    alsoKnownAs: ['Donkey’s Tail', 'Sedum morganianum'],
    related: ['jade-plant', 'aloe-vera', 'christmas-cactus'],
    metaTitle: 'Burro’s Tail Care: Watering, Light + Pet Safety',
    metaDescription:
      'How to water burro’s tail, the light it needs, why the leaves fall off, and why the ASPCA lists it as non-toxic to cats and dogs.',
    reviewed: '2026-10-22',
    updated: '2026-11-03',
    summary:
      'Burro’s tail is a succulent with long, trailing stems of plump, blue-green leaves, grown in a hanging pot. It wants sun and a long dry spell, and its leaves fall off at a touch. The ASPCA lists it as non-toxic to cats and dogs.',
    quickFacts: {
      water: 'Let the soil dry out between waterings; water less in winter',
      light: 'A sunny windowsill with at least partial sun',
      difficulty: 'Easy to grow, easy to damage: the leaves break off when handled',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'No figure in the sources; it is a drought-tolerant succulent',
    },
    sections: {
      watering: [
        'North Carolina State Extension’s plant database says to let the soil dry out between waterings, to use tepid water, and to water less in winter. The plant is drought-tolerant because its leaves store water.',
        'It needs a well-drained mix and does not tolerate wet or poorly drained conditions. South Dakota State University Extension’s general succulent advice is the same cycle: water until it runs from the drainage hole, let every drop drain away, and wait until the soil is completely dry before watering again.',
      ],
      light: [
        'The North Carolina source recommends high light indoors, such as a windowsill with at least partial sun. For succulents in general, South Dakota State University Extension recommends at least six to eight hours of light, from a south or west window or from a plant light.',
        'If the stems get long and lanky with wide gaps between leaves, the plant is not getting enough light. Rotate the pot now and then so one side does not lean toward the window.',
      ],
      problems: [
        'Dropped leaves are usually handling, not disease. North Carolina State Extension says the leaves are quite delicate, do not tolerate heavy foot traffic and will break off if manipulated. Hang or place the pot where nobody has to brush past it.',
        'Mushy, yellowing leaves point to too much water. The same source lists no serious disease or insect problems apart from occasional slugs and snails outdoors, and it says to avoid wet or poorly drained conditions. Mealybugs, which look like small cottony masses, are a general succulent pest and can be treated with rubbing alcohol.',
        'It is a warm-climate plant. The North Carolina source lists USDA zones 10 and 11 and says it tolerates temperatures down to 40°F outdoors, so keep it indoors in a cold climate.',
      ],
      propagation: [
        'This is one of the easy plants to multiply. North Carolina State Extension says cuttings and dropped leaves root easily, and lists division, leaf cuttings and stem cuttings as methods.',
        'That makes the fallen leaves worth keeping. Set them on a well-drained succulent mix and leave them to root, rather than sweeping them away.',
      ],
      sharedCare: [
        'In a shared household, a burro’s tail needs a house rule about handling, because the leaves are delicate and fall off whenever someone brushes past or moves the pot.',
        'The ASPCA lists it as non-toxic to cats and dogs. Do not let that carry over to the [jade plant](/care/jade-plant), another common succulent, which the ASPCA lists as toxic to cats and dogs. A long trailing stem at paw height is also an invitation to bat, and a fallen leaf on the floor is easy to miss.',
      ],
      honestBit: [
        'My take: burro’s tail looks right hung where nobody touches it, and it punishes the person who moves it every week to get a better photo.',
        'The ASPCA lists burro’s tail (Sedum morganianum) as non-toxic to cats and dogs. Non-toxic is not the same as safe to eat in quantity, so if a pet eats a lot and seems unwell, call your vet. The [pet-safety page for burro’s tail](/pet-safe/burros-tail) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a burro’s tail?',
        a: 'When the soil has dried out completely, and less in winter. North Carolina State Extension’s advice is to let the soil dry between waterings, and it gives no fixed number of days.',
      },
      {
        q: 'Why do the leaves fall off my burro’s tail?',
        a: 'Most often because it was touched or moved. The leaves are delicate and break off when manipulated. Wet soil and poor drainage are the other causes to rule out.',
      },
      {
        q: 'Can I grow a new burro’s tail from the leaves that fell?',
        a: 'Yes. North Carolina State Extension says cuttings and dropped leaves root easily, so keep them on a well-drained succulent mix.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Sedum morganianum (Burro’s Tail)',
        url: 'https://plants.ces.ncsu.edu/plants/sedum-morganianum/',
        accessed: '2026-10-22',
      },
      {
        publisher: 'South Dakota State University Extension',
        title: 'How to Care for Succulents Indoors',
        url: 'https://extension.sdstate.edu/how-care-succulents-indoors',
        accessed: '2026-10-22',
      },
    ],
  },
  {
    slug: 'blue-echeveria',
    commonName: 'Blue Echeveria',
    scientificName: 'Echeveria glauca',
    alsoKnownAs: ['Echeveria glauca'],
    related: ['jade-plant', 'aloe-vera', 'christmas-cactus'],
    metaTitle: 'Blue Echeveria Care: Watering, Light + Pet Safety',
    metaDescription:
      'How to water a blue echeveria, the light it needs, why it stretches, and why the ASPCA lists this species as non-toxic to cats and dogs.',
    reviewed: '2026-10-22',
    updated: '2026-11-03',
    summary:
      'Blue echeveria is a tight rosette of blue-gray leaves that holds its shape in strong light and loses it in weak light. It rots in wet soil and stretches in a dim room. The ASPCA lists this species as non-toxic to cats and dogs.',
    quickFacts: {
      water: 'Water thoroughly, then let the soil dry completely; about weekly or less',
      light: 'Full sun, six or more hours, or a south or west window with a plant light',
      difficulty: 'Moderate: it needs more light than most houseplants',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'No figure in the sources; it is a dry-air succulent',
    },
    sections: {
      watering: [
        'North Carolina State Extension’s plant database says not to over-water these plants, to prevent root rot, and to plant them in conditions with good drainage that are occasionally dry. South Dakota State University Extension’s general succulent rule fits: water until it runs from the drainage hole, let every drop drain away, then wait until the soil is completely dry.',
        'South Dakota State puts the frequency for indoor succulents at once a week or less, depending on how quickly the soil dries, and says to water less in fall and winter. Overwatering is one of the most common ways they die.',
      ],
      light: [
        'The North Carolina source lists full sun, meaning six or more hours of direct sun a day, or partial shade with two to six hours. South Dakota State recommends at least six to eight hours of light for succulents indoors, from a southern or western window, with artificial light to make up a shortfall.',
        'A rosette that opens out and grows long and lanky is asking for more light. Rotate the pot often so it does not lean.',
      ],
      problems: [
        'Soft, mushy, yellowing leaves mean the roots are wet. Cut back on water, make sure the pot drains, and use a mix that drains faster than regular potting soil: South Dakota State suggests one part potting soil to one part coarse sand, pumice or perlite.',
        'The two sources differ on feeding. North Carolina State says not to over-water or fertilize these plants. South Dakota State says succulents can be fed in spring and summer, every three to four waterings, with a water-soluble fertilizer at half the label rate. If you are unsure, feed less rather than more.',
        'Mealybugs look like small cottony masses in the joints of leaves and stems, and rubbing alcohol treats them. The North Carolina source lists no significant disease or insect problems.',
      ],
      propagation: [
        'North Carolina State Extension says the plant readily makes offsets that can be propagated when they are large enough, and lists division, leaf cuttings, stem cuttings, root cuttings and seed as methods.',
        'The practical method indoors is to wait until an offset is big enough to handle, then pot it in a well-drained succulent mix.',
      ],
      sharedCare: [
        'In a shared household, a blue echeveria is a plant for the sunniest sill and one named waterer, because it wants a long dry spell that a helpful housemate with a watering can will interrupt.',
        'The ASPCA lists this species, Echeveria glauca, as non-toxic to cats and dogs. It is a listing for one species, so do not read it as a verdict on succulents in general: the ASPCA lists the [jade plant](/care/jade-plant) and aloe as toxic to cats and dogs.',
      ],
      honestBit: [
        'My take: echeveria is a plant for a window that gets real sun. In a dim room it slowly turns into a stretched, pale version of itself, and no schedule fixes that.',
        'The ASPCA lists blue echeveria (Echeveria glauca) as non-toxic to cats and dogs. The listing names this one species, so a differently named echeveria needs its own check. Non-toxic is not the same as safe to eat in quantity, so if a pet eats a lot and seems unwell, call your vet. The [pet-safety page for blue echeveria](/pet-safe/blue-echeveria) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a blue echeveria?',
        a: 'About once a week or less, and after the soil has dried completely, not before. Water less in fall and winter. South Dakota State University Extension gives that range for indoor succulents.',
      },
      {
        q: 'How much light does a blue echeveria need indoors?',
        a: 'A lot: six or more hours of direct sun, or a south or west window with a plant light. In less light the rosette stretches and loses its shape.',
      },
      {
        q: 'Can a blue echeveria live outdoors?',
        a: 'In a warm climate. North Carolina State Extension lists USDA zones 9 through 12 and says it will not survive a hard frost.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Echeveria secunda (Blue Echeveria)',
        url: 'https://plants.ces.ncsu.edu/plants/echeveria-secunda/',
        accessed: '2026-10-22',
      },
      {
        publisher: 'South Dakota State University Extension',
        title: 'How to Care for Succulents Indoors',
        url: 'https://extension.sdstate.edu/how-care-succulents-indoors',
        accessed: '2026-10-22',
      },
    ],
  },
  {
    slug: 'begonia',
    commonName: 'Begonia',
    scientificName: 'Begonia',
    alsoKnownAs: ['Begonia spp.', 'Rex Begonia', 'Cane Begonia', 'Wax Begonia'],
    related: ['nerve-plant', 'african-violet', 'calathea'],
    metaTitle: 'Begonia Care: Watering, Light + Pet Safety',
    metaDescription:
      'How to water a houseplant begonia, the light and humidity it wants, why leaves go bad, and why the ASPCA lists it as toxic to cats and dogs.',
    reviewed: '2026-10-22',
    updated: '2026-11-03',
    summary:
      'Begonia is a large genus, and the ones sold as houseplants range from striped rex leaves to cane-stemmed angel wings and wax begonias in bloom. They agree on a bright spot without hot sun, evenly moist soil and humid air. The ASPCA lists it as toxic to cats and dogs.',
    quickFacts: {
      water: 'Keep evenly moist, drying a little between waterings; less in winter',
      light: 'A bright spot away from hot direct sun; early morning sun is fine',
      difficulty: 'Moderate: humidity and watering both need attention',
      toxicity:
        'Toxic to cats and dogs (per the ASPCA); vomiting and drooling; the most toxic part is underground',
      humidity: 'Humid air; spray the air around it rather than misting the leaves',
    },
    sections: {
      watering: [
        'Clemson Cooperative Extension’s advice for indoor begonias is to keep the soil evenly moist, allowing it to dry a little between waterings, to reduce water in winter, and never to let the pot sit in a saucer of water. University of Minnesota Extension adds that begonias are highly susceptible to root rot, and that by the time the symptoms show it is usually too late to cure.',
        'Water at the base of the plant when you can. Minnesota Extension recommends it to avoid fungal leaf diseases.',
      ],
      light: [
        'The two extension sources agree on the principle and differ on the amount. Clemson puts flowering begonias in a bright spot that gets some direct sun, such as early morning sun in an east window, and puts foliage begonias such as rex types in a bright spot away from direct sun. University of Minnesota Extension says begonias prefer shade over direct sun, tolerate morning sun, and should avoid afternoon sun.',
        'The sensible reading is that rex and other foliage types want the gentler end of that range, and flowering types can take a little morning sun.',
      ],
      problems: [
        'Humidity is the common trouble indoors. Clemson says a humid environment is needed but misting is not recommended, and advises spraying the surrounding air instead. For foliage begonias it gives a temperature of 66 to 73°F, with nights not dropping below 55°F.',
        'The pests Clemson lists are mealybugs, whiteflies and spider mites, and it says diseases are an infrequent problem in the home. Minnesota Extension names powdery mildew and says good air circulation helps prevent leaf diseases.',
        'Feed with a balanced liquid fertilizer at half strength on alternate waterings, as Clemson advises, and repot in spring.',
      ],
      propagation: [
        'University of Minnesota Extension says begonias are easily propagated by cuttings in about three to four weeks. Take a 2 to 3 inch section, strip the lower leaves, stand it in water until roots form, then pot it.',
        'Clemson adds that a begonia that has become pot-bound can be divided when you repot it in spring.',
      ],
      sharedCare: [
        'In a shared household, a begonia needs one person who watches the soil and the humidity, because the two things it dislikes are opposites: soggy soil and dry air.',
        'Because the ASPCA lists it as toxic to cats and dogs, keep the pot where the animals do not dig or chew. The ASPCA says the most toxic part is underground, which is a reason to keep a pet out of the soil as well as off the leaves.',
      ],
      honestBit: [
        'My take: begonia is a name for hundreds of plants, and the advice on a tag for one type is not always right for another. Find out whether yours is a rex, a cane or a wax begonia before you copy a schedule.',
        'The ASPCA lists begonia (Begonia spp.) as toxic to cats and dogs. It names soluble calcium oxalates, lists vomiting and drooling in dogs and cats, mentions kidney failure in grazing animals, and says the most toxic part is underground. University of Minnesota Extension also calls begonias toxic to cats and dogs. If a pet has eaten some, call your vet or a poison hotline. The [pet-safety page for begonia](/pet-safe/begonia) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a begonia?',
        a: 'When the top of the soil has dried slightly, keeping it evenly moist and never soggy, and less in winter. Clemson Cooperative Extension gives that rule for indoor begonias.',
      },
      {
        q: 'Why are my begonia’s leaf edges turning brown?',
        a: 'Dry air is the usual suspect, since begonias need a humid environment. Clemson advises spraying the air around the plant rather than misting the leaves. Uneven watering is the other thing to check.',
      },
      {
        q: 'Which kinds of begonia does this guide cover?',
        a: 'The common houseplant types: rex and other foliage begonias, cane-stemmed begonias and wax begonias. Tuberous begonias are grown from tubers that are dug up and stored in the fall, so their care is different.',
      },
    ],
    careSources: [
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Growing Begonias Indoors',
        url: 'https://hgic.clemson.edu/factsheet/growing-begonias-indoors/',
        accessed: '2026-10-22',
      },
      {
        publisher: 'University of Minnesota Extension',
        title: 'Begonia',
        url: 'https://extension.umn.edu/garden-and-home/yard-and-garden/gardening-in-minnesota/begonia',
        accessed: '2026-10-22',
      },
    ],
  },
  {
    slug: 'lily',
    commonName: 'True Lily',
    scientificName: 'Lilium',
    alsoKnownAs: ['Easter Lily', 'Lilium longiflorum'],
    related: ['peace-lily', 'anthurium', 'orchid'],
    metaTitle: 'Lily Care: Easter Lily Indoors + Cat Safety',
    metaDescription:
      'How to keep a potted Easter lily indoors, what to do after it blooms, and why the ASPCA lists lilies as toxic to cats and non-toxic to dogs.',
    reviewed: '2026-10-22',
    updated: '2026-11-03',
    summary:
      'A potted Easter lily is a gift plant that blooms once indoors for a few weeks, then goes outdoors if you want to keep it. Care is simple. The risk is not: the ASPCA lists lilies as toxic to cats and non-toxic to dogs, and a lily is dangerous to a cat.',
    quickFacts: {
      water: 'When the soil surface feels dry; water until it drains, then empty the cover',
      light: 'Bright light, out of direct sun',
      difficulty: 'Easy to keep for a few weeks; keeping one for years means planting it outdoors',
      toxicity:
        'Cats: toxic (per the ASPCA); kidney failure, and a cat that touches any part needs a vet at once. Dogs: non-toxic',
      humidity: 'Not covered by the extension sources; keep it away from drafts and heat vents',
    },
    sections: {
      watering: [
        'Iowa State University Extension says to water an Easter lily when the soil surface becomes dry to the touch, and to water until it flows out the bottom of the pot, then let it drain before it goes back into its decorative cover. Nebraska Extension in Lancaster County says the same: wait until the soil feels dry to the touch before watering, and do not overwater.',
        'A pot wrapped in decorative foil is easy to leave standing in water, so lift it out and let it drain each time.',
      ],
      light: [
        'Both extension sources want bright light without direct sun. Iowa State gives daytime temperatures of 65 to 70°F with slightly cooler nights, and Nebraska gives 65 to 75°F by day. Keep the plant away from drafts and from drying heat sources such as appliances and heating ducts.',
        'Nebraska adds that removing the yellow anthers, the pollen-bearing pods in the center of each flower, prolongs the life of the blossoms. Iowa State says to do it before the pollen starts to shed, which also prevents the pollen staining the petals.',
      ],
      problems: [
        'The extension sources cover how to keep the plant, not what goes wrong with it. The thing to know about a lily in a house is the risk to a cat, set out in the pet section below.',
        'Remove flowers as they wither. Iowa State says that after flowering the plant can be discarded or saved and planted outdoors in the perennial garden.',
      ],
      propagation: [
        'The sources do not describe making more plants from a pot. They describe what to do after the bloom if you want to keep the plant: Nebraska says to plant the Easter lily outdoors as soon as the ground can be worked, in a sunny site with well-drained soil, with the top of the bulb 6 inches below the surface.',
        'Do not cut the stem back until it dies down in the fall, and after the soil surface freezes in late fall, mulch it and leave the mulch until new growth begins in spring.',
      ],
      sharedCare: [
        'In a shared household, a lily needs everyone to know it is a danger to the cat, because a bouquet or a pot that a housemate brings home as a gift is exactly how it arrives.',
        'Because the ASPCA lists it as toxic to cats, do not keep it in a home with a cat, and tell visitors who bring flowers. The ASPCA lists it as non-toxic to dogs. A [peace lily](/care/peace-lily) is a different plant with its own listing, so look it up on its own page.',
      ],
      honestBit: [
        'My take: if you share your home with a cat, do not bring in an Easter lily, however well it would do on your table. There is no care tip that makes it a safe plant for a cat.',
        'The ASPCA lists lily (Lilium species) as toxic to cats and non-toxic to dogs, with kidney failure as the sign for cats. Its separate listing for Easter lily (Lilium longiflorum) names vomiting, inappetence, lethargy and kidney failure in cats, says death is possible, and says cats are the species known to be affected. Purdue University’s veterinary college says the entire lily plant is toxic to cats, including the pollen and the water in a vase, that early signs can appear within minutes up to 12 hours, and that kidney failure develops within 24 to 72 hours. If a cat has had any contact, call your vet or a poison hotline immediately. For dogs, the ASPCA lists lily as non-toxic, and Purdue, quoting the FDA, says a dog may have minor stomach upset but does not develop kidney failure. The [pet-safety page for lily](/pet-safe/lily) shows the listing, and the [free pet-safe checker](/pet-safe) covers your other plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an Easter lily?',
        a: 'When the soil surface feels dry to the touch, then until water runs out of the bottom, letting it drain before it goes back in its cover. Do not overwater. That is the advice of Iowa State University Extension and Nebraska Extension.',
      },
      {
        q: 'What do I do with an Easter lily after it blooms?',
        a: 'Remove the spent flowers, then either discard it or plant it outdoors in a sunny, well-drained spot as soon as the ground can be worked. Do not cut the stem back until it dies down in the fall.',
      },
      {
        q: 'Is a peace lily or a calla lily a true lily?',
        a: 'No. A peace lily is a different plant with its own care guide and its own ASPCA listing. This guide covers the true lily, the genus Lilium.',
      },
    ],
    careSources: [
      {
        publisher: 'Iowa State University Extension and Outreach',
        title: 'How should I care for my Easter lily?',
        url: 'https://yardandgarden.extension.iastate.edu/faq/how-should-i-care-my-easter-lily',
        accessed: '2026-10-22',
      },
      {
        publisher: 'Nebraska Extension in Lancaster County',
        title: 'Easter Lily Care',
        url: 'https://lancaster.unl.edu/easter-lily-care/',
        accessed: '2026-10-22',
      },
    ],
  },
  {
    slug: 'string-of-pearls',
    commonName: 'String of Pearls',
    scientificName: 'Curio rowleyanus (formerly Senecio rowleyanus)',
    alsoKnownAs: ['String of Beads', 'Senecio rowleyanus', 'Rosary Vine'],
    related: ['burros-tail', 'jade-plant', 'peperomia'],
    metaTitle: 'How Often to Water String of Pearls: When It Is Dry',
    metaDescription:
      'Water string of pearls sparingly, once the mix has dried, not on a set day count. Overwatering is what usually kills it. Bright, indirect light.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'String of pearls is a trailing succulent with stems of small, round, bead-like leaves, usually grown in a hanging pot. The beads hold water, so the way most people lose one is too much water, not too little.',
    quickFacts: {
      water: 'Sparingly, once the mix is dry; overwatering kills it',
      light: 'Bright, indirect light; direct sun can scorch it',
      difficulty: 'Moderate',
      toxicity: 'Unknown: the ASPCA plant list has no entry for string of pearls',
      humidity: 'Humidity tolerant; the sources give no figure',
    },
    sections: {
      watering: [
        'Water string of pearls sparingly, and only once the mix has dried. Neither extension source gives a number of days, and they disagree on how far to let it dry. Wisconsin Horticulture says to let the mix dry out completely and to water when the pearls begin to look a little shriveled. North Carolina State Extension says it tolerates infrequent watering but should not dry out all the way.',
        'Both name the same killer: overwatering, and the root rot that follows, which Wisconsin calls the most common way the plant dies. So when in doubt, wait a day. Give more water in summer than in winter, and use a mix that drains fast. NC State suggests cactus mix, or potting soil cut with sand or perlite. Wisconsin suggests adding grit or pumice and using a shallow clay pot, which dries faster than plastic.',
      ],
      light: [
        'Indoors, give it bright, indirect light; North Carolina State Extension says direct sun can scorch the leaves. Wisconsin Horticulture notes that in the wild it often grows in partial shade under shrubs or between rocks. If it spends the summer outdoors, move it out gradually so it does not sunburn, and bring it back in before frost.',
        'Wisconsin suggests a cool winter rest at 55 to 60°F. NC State lists the plant as humidity tolerant, and neither source gives a humidity figure.',
      ],
      problems: [
        'Soggy soil is the main threat. NC State says it leads to root rot that can kill the plant. Wilting can come from too much water or too little, so check the mix before you water a limp plant.',
        'For pests, Wisconsin names mealybugs and aphids, and NC State adds whiteflies, gnats and ants. NC State says yellow or graying leaves may point to insects.',
        'NC State also says older plants tend to decline after several years, so the fix for a tired plant is fresh cuttings rather than a rescue.',
      ],
      propagation: [
        'Stem cuttings are the method both sources give. Wisconsin Horticulture says to take stem tips 3 to 4 inches long, strip the bottom few leaves, and set them in or on moist potting mix with the lower nodes lightly covered. Roots form at each node. Mist the surface until they take, rather than soaking it.',
        'NC State gives 3 to 5 inch cuttings with a few nodes covered by mix, and says rooting dropped leaves is possible but slower and less reliable.',
      ],
      sharedCare: [
        'In a shared household, string of pearls needs one waterer, because the plant that dies of kindness is the one two people each topped up.',
        'Hang it in bright light where nobody has to brush past it, and agree that slightly wrinkled beads are the signal to water, not a date on the calendar. NC State says the sap can irritate skin, so whoever trims it or takes cuttings may want gloves.',
      ],
      honestBit: [
        'My take: this is a plant for people who can leave a pot alone. The ones that die were usually watered on a schedule; the ones that thrive were watered when the beads asked.',
        'On pets we don’t give a verdict for this one. The ASPCA plant list, the source this site uses for pet safety, has no entry for string of pearls under that name or its scientific names, and we won’t borrow the verdict of a different plant that shares its old genus name. If you have a pet that chews, hang it out of reach, or pick a trailing plant with a cited answer from the [free pet-safe checker](/pet-safe).',
      ],
    },
    faqs: [
      {
        q: 'How often should I water string of pearls?',
        a: 'Once the mix has dried, not on a set number of days; the extension sources give no interval. Slightly wrinkled pearls are the plant asking for water. Soggy soil is the thing to avoid.',
      },
      {
        q: 'Why is my string of pearls dying?',
        a: 'Most often too much water. Wisconsin Horticulture names root rot from overwatering as the most common cause. Let the mix dry, use a fast-draining cactus mix, and check for mealybugs and aphids.',
      },
      {
        q: 'How do you propagate string of pearls?',
        a: 'From stem tips 3 to 4 inches long, with the bottom leaves removed and the lower nodes lightly covered in moist mix. Mist the surface instead of soaking it until roots form.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Curio rowleyanus (String of Pearls)',
        url: 'https://plants.ces.ncsu.edu/plants/curio-rowleyanus/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Wisconsin Horticulture, University of Wisconsin–Madison Division of Extension',
        title: 'String of Pearls, Curio rowleyanus',
        url: 'https://hort.extension.wisc.edu/articles/string-of-pearls-senecio-rowleyanus/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'prayer-plant',
    commonName: 'Prayer Plant',
    scientificName: 'Maranta leuconeura',
    alsoKnownAs: ['Maranta', 'Red-Veined Prayer Plant', 'Herringbone Plant', 'Rabbit Tracks'],
    related: ['calathea', 'nerve-plant', 'boston-fern'],
    metaTitle: 'How Often to Water a Prayer Plant: Keep It Evenly Moist',
    metaDescription:
      'Keep a prayer plant’s soil evenly moist through the growing season and let it dry a little in winter. It wants bright, indirect light and high humidity.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The prayer plant, Maranta leuconeura, is grown for its patterned leaves, which lie flat by day and fold upward at night: the movement that gives it its name. It wants evenly moist soil, humid air, and light that is bright but not direct.',
    quickFacts: {
      water: 'Keep it evenly moist; let it dry a little in winter',
      light: 'Bright, indirect light; direct sun bleaches the leaves',
      difficulty: 'Moderate',
      toxicity: 'Unknown: no ASPCA plant listing names Maranta leuconeura',
      humidity: 'High humidity; a pebble tray or humidifier helps',
    },
    sections: {
      watering: [
        'A prayer plant wants its soil evenly moist from spring through summer, neither bone dry nor soggy. In winter, let the soil dry between waterings, though Illinois Extension says not to let it dry out completely. The extension sources give no number of days, so check the soil instead of the calendar.',
        'Water the soil, not the crown. Illinois Extension warns that water left standing on the crowns rots the stems easily, and North Carolina State Extension says poorly drained soil leads to root rot.',
      ],
      light: [
        'Both sources call for bright, indirect light. NC State says too much sun bleaches the leaf color, and that the plant tolerates low to medium light but not direct sun. It also says the color fades in low light or when the plant is underfed.',
        'Humidity matters as much as light. Both sources say it needs high humidity. NC State suggests a humidified room or setting the pot on a tray of wet pebbles, and says it does not tolerate low temperatures or cold drafts.',
      ],
      problems: [
        'Burned leaves point to the water or the feeding. NC State says high fluoride levels and over-fertilizing both burn the leaves, so feed lightly.',
        'Rotting stems at the base come from water sitting on the crown, or from soil that stays wet. NC State lists no serious pest or disease problems, with occasional spider mites and mealybugs to watch for.',
        'Leaves that fold up at night are not a problem. That daily movement is what the plant is named for.',
      ],
      propagation: [
        'North Carolina State Extension says to propagate a prayer plant by dividing its rhizomes. Ease the plant out of its pot and separate it into clumps, each with its own roots and leaves, then pot them in moist potting mix.',
        'Illinois Extension’s page does not cover propagation, so division is the one method this guide gives.',
      ],
      sharedCare: [
        'In a shared household, a prayer plant needs one person watching it, because it wants steady moisture and humid air, and both slip when nobody owns them.',
        'Agree on how it gets watered as well as when: at the soil, not over the crown. A pebble tray or a humidifier in the room takes some pressure off whoever is in charge.',
      ],
      honestBit: [
        'My take: the nightly fold is the reason to own one. Treat humidity as part of the watering routine rather than an extra, and it is a much easier plant than its reputation.',
        'On pets we don’t give a verdict for this one. The ASPCA plant list, the source this site uses for pet safety, has no listing that names this species, Maranta leuconeura, and we won’t borrow a verdict from a relative. The [calathea](/care/calathea) is a related plant with its own listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a prayer plant?',
        a: 'Often enough to keep the soil evenly moist through spring and summer, and less in winter, when the soil can dry between waterings. The extension sources give no set number of days, so check the soil with a finger.',
      },
      {
        q: 'Why does my prayer plant fold its leaves at night?',
        a: 'That is normal. The leaves lie flat by day and fold upward at night, which is where the name comes from.',
      },
      {
        q: 'Is a prayer plant the same as a calathea?',
        a: 'No, though they are relatives and the name is sometimes used for both. North Carolina State Extension gives the name prayer plant to Maranta leuconeura, the plant this guide covers. Calathea has its own [care guide](/care/calathea).',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Maranta leuconeura (Prayer Plant)',
        url: 'https://plants.ces.ncsu.edu/plants/maranta-leuconeura/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Illinois Extension',
        title: 'Prayer Plant',
        url: 'https://extension.illinois.edu/houseplants/prayer-plant',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'croton',
    commonName: 'Croton',
    scientificName: 'Codiaeum variegatum',
    alsoKnownAs: ['Garden Croton', 'Joseph’s Coat', 'Fire Croton'],
    related: ['rubber-plant', 'fiddle-leaf-fig', 'alocasia'],
    metaTitle: 'How Often to Water a Croton: When the Top Inch Is Dry',
    metaDescription:
      'Water a croton when the top half-inch to inch of soil is dry, and less in winter. Too wet or too dry for long and it drops leaves. Bright light keeps the color.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'Croton is grown for leaves splashed with yellow, orange, red and green, and it keeps those colors only in bright light. It drops leaves when its conditions change too far or too fast, so the trick is keeping things steady.',
    quickFacts: {
      water: 'When the top half-inch to inch of soil is dry',
      light: 'Bright light for color; the sources differ on direct sun',
      difficulty: 'Moderate to hard',
      toxicity: 'Unknown: the ASPCA plant list has no entry for the croton',
      humidity: 'Moderate humidity; the sources differ on how much',
    },
    sections: {
      watering: [
        'Water a croton when the top half-inch to an inch of soil has dried, then water well. Wisconsin Horticulture gives that depth and no number of days. North Carolina State Extension says to water liberally from spring to fall and sparingly in winter, when the plant rests.',
        'Wisconsin says a croton drops leaves when it stays too wet or too dry for long, so steady matters more than generous. It does best in fertile, well-drained soil that stays moist.',
      ],
      light: [
        'The sources agree that a croton needs bright light to keep its color, and differ on direct sun. Wisconsin says bright, indirect light is best indoors and that too much direct sun leaves the leaves gray and dull. NC State says it needs bright light with some direct sun, and that too much shade makes the lower leaves drop. Wisconsin adds that in low light the leaves can revert to green.',
        'They differ on humidity too. Wisconsin says moderate to high, while NC State lists low to medium and suggests setting the pot on a tray of wet pebbles. Wisconsin gives a temperature range of 60 to 85°F.',
      ],
      problems: [
        'Sudden leaf drop is the croton’s signature complaint. Wisconsin lists the causes: soil kept too wet or too dry for long stretches, temperatures below 50°F, drafts, and a change of surroundings that comes too quickly. A move to a new home is that kind of change, so some drop after you bring one home is no surprise.',
        'Spider mites are the common pest; NC State says they sometimes limit how long a croton can be kept indoors. Wisconsin also names mealybugs and scale.',
        'A croton that gets leggy can be pruned hard in early spring to make it branch, Wisconsin says.',
      ],
      propagation: [
        'Wisconsin Horticulture says a croton is easily propagated by air layering in spring or by softwood cuttings in summer. Plants grown from seed do not match the parent, so a named variety has to be propagated from the plant itself.',
        'Cut stems ooze a milky sap, so wear gloves and keep it off your clothes. NC State’s page does not cover propagation.',
      ],
      sharedCare: [
        'In a shared household, a croton does best with one person in charge, because it reacts to every change and a plant moved and watered by three different people will drop leaves for all of them.',
        'Pick its spot once, in bright light and away from drafts, and agree not to move it. Wisconsin says the milky sap from cut stems may cause contact dermatitis in some people, and NC State says it stains fabric permanently, so wash your hands after handling it.',
      ],
      honestBit: [
        'My take: a croton is a plant for the brightest spot you have and a household that leaves it there. The colors are the reward for light, and the dropped leaves are the price of moving it around.',
        'On pets we don’t give a verdict for this one. The ASPCA plant list, the source this site uses for pet safety, has no entry for croton or Codiaeum, and we won’t guess. If you have a pet that chews, keep it out of reach, or pick a plant with a cited answer from the [free pet-safe checker](/pet-safe).',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a croton?',
        a: 'When the top half-inch to an inch of soil is dry, and less in winter. Wisconsin Horticulture gives that depth, and neither source gives a fixed number of days.',
      },
      {
        q: 'Why is my croton dropping leaves?',
        a: 'Usually a change it did not like: soil that stayed too wet or too dry, temperatures below 50°F, a draft, or a move to a new spot. Keep its conditions steady and it should settle.',
      },
      {
        q: 'Why is my croton losing its color?',
        a: 'Too little light. Wisconsin Horticulture says the leaves can revert to green in low light, so move it somewhere brighter.',
      },
    ],
    careSources: [
      {
        publisher: 'Wisconsin Horticulture, University of Wisconsin–Madison Division of Extension',
        title: 'Croton, Codiaeum variegatum',
        url: 'https://hort.extension.wisc.edu/articles/croton-codiaeum-variegatum/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Codiaeum variegatum (Croton)',
        url: 'https://plants.ces.ncsu.edu/plants/codiaeum-variegatum/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'chinese-money-plant',
    commonName: 'Chinese Money Plant',
    scientificName: 'Pilea peperomioides',
    alsoKnownAs: ['Pilea', 'Pancake Plant', 'UFO Plant', 'Coin Plant'],
    related: ['peperomia', 'spider-plant', 'hoya'],
    metaTitle: 'How Often to Water a Chinese Money Plant (Pilea)',
    metaDescription:
      'Water a Chinese money plant when the top of the mix starts to dry, and less in winter. Root rot from overwatering is the main risk. Bright, indirect light.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The Chinese money plant, Pilea peperomioides, is the one with round, coin-like leaves on long stalks. It is a fast-growing, low-maintenance houseplant that makes small offsets around its base, and those are easy to pot up as new plants.',
    quickFacts: {
      water: 'When the top of the mix starts to dry; less in winter',
      light: 'Bright, indirect light; strong summer sun can scorch it',
      difficulty: 'Easy',
      toxicity: 'Unknown: the ASPCA plant list has no entry for Pilea peperomioides',
      humidity: 'Average household humidity is fine',
    },
    sections: {
      watering: [
        'Water a Chinese money plant when the top of the mix starts to dry out. The RHS suggests checking with a finger or by lifting the pot: a light pot means it is time. No source gives a number of days. Water less in winter, and pour off what collects in the saucer so the roots do not sit in soggy mix.',
        'Overwatering is the main risk, and both sources say it rots the roots. North Carolina State Extension also says to keep water off the leaves, because wet foliage can develop leaf spots. The RHS says rainwater or filtered water is best if you have it, though tap water is tolerated, and that a pot much bigger than the root ball holds water too long.',
      ],
      light: [
        'Bright, indirect light suits it. The RHS suggests a north-, east- or west-facing window, or a spot set back from a south-facing one, especially in summer, and says too much direct sun turns the leaves red-brown. Both sources say weak light makes it leggy.',
        'Humidity is not a worry. The RHS says most pileas, this one included, cope with ordinary home air, and NC State says it does best in moderate to high humidity but tolerates the average home. Keep it away from cold drafts and heat sources, and above 50°F.',
      ],
      problems: [
        'Root rot from overwatering is the main disease both sources name. Let the top of the mix dry before watering again, and use a pot only slightly larger than the roots.',
        'The RHS reads the leaves: red-brown patches usually mean too much direct sun, yellowing between the veins usually means a nutrient shortage, and curling or puckered leaves point to a water or light problem.',
        'Pests to check for are mealybugs, spider mites, scale insects and thrips, which the RHS names, plus the fungus gnats NC State adds.',
      ],
      propagation: [
        'The RHS says Pilea peperomioides makes offsets, small baby plants, around its base. Once one is big enough, separate it and pot it on its own. NC State lists offsets and stem cuttings, and says spring or early summer, while the plant is growing, is the time to do it.',
        'The RHS also lists stem cuttings, division and leaf cuttings, but the offsets are the simplest route.',
      ],
      sharedCare: [
        'In a shared household, a Chinese money plant needs one rule everyone follows: check the mix before watering, because the way it dies is two people each giving it a drink.',
        'The offsets make a good household project. Once they are big enough, pot them up and give one to each person, so everyone has their own plant to water.',
      ],
      honestBit: [
        'My take: this is the easiest plant here to share, literally. A healthy one keeps making babies, and a pot of offsets is a better gift than anything from a store.',
        'On pets we don’t give a verdict for this one. The ASPCA lists several other Pilea species, but it has no entry for Pilea peperomioides, and a relative’s verdict does not carry over. If you have a pet that chews, keep it out of reach, or pick a plant with a cited answer from the [free pet-safe checker](/pet-safe).',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a Chinese money plant?',
        a: 'When the top of the mix starts to dry, checked with a finger or by the weight of the pot, and less in winter. No source gives a fixed number of days, and overwatering is the main risk.',
      },
      {
        q: 'Why is my Chinese money plant leggy?',
        a: 'Not enough light. Both sources say weak light makes it stretch, so move it to a brighter spot out of strong direct sun.',
      },
      {
        q: 'How do I propagate a Chinese money plant?',
        a: 'Separate the offsets that grow around its base once they are big enough, and pot each one on its own. Spring or early summer is the time to do it.',
      },
    ],
    careSources: [
      {
        publisher: 'RHS',
        title: 'How to grow pilea',
        url: 'https://www.rhs.org.uk/plants/pilea/how-to-grow-pilea',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Pilea peperomioides (Chinese Money Plant)',
        url: 'https://plants.ces.ncsu.edu/plants/pilea-peperomioides/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'peperomia',
    commonName: 'Peperomia',
    scientificName: 'Peperomia obtusifolia',
    alsoKnownAs: ['Baby Rubber Plant', 'American Rubber Plant', 'Pepper Face'],
    related: ['chinese-money-plant', 'string-of-pearls', 'hoya'],
    metaTitle: 'How Often to Water a Peperomia: Let It Dry Out First',
    metaDescription:
      'Let a peperomia dry out between waterings, because overwatering yellows the leaves and rots the roots. It wants bright, indirect light and tolerates low light.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'This guide covers Peperomia obtusifolia, the baby rubber plant: a compact, bushy plant with thick, glossy, rounded leaves. Other peperomias have their own care and their own listings. The ASPCA lists the baby rubber plant as non-toxic to cats and dogs.',
    quickFacts: {
      water: 'Let it dry out between waterings; never soggy',
      light: 'Bright, indirect light; tolerates low light for months',
      difficulty: 'Easy',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'Medium to low humidity; a winter humidifier helps',
    },
    sections: {
      watering: [
        'Let a peperomia dry out between waterings, then water and let the pot drain before it goes back on its saucer. Neither extension source gives a number of days. Clemson Cooperative Extension says it prefers to dry out between drinks, and North Carolina State Extension says it dislikes both wet soil and very dry soil, so dry does not mean bone dry for weeks.',
        'Overwatering is the usual way people lose one. NC State calls it “a big problem” that yellows the leaves and can rot the roots, and Clemson says it makes the leaves drop and that root rot is the most common disease. Water the soil rather than the plant: Clemson says keeping the leaves dry helps prevent fungal leaf spots.',
      ],
      light: [
        'Bright, indirect light is best. Clemson suggests a spot near an east- or south-facing window, and says it can manage fairly low light near a large north-facing one. NC State says it tolerates low light for several months, especially the plain green kinds, and both sources say strong direct sun burns the leaves.',
        'NC State lists medium to low humidity, and Clemson recommends a humidifier in winter. NC State also says it does not tolerate very drafty spots.',
      ],
      problems: [
        'Yellow leaves and rotting roots mean too much water, so let the soil dry before the next drink and make sure the pot drains. Clemson says dropped leaves can mean the same thing.',
        'Pests to watch for are mealybugs, spider mites and whiteflies, plus fungus gnats and scale, which Clemson adds. NC State says it has no serious pest or disease problems beyond overwatering.',
        'It does not need repotting every year. Clemson says it can stay in the same pot for several years, in a well-drained houseplant or cactus mix.',
      ],
      propagation: [
        'Both sources list stem and leaf cuttings. Clemson says to take a stem piece 3 to 5 inches long, strip the lower leaves, and root it in soil or a rooting mix under clear plastic, out of direct sun. For a leaf cutting, use a leaf with at least an inch of stalk; the new plant forms at its base.',
        'Clemson adds that the baby rubber plant roots well in water. Take a 4 to 6 inch cutting just below a node and keep it in bright, indirect light until roots and new leaves appear.',
      ],
      sharedCare: [
        'In a shared household, a peperomia does best with one waterer, because its main danger is too much water and a second person “just topping it up” is how it gets it.',
        'NC State notes it is commonly grown as a desk plant, which puts it where everyone sees it. Agree on the rule: soil dry, then water, then drain.',
      ],
      honestBit: [
        'My take: peperomia is the plant to give someone who overwaters everything. It forgives a forgotten week and shows a soggy one plainly, in yellow leaves.',
        'The ASPCA lists the baby rubber plant (Peperomia obtusifolia) as non-toxic to cats and dogs. The listing names this one species, so a different peperomia needs its own check. Non-toxic is not the same as safe to eat in quantity, so if a pet eats a lot and seems unwell, call your vet. The [pet-safety page for peperomia](/pet-safe/peperomia) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a peperomia?',
        a: 'Once the soil has dried, not on a set number of days, and then let the pot drain. Overwatering is the common mistake: it yellows the leaves and rots the roots.',
      },
      {
        q: 'Why are my peperomia’s leaves turning yellow or falling off?',
        a: 'Usually too much water. North Carolina State Extension says overwatering yellows the leaves and leads to root rot, and Clemson Cooperative Extension says it makes them drop.',
      },
      {
        q: 'Which peperomia does this guide cover?',
        a: 'Peperomia obtusifolia, the baby rubber plant, the species that both the main care source and the ASPCA listing cover. Other peperomias, such as the watermelon peperomia, have their own care and their own listings.',
      },
    ],
    careSources: [
      {
        publisher: 'North Carolina State Extension',
        title: 'Peperomia obtusifolia (Baby Rubber Plant)',
        url: 'https://plants.ces.ncsu.edu/plants/peperomia-obtusifolia/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Peperomia (Peperomia spp.) Indoor Plant Care and Growing Guide',
        url: 'https://hgic.clemson.edu/factsheet/peperomia-peperomia-spp-indoor-plant-care-and-growing-guide/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'alocasia',
    commonName: 'Alocasia',
    scientificName: 'Alocasia',
    alsoKnownAs: ['Elephant Ear', 'Elephant’s-Ear'],
    related: ['monstera', 'calathea', 'prayer-plant'],
    metaTitle: 'How Often to Water an Alocasia: When the Top 2 in. Is Dry',
    metaDescription:
      'Water an alocasia once the top 2 inches of mix are dry from spring to fall, and keep it nearly dry in winter, when it rests. Bright, indirect light, humid air.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'Alocasia is grown for its big, dramatic leaves. It wants warmth, humid air and bright, indirect light, and it rests in winter, when it needs very little water. The ASPCA lists it as toxic to cats and dogs.',
    quickFacts: {
      water: 'When the top 2 inches are dry; very little in winter',
      light: 'Bright, indirect light; strong sun scorches the leaves',
      difficulty: 'Hard',
      toxicity: 'Toxic to cats and dogs (per the ASPCA); insoluble calcium oxalates',
      humidity: 'Medium to high humidity; dry air browns the edges',
    },
    sections: {
      watering: [
        'From spring to fall, water an alocasia once the top 2 inches of mix are dry. That depth comes from the RHS, which gives April to October as the season for it, and no source gives a number of days. The RHS also suggests giving the pot a slight turn at each watering so the plant does not lean toward the light.',
        'In winter it rests. The RHS says to cut watering to a minimum and keep it cooler and drier, and that losing a leaf or two then is normal. North Carolina State Extension also says to reduce watering in winter, and that overwatering causes root rot and leaf spots.',
      ],
      light: [
        'Bright, indirect light suits it indoors. The RHS says strong sun scorches the leaves and low light slows growth. NC State’s page is mostly about growing it outdoors, where it prefers a shaded site.',
        'Humidity is the other half of its care. The RHS gives medium to high, and suggests a pebble tray, grouping plants together, misting, a bathroom or a humidifier. Keep it above 60°F while it grows and above 50°F in winter, out of cold drafts.',
      ],
      problems: [
        'Brown, crisp leaf edges usually mean the air is too dry, the RHS says, and dry air also invites spider mites, which NC State calls common. NC State adds aphids and mealybugs to watch for.',
        'Yellow leaves have more than one cause. NC State says they can come from too much water, too little water or too little light, so check the soil and the spot before changing anything.',
        'Rotting roots and spotted leaves point to overwatering, especially in winter, when a resting plant sits in wet mix.',
      ],
      propagation: [
        'Both sources say to separate the offsets. The RHS says to do it in spring and pot them in a gritty, peat-free mix, or to divide the rhizome in late spring or early summer. NC State lists dividing offsets as the recommended method.',
        'Wear gloves while you do it. The RHS says the sap can irritate skin, and NC State says contact can cause dermatitis.',
      ],
      sharedCare: [
        'In a shared household, an alocasia needs everyone to know its winter rule, because it needs far less water while it rests and a well-meaning extra drink then is how the roots rot.',
        'Because the ASPCA lists it as toxic to cats and dogs, keep it where pets cannot chew the leaves, and pick up any leaf that drops.',
      ],
      honestBit: [
        'My take: alocasia is a plant you keep for the leaves and forgive for the drama. A leaf lost in winter is part of the deal, not a sign you failed.',
        'The ASPCA lists alocasia (Alocasia spp.) as toxic to cats and dogs. It names insoluble calcium oxalates, and lists oral irritation, pain and swelling of the mouth, tongue and lips, excessive drooling, vomiting and difficulty swallowing. If your pet has chewed it, call your vet or a poison hotline. The [pet-safety page for alocasia](/pet-safe/alocasia) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an alocasia?',
        a: 'From spring to fall, once the top 2 inches of mix are dry; in winter, very little. The RHS gives that depth, and no source gives a fixed number of days.',
      },
      {
        q: 'Why is my alocasia losing leaves in winter?',
        a: 'It is resting. The RHS says losing some leaves in winter is normal. Water very little until spring, and keep it above 50°F.',
      },
      {
        q: 'Why are my alocasia’s leaf edges turning brown?',
        a: 'Dry air is the usual cause, according to the RHS. Raise the humidity with a pebble tray, by grouping plants or with a humidifier, and check for spider mites.',
      },
    ],
    careSources: [
      {
        publisher: 'RHS',
        title: 'How to grow alocasias',
        url: 'https://www.rhs.org.uk/plants/alocasia/growing-guide',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Alocasia (Elephant’s-Ear)',
        url: 'https://plants.ces.ncsu.edu/plants/alocasia/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'cast-iron-plant',
    commonName: 'Cast Iron Plant',
    scientificName: 'Aspidistra elatior',
    alsoKnownAs: ['Aspidistra', 'Bar Room Plant', 'Iron Plant'],
    related: ['zz-plant', 'snake-plant', 'corn-plant'],
    metaTitle: 'How Often to Water a Cast Iron Plant: When It Is Dry',
    metaDescription:
      'Water a cast iron plant when the soil is dry 2 to 3 inches down, and less in winter. It takes low light and shade, but not direct sun. Pet-safe per the ASPCA.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The cast iron plant lives up to its name: it takes deep shade, dry soil and poor soil that would finish most houseplants. It grows in upright clumps of dark green leaves, and the one thing it will not take is direct sun. The ASPCA lists it as non-toxic to cats and dogs.',
    quickFacts: {
      water: 'When the soil is dry 2 to 3 inches down; less in winter',
      light: 'Low light to shade; no direct sun',
      difficulty: 'Very easy',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA) — pet-safe',
      humidity: 'Not covered by the extension sources',
    },
    sections: {
      watering: [
        'Water a cast iron plant once the soil is dry 2 to 3 inches down, which is the depth Clemson Cooperative Extension gives. No source gives a number of days. Let the pot drain, and do not leave water standing in the saucer.',
        'North Carolina State Extension says to water regularly from spring to fall and sparingly in winter, and calls the plant drought tolerant. A missed week does far less harm than a waterlogged pot: Clemson says it dislikes wet conditions.',
      ],
      light: [
        'Low light is where it belongs. Clemson suggests a north-facing window or a low-light spot away from south-facing windows, and NC State says it prefers partial to full shade, suits deep shade and does not tolerate direct sun. It flowers only in brighter light, and the flowers are small and sit close to the soil.',
        'Neither extension source mentions humidity, so this guide gives no figure for it. Use a well-drained potting mix.',
      ],
      problems: [
        'Scorched leaves mean too much sun, Clemson says. Move it farther from the window.',
        'Clemson suggests checking the leaves weekly for mites and scale. NC State says it has no serious pest problems.',
        'Wet soil is the other risk; NC State says it tolerates dry, poor soil. Remove tired, weathered leaves one at a time at soil level, Clemson says, or cut the whole clump back every two to three years in late winter, and new leaves come back in spring.',
      ],
      propagation: [
        'Divide it. Clemson says to split the clump in spring or early summer while it is growing, making sure each division has two or more leaves.',
        'NC State says it spreads by rhizomes, which is how an older plant fills its pot. Feed in spring and summer with an all-purpose houseplant fertilizer, as Clemson advises.',
      ],
      sharedCare: [
        'In a shared household, a cast iron plant is the one for the hallway or the dim corner nobody else can fill, because it asks for almost nothing.',
        'The only house rule it needs is not to overdo the water: check that the soil is dry a few inches down before anyone waters it, and empty the saucer.',
      ],
      honestBit: [
        'My take: if your home has more shade than windows, this is the plant. It is not showy, but it is the one most likely to still be in that dark corner years from now.',
        'The ASPCA lists the cast iron plant (Aspidistra elatior) as non-toxic to cats and dogs. Non-toxic is not the same as safe to eat in quantity, so if a pet eats a lot and seems unwell, call your vet. The [pet-safety page for cast iron plant](/pet-safe/cast-iron-plant) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a cast iron plant?',
        a: 'When the soil is dry 2 to 3 inches down, and less in winter. Clemson Cooperative Extension gives that depth, and no source gives a fixed number of days. It is drought tolerant, so when in doubt, wait.',
      },
      {
        q: 'Can a cast iron plant live in a dark room?',
        a: 'It handles low light well. North Carolina State Extension says it suits deep shade, and Clemson suggests a north window or a low-light spot. What it does not tolerate is direct sun.',
      },
      {
        q: 'How do I divide a cast iron plant?',
        a: 'In spring or early summer, while it is growing, split the clump so each division keeps two or more leaves, then pot the pieces in a well-drained mix.',
      },
    ],
    careSources: [
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Cast Iron Plant',
        url: 'https://hgic.clemson.edu/cast-iron-plant/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Aspidistra elatior (Cast Iron Plant)',
        url: 'https://plants.ces.ncsu.edu/plants/aspidistra-elatior/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'corn-plant',
    commonName: 'Corn Plant',
    scientificName: 'Dracaena fragrans',
    alsoKnownAs: ['Dracaena Massangeana', 'Cornstalk Plant'],
    related: ['cast-iron-plant', 'croton', 'snake-plant'],
    metaTitle: 'How Often to Water a Corn Plant (Dracaena Fragrans)',
    metaDescription:
      'Water a corn plant thoroughly once the soil surface is dry, and less in winter. Bright to moderate filtered light. Brown tips usually mean dry air.',
    reviewed: '2026-11-03',
    updated: '2026-11-03',
    summary:
      'The corn plant, Dracaena fragrans, has long, arching leaves like a corn stalk’s, often with a wide yellow stripe down the middle in the common Massangeana form. It grows slowly, wants filtered light, and takes a thorough drink once the surface dries. The ASPCA lists it as toxic to cats and dogs.',
    quickFacts: {
      water: 'When the surface is dry, then water thoroughly',
      light: 'Bright to moderate filtered light; no direct sun',
      difficulty: 'Easy',
      toxicity: 'Toxic to cats and dogs (per the ASPCA); saponins',
      humidity: 'Low humidity browns the tips; mist or use a humidifier',
    },
    sections: {
      watering: [
        'Water a corn plant thoroughly once the surface of the soil feels dry, then let it drain. That is Clemson Cooperative Extension’s advice for dracaenas, and neither source gives a number of days. Clemson also says to let it dry partway between waterings and to avoid cold water, so use water at room temperature.',
        'North Carolina State Extension says to keep the soil moist while it grows, to water less in winter, and to use a pot with drainage holes. Clemson says soil that drains slowly can cause root rot, and names too much or too little water as a main problem.',
      ],
      light: [
        'Give it bright to moderate, filtered light. NC State says direct sun can burn the leaves and that too little light makes them narrow. Clemson says most dracaenas tolerate lower light, and that moving one into brighter light gives thicker, stronger new leaves.',
        'Keep it warm: NC State says it thrives at about 70 to 80°F and should stay above 50°F if possible. Dry indoor air browns the tips. Clemson recommends misting the leaves now and then when indoor humidity drops below 30 to 40 percent, as it often does in winter, and NC State says a humidifier may help.',
      ],
      problems: [
        'Brown, dry leaf tips and edges usually mean too little humidity, Clemson says. Yellow or burned leaf edges often come from over-fertilizing or fluoride. NC State says the plant is sensitive to fluoride and salt buildup, and recommends non-fluoridated water and flushing the salts out of the soil monthly.',
        'Sudden leaf loss can follow a temperature change, a draft, overwatering, poor drainage or a heavy insect infestation, according to Clemson. The pests to check for are scale and mites, which Clemson names, and the thrips and mealybugs NC State names.',
        'Round, dry patches or streaks on the leaves can come from too much sun, Clemson says, so move it out of direct light.',
      ],
      propagation: [
        'NC State lists stem cuttings. Clemson adds tip cuttings, air layering, and rooted shoots taken from the base in spring or late summer.',
        'If a stem has grown long and bare, Clemson says you can cut it back to the height you want, and new leaves will follow. The top you cut off can become your cutting.',
      ],
      sharedCare: [
        'In a shared household, a corn plant needs one person who knows its two quirks, room-temperature water and humid air, because everyone else will water it straight from the cold tap.',
        'Because the ASPCA lists it as toxic to cats and dogs, keep it where pets cannot chew the leaves. A tall plant standing on the floor puts its lower leaves at pet height.',
      ],
      honestBit: [
        'My take: judge a corn plant by its new leaves, not its old tips. A browned tip will not turn green again, so whether the humidity and water are right shows in what grows next.',
        'The ASPCA lists the corn plant (Dracaena fragrans) as toxic to cats and dogs. It names saponins, and lists vomiting (occasionally with blood), depression, loss of appetite and drooling, plus dilated pupils in cats. If your pet has eaten some, call your vet or a poison hotline. The [pet-safety page for corn plant](/pet-safe/corn-plant) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a corn plant?',
        a: 'Thoroughly, once the surface of the soil is dry, and less in winter. Clemson Cooperative Extension gives that rule for dracaenas, and neither source gives a fixed number of days.',
      },
      {
        q: 'Why does my corn plant have brown tips?',
        a: 'Usually dry air. Clemson Cooperative Extension says brown, dry tips and edges usually mean too little humidity. Fluoride and salt buildup in the soil can also burn the leaves, according to North Carolina State Extension.',
      },
      {
        q: 'How much light does a corn plant need?',
        a: 'Bright to moderate, filtered light, out of direct sun, which can burn the leaves. Too little light makes the new leaves narrow.',
      },
    ],
    careSources: [
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Dracaena',
        url: 'https://hgic.clemson.edu/factsheet/dracaena/',
        accessed: '2026-11-03',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Dracaena fragrans (Corn Plant)',
        url: 'https://plants.ces.ncsu.edu/plants/dracaena-fragrans/',
        accessed: '2026-11-03',
      },
    ],
  },
  {
    slug: 'amaryllis',
    commonName: 'Amaryllis',
    scientificName: 'Hippeastrum',
    alsoKnownAs: ['Hippeastrum', 'Dutch Amaryllis', 'Barbados Lily'],
    related: ['poinsettia', 'cyclamen', 'christmas-cactus'],
    metaTitle: 'How Often to Water an Amaryllis: When the Soil Is Dry',
    metaDescription:
      'Water an amaryllis when the soil surface feels dry, and never leave it in a full saucer. Give it direct sun, then rest the bulb so it blooms again.',
    reviewed: '2026-11-04',
    updated: '2026-11-04',
    summary:
      'An amaryllis is a large tropical bulb, Hippeastrum, sold in the fall to bloom indoors for the holidays. It wants a sunny window, a pot that drains, and water only once the surface dries, and after it blooms it can be kept and flowered again. The ASPCA lists it as toxic to cats and dogs.',
    quickFacts: {
      water: 'When the soil surface feels dry; empty the saucer',
      light: 'At least 4 hours of direct sun; a south window is best',
      difficulty: 'Easy to bloom; reblooming needs a rest',
      toxicity: 'Toxic to cats and dogs (per the ASPCA); bulb is worst',
      humidity: 'No figure in the sources; keep it off heaters and vents',
    },
    sections: {
      watering: [
        'Water an amaryllis when the surface of the soil feels dry to the touch. That is Clemson Cooperative Extension’s rule, and it says to water thoroughly, let the pot drain, and never leave it sitting in a saucer of water. Once it starts to flower, Clemson says it needs water more often, about once or twice a week, but the dry surface is still the check.',
        'A newly potted bulb needs very little. Clemson says to water it thoroughly once, wait a week, and then keep the soil only slightly moist. UF/IFAS Gardening Solutions goes further and says no more water should be needed until the bulb sprouts. Both warn against soggy soil, and Clemson says bulb and root rot usually start when the soil is kept too wet.',
      ],
      light: [
        'Give it the sunniest window you have. Clemson says an amaryllis grows best with at least four hours of direct sun a day, with a south window best and an east or west window second. Turn the pot every few days so the flower stalk grows straight instead of leaning toward the glass.',
        'Warmth gets it going and coolness makes the flowers last. Clemson says 70 to 75°F suits it until the roots, leaves and stalk start growing, and that about 65°F once it blooms prolongs the flowers. UF/IFAS adds that moving it out of direct sun once the flowers open helps them last. Keep a blooming plant away from heaters and air vents.',
      ],
      problems: [
        'A soft bulb or rotting roots usually means the soil stayed too wet or the bulb was bruised when it was planted, according to Clemson. Its advice is to throw out a diseased bulb and replace the potting soil rather than try to save it.',
        'Reddish brown spots on the bulb, leaves or flower stalk are likely red blotch, a fungal disease that Clemson says can spread quickly. Planting with a third to a half of the bulb above the soil keeps its top dry and helps prevent it. Light yellow streaks on the leaves can mean mosaic virus, which cannot be cured.',
        'A tall stalk gets top-heavy and can bend. Clemson suggests staking it, and if it bends too far, cutting it and putting it in a vase, where the flowers keep opening. The pests it names are scale, mites, thrips, bulb maggots and mealybugs.',
      ],
      propagation: [
        'NC State Extension lists division and seed. The easier way to get more flowers is to keep the bulb you have: Clemson says the secret is to keep the plant growing after it blooms, in a sunny window with slightly moist soil and regular feeding, so the bulb builds up for next year.',
        'To flower it again, Clemson says to stop watering and feeding for 8 to 10 weeks and let the leaves yellow and wither. NC State says to rest it somewhere cool (50 to 55°F) and fairly dark during that time. When the tip of a new flower bud shows, bring it back to a sunny spot and start watering again.',
      ],
      sharedCare: [
        'An amaryllis is often a gift for the whole house, and the one thing everyone needs to know is to check the soil before watering, because a bulb watered by three people in one week is a bulb that rots.',
        'Because the ASPCA lists it as toxic to cats and dogs, and says the bulb is the most poisonous part, keep the pot where pets cannot dig in it or chew the leaves.',
      ],
      honestBit: [
        'My take: the amaryllis is the most generous of the holiday plants. The first bloom runs on energy already stored in the bulb, so the main way to lose it is a pot kept wet. Save your effort for after the flowers, when keeping the leaves growing is what earns a second year.',
        'The ASPCA lists amaryllis (its “Barbados Lily” listing, Hippeastrum) as toxic to cats and dogs. It names lycorine and other alkaloids, lists vomiting, drooling and diarrhea, and says the bulbs are the most poisonous part. If your pet has eaten some, call your vet or a poison hotline. The [pet-safety page for amaryllis](/pet-safe/amaryllis) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water an amaryllis?',
        a: 'When the surface of the soil feels dry to the touch. Water thoroughly, let it drain, and empty the saucer. Clemson Cooperative Extension says a blooming plant wants water more often, about once or twice a week, so check the soil rather than the calendar.',
      },
      {
        q: 'How do I get my amaryllis to bloom again?',
        a: 'Keep it growing in a sunny window after the flowers fade, then rest the bulb. Clemson Cooperative Extension says to stop watering and feeding for 8 to 10 weeks until the leaves wither, and to start again when a new flower bud appears.',
      },
      {
        q: 'How long does an amaryllis take to bloom?',
        a: 'Clemson Cooperative Extension says to expect flowers 4 to 8 weeks after planting in early to mid-November, and UF/IFAS Gardening Solutions says six to eight weeks. Bigger bulbs give bigger flowers and more stalks.',
      },
    ],
    careSources: [
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Amaryllis',
        url: 'https://hgic.clemson.edu/factsheet/amaryllis/',
        accessed: '2026-11-04',
      },
      {
        publisher: 'UF/IFAS Gardening Solutions',
        title: 'Amaryllis',
        url: 'https://gardeningsolutions.ifas.ufl.edu/plants/ornamentals/amaryllis/',
        accessed: '2026-11-04',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Hippeastrum (Amaryllis)',
        url: 'https://plants.ces.ncsu.edu/plants/hippeastrum/',
        accessed: '2026-11-04',
      },
    ],
  },
  {
    slug: 'norfolk-island-pine',
    commonName: 'Norfolk Island Pine',
    scientificName: 'Araucaria heterophylla',
    alsoKnownAs: ['Norfolk Pine', 'House Pine'],
    related: ['poinsettia', 'amaryllis', 'parlor-palm'],
    metaTitle: 'How Often to Water a Norfolk Island Pine: When Dry',
    metaDescription:
      'Water a Norfolk Island pine thoroughly when the soil surface is dry, then drain it. It needs bright light and help with dry winter air.',
    reviewed: '2026-11-04',
    updated: '2026-11-04',
    summary:
      'A Norfolk Island pine is not a true pine but a slow-growing tropical conifer, often sold at the holidays as a small living Christmas tree. It needs a bright window, a thorough drink once the surface dries, and help with dry winter air. The ASPCA lists it as non-toxic to cats and dogs.',
    quickFacts: {
      water: 'When the surface is dry; water thoroughly',
      light: 'Bright light near an east, west or south window',
      difficulty: 'Easy, if the light is bright enough',
      toxicity: 'Non-toxic to cats and dogs (per the ASPCA)',
      humidity: 'Dry winter air browns tips; use a pebble tray',
    },
    sections: {
      watering: [
        'Water a Norfolk Island pine thoroughly once the surface of the soil is dry to the touch, then pour away the water that drains into the saucer. Iowa State University Extension and Outreach gives that rule, and none of the sources gives a number of days.',
        'Water less in winter. North Carolina State Extension says to water regularly from spring to autumn while avoiding soil that is too wet, and to water sparingly in winter. UF/IFAS Gardening Solutions says these trees do not like being too wet, and that more water is not the way to give them the humidity they want.',
      ],
      light: [
        'Bright light matters most. Iowa State says to place it near an east, west or south window and to turn it weekly so it does not grow lopsided toward the light. UF/IFAS says that if one is not thriving, the likely cause is too little light or humidity. NC State says full sun gives the most compact growth, with light afternoon shade if the needles start to bleach yellow.',
        'Keep it cool to moderate: Iowa State gives 55 to 70°F, and NC State says a bright, cool room of 55 to 65°F. The sources disagree on humidity. Iowa State and UF/IFAS say it wants humid air and suggest a humidifier or a pebble tray, a saucer of gravel and water with the pot sitting above the water. NC State says it usually adapts to the dry air of homes and offices, and suggests misting in heated rooms in winter.',
      ],
      problems: [
        'Brown branch tips and lower branches falling off are the classic complaint. Iowa State names three causes: low humidity, too little light, and soil that gets too dry. Winter is the hard season, because heated homes have dry air.',
        'NC State says a tree kept in very low light can hang on for two or three years and then start dropping leaves and losing its lower branches, so a slow decline in a dim corner is a light problem, not a watering one. The pests and diseases it lists are scale, sooty mold and leaf spot.',
      ],
      propagation: [
        'NC State lists seed as the way this tree is propagated. None of the sources describes rooting a cutting, so this guide does not suggest one.',
        'It grows slowly, so the tree you have can stay a houseplant for years: UF/IFAS says a potted one may reach 5 to 8 feet after about a decade indoors.',
      ],
      sharedCare: [
        'In a shared household, a Norfolk Island pine needs one person to turn it and check the soil, because a tree that everyone admired in December is easy for everyone to forget by February.',
        'Iowa State notes that many people decorate one as a living Christmas tree. If yours is, decide who takes the decorations off after the holidays, so it can go back to its bright window.',
      ],
      honestBit: [
        'My take: a Norfolk Island pine is a houseplant first and a Christmas tree second. Treat it as a tree for one month and a bright-window plant for the other eleven, and it will outlast a lot of holidays.',
        'The ASPCA lists the Norfolk Island pine (under “Australian Pine”, Araucaria heterophylla) as non-toxic to cats and dogs. Non-toxic is not the same as safe to eat in quantity, so if a pet eats a lot and seems unwell, call your vet. The [pet-safety page for Norfolk Island pine](/pet-safe/norfolk-island-pine) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a Norfolk Island pine?',
        a: 'Thoroughly, once the surface of the soil is dry to the touch, and less in winter. Pour away the water that drains into the saucer. Iowa State University Extension and Outreach gives that rule, and none of the sources gives a fixed number of days.',
      },
      {
        q: 'Why is my Norfolk Island pine losing its lower branches?',
        a: 'Usually low humidity, too little light or soil that got too dry. Iowa State University Extension and Outreach names all three for brown tips and lost lower branches, and North Carolina State Extension says a tree kept in very low light for a few years starts losing them.',
      },
      {
        q: 'How much light does a Norfolk Island pine need?',
        a: 'Bright light, near an east, west or south window, turned weekly so it grows straight. North Carolina State Extension says full sun gives the most compact growth.',
      },
    ],
    careSources: [
      {
        publisher: 'Iowa State University Extension and Outreach',
        title: 'How do I care for a Norfolk Island Pine?',
        url: 'https://yardandgarden.extension.iastate.edu/faq/how-do-i-care-norfolk-island-pine',
        accessed: '2026-11-04',
      },
      {
        publisher: 'UF/IFAS Gardening Solutions',
        title: 'Norfolk Island Pine',
        url: 'https://gardeningsolutions.ifas.ufl.edu/plants/trees-and-shrubs/trees/norfolk-island-pine/',
        accessed: '2026-11-04',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Araucaria heterophylla (Norfolk Island Pine)',
        url: 'https://plants.ces.ncsu.edu/plants/araucaria-heterophylla/',
        accessed: '2026-11-04',
      },
    ],
  },
  {
    slug: 'cyclamen',
    commonName: 'Cyclamen',
    scientificName: 'Cyclamen persicum',
    alsoKnownAs: ['Florist’s Cyclamen', 'Persian Cyclamen'],
    related: ['african-violet', 'kalanchoe', 'amaryllis'],
    metaTitle: 'How Often to Water a Cyclamen: When the Surface Is Dry',
    metaDescription:
      'Water a cyclamen when the soil surface is dry, at the edge of the pot or from below, never on the tuber. Keep it cool and bright to keep it blooming.',
    reviewed: '2026-11-04',
    updated: '2026-11-04',
    summary:
      'Florist’s cyclamen, Cyclamen persicum, flowers through the winter with swept-back petals over silver-marked, heart-shaped leaves. It wants a cool, bright room and soil that stays moist but never wet, and it goes dormant after flowering. The ASPCA lists it as toxic to cats and dogs.',
    quickFacts: {
      water: 'When the surface is dry; water at the pot’s edge',
      light: 'Bright, indirect light in a cool room',
      difficulty: 'Moderate: easy in bloom, hard to rebloom',
      toxicity: 'Toxic to cats and dogs (per the ASPCA); saponins',
      humidity: 'Moderate humidity; keep it away from heat vents',
    },
    sections: {
      watering: [
        'Check a cyclamen’s soil every day, and when the surface is dry to the touch, water thoroughly. If it is still moist, wait and check again the next day. That is Iowa State University Extension and Outreach’s advice: the plant likes moist soil but does not tolerate wet soil, and none of the sources gives a number of days.',
        'Water at the edge of the pot or from below, never onto the tuber in the middle. Clemson Cooperative Extension and Iowa State both say water on the crown can rot it. Iowa State recommends room-temperature water, and Clemson says a spot near a heat vent dries the soil out too quickly.',
      ],
      light: [
        'Give it bright, indirect light and a cool room. Iowa State says 50 to 60°F. Clemson says days of 60 to 65°F with nights around 50°F, and that above 70°F the buds fail to develop. A cool windowsill out of direct sun suits it better than a warm living room.',
        'North Carolina State Extension recommends moderate humidity. Keeping it cool and away from heaters is the part all three sources agree on.',
      ],
      problems: [
        'Yellowing leaves after flowering are usually the plant going dormant, not dying. Clemson says that in its Mediterranean home it rests after blooming, its leaves yellow and fall, and most people throw it out at this point.',
        'A rotting tuber comes from overwatering, NC State says. Aphids, mealybugs, spider mites and thrips can attack it, and Clemson says a plant with cyclamen mites is best thrown away, because that pest is hard to control.',
        'To keep it flowering, remove spent flowers. Clemson says to grasp the old flower stem and pull it off completely at the crown.',
      ],
      propagation: [
        'Clemson says both seed and division are difficult: seed is slow and erratic, and a cut tuber tends to dry out or rot, so it recommends buying new plants instead.',
        'Reblooming the same plant is possible but tricky. Iowa State says to cut back watering gradually as the leaves yellow, rest it in a cool, shaded spot for about six to eight weeks in late spring and early summer, and start watering again in mid-to-late summer. Clemson says to keep the soil from drying out completely while it rests, and to move it into bright light when new leaves appear in mid-September.',
      ],
      sharedCare: [
        'In a shared household, a cyclamen needs one person who waters it at the edge of the pot, because a well-meant glass of water poured over the middle is how the tuber rots.',
        'Because the ASPCA lists it as toxic to cats and dogs, set it somewhere the pets do not go, and keep the tuber out of reach if the plant is repotted or thrown out.',
      ],
      honestBit: [
        'My take: a cyclamen is the winter plant for a cold room. The chilly bedroom or entryway that other plants sulk in is what keeps it blooming, so put it there instead of the warm spot by the heater.',
        'The ASPCA lists cyclamen as toxic to cats and dogs. It names terpenoid saponins and lists drooling, vomiting and diarrhea, with heart rhythm problems and seizures after large amounts of the tuber. If your pet has eaten some, call your vet or a poison hotline. The [pet-safety page for cyclamen](/pet-safe/cyclamen) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a cyclamen?',
        a: 'Check the soil daily and water thoroughly when the surface is dry to the touch, at the edge of the pot or from below. If it is still moist, check again the next day. Iowa State University Extension and Outreach gives that rule, with no fixed number of days.',
      },
      {
        q: 'Why are my cyclamen’s leaves turning yellow?',
        a: 'After flowering, it is usually the plant going dormant: Clemson Cooperative Extension says cyclamen rest after they bloom, and the leaves yellow and fall. While it is still blooming, look at warmth and water first: above 70°F the buds fail, and soggy soil rots the tuber.',
      },
      {
        q: 'How do I keep a cyclamen blooming?',
        a: 'Keep it cool and bright, keep the soil moist but not wet, and pull off spent flowers at the crown. Iowa State University Extension and Outreach says cool temperatures and moist soil are the keys to a longer bloom.',
      },
    ],
    careSources: [
      {
        publisher: 'Iowa State University Extension and Outreach',
        title: 'All About Cyclamen',
        url: 'https://yardandgarden.extension.iastate.edu/how-to/all-about-cyclamen',
        accessed: '2026-11-04',
      },
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Florist Cyclamen',
        url: 'https://hgic.clemson.edu/factsheet/cyclamen/',
        accessed: '2026-11-04',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Cyclamen persicum (Florist’s Cyclamen)',
        url: 'https://plants.ces.ncsu.edu/plants/cyclamen-persicum/',
        accessed: '2026-11-04',
      },
    ],
  },
  {
    slug: 'kalanchoe',
    commonName: 'Kalanchoe',
    scientificName: 'Kalanchoe blossfeldiana',
    alsoKnownAs: ['Florist Kalanchoe', 'Christmas Kalanchoe', 'Flaming Katy'],
    related: ['christmas-cactus', 'jade-plant', 'norfolk-island-pine'],
    metaTitle: 'How Often to Water a Kalanchoe: Let the Soil Dry First',
    metaDescription:
      'Water a kalanchoe once the soil has dried, before it wilts, and never leave it standing in water. Bright light, and long fall nights to rebloom.',
    reviewed: '2026-11-04',
    updated: '2026-11-04',
    summary:
      'Kalanchoe, Kalanchoe blossfeldiana, is a flowering succulent with thick, scalloped leaves and clusters of small flowers in red, pink, orange, yellow or white. It takes very little care and rots if it is kept wet. The ASPCA lists it as toxic to cats and dogs.',
    quickFacts: {
      water: 'When the soil has dried, but before it wilts',
      light: 'Bright light; shade it from hot afternoon sun',
      difficulty: 'Easy; reblooming needs long fall nights',
      toxicity: 'Toxic to cats and dogs (per the ASPCA)',
      humidity: 'No figure in the sources; give it good air flow',
    },
    sections: {
      watering: [
        'Let a kalanchoe’s soil dry between waterings, but not so far that the plant wilts, then water it deeply. Iowa State University Extension and Outreach gives the first half of that rule and North Carolina State Extension the second. Clemson Cooperative Extension says overwatering damages it and to let the soil dry slightly between waterings. None of the three gives a number of days.',
        'Drainage matters as much as timing. Iowa State says never to let the pot sit in a sleeve full of water, and Clemson says root rot usually comes from a mix that drains slowly or from watering too often. NC State recommends a well-drained cactus or succulent mix.',
      ],
      light: [
        'Give it bright light. Clemson says it grows best in full sun and gets spindly in low light. NC State prefers bright, indirect light or partial shade, and says long direct sun can scorch the leaves, so afternoon shade is wise. A bright window with some shade from the hottest sun meets both.',
        'Cool nights make the flowers last. Iowa State and Clemson both give 45 to 65°F at night and 50 to 70°F during the day.',
      ],
      problems: [
        'Soft, rotting stems or roots mean it has been kept too wet. NC State says overwatering causes root and stem rot, so let it dry out and check that the pot drains.',
        'Mottled leaves with yellow spots or fine webbing can be powdery mildew, which Clemson says is hard to recognize on kalanchoe; good air flow around the plant helps prevent it. Mealybugs, aphids and brown scale are the most common pests, according to Clemson, and NC State adds spider mites.',
        'If it will not flower again, it has probably missed its long nights. NC State says a plant that fails to bloom may not have had the dark period it needs.',
      ],
      propagation: [
        'Stem cuttings root readily. Clemson says to take two- to three-inch tip cuttings from shoots that are not flowering, in spring or early summer, strip the bottom leaves, and let the cut end dry for several days before setting it in a mix of peat moss and perlite. Kept in bright, indirect light inside a closed plastic bag, cuttings should be ready to transplant in two to three weeks. NC State says leaf cuttings work too.',
        'Reblooming is a matter of darkness, as with the [Christmas cactus](/care/christmas-cactus). Iowa State says to move it in October to a room where the lights stay off at night, and that it needs six weeks of 14-hour nights to set buds. Clemson says that once the buds show above the leaves, the plant can go anywhere.',
      ],
      sharedCare: [
        'In a shared household, a kalanchoe needs a house rule more than a schedule: nobody waters it until the soil is dry. A succulent watered on everyone’s good intentions rots.',
        'If you want it to rebloom, the autumn rule is about the lights: whoever uses its room has to leave the lamp off at night for those six weeks. Because the ASPCA lists it as toxic to cats and dogs, pick a room where the pets cannot reach it, too.',
      ],
      honestBit: [
        'My take: kalanchoe is the low-effort holiday plant. It forgives a missed watering far more readily than an extra one, and Iowa State says it is fine to throw it out after it blooms if reblooming feels like too much work.',
        'The ASPCA lists kalanchoe (Kalanchoe species) as toxic to cats and dogs. It names bufadienolides and lists vomiting and diarrhea, with an abnormal heart rhythm in rare cases. If your pet has eaten some, call your vet or a poison hotline. The [pet-safety page for kalanchoe](/pet-safe/kalanchoe) shows the listing, and the [free pet-safe checker](/pet-safe) covers the rest of your plants.',
      ],
    },
    faqs: [
      {
        q: 'How often should I water a kalanchoe?',
        a: 'Once the soil has dried, but before the plant wilts, and then deeply. Never leave it standing in water. Iowa State University Extension and Outreach and Clemson Cooperative Extension give that rule, and none of the sources gives a fixed number of days.',
      },
      {
        q: 'How do I get my kalanchoe to bloom again?',
        a: 'Give it long nights. Iowa State University Extension and Outreach says to keep it from October in a room where the lights stay off at night, and that it needs six weeks of 14-hour nights to form buds.',
      },
      {
        q: 'How much light does a kalanchoe need?',
        a: 'Bright light. It gets spindly in low light, Clemson Cooperative Extension says, but North Carolina State Extension says long direct sun can scorch the leaves, so shade it from hot afternoon sun.',
      },
    ],
    careSources: [
      {
        publisher: 'Clemson Cooperative Extension',
        title: 'Kalanchoe',
        url: 'https://hgic.clemson.edu/factsheet/kalanchoe/',
        accessed: '2026-11-04',
      },
      {
        publisher: 'Iowa State University Extension and Outreach',
        title: 'How do I care for Kalanchoe?',
        url: 'https://yardandgarden.extension.iastate.edu/faq/how-do-i-care-kalanchoe',
        accessed: '2026-11-04',
      },
      {
        publisher: 'North Carolina State Extension',
        title: 'Kalanchoe blossfeldiana (Florist Kalanchoe)',
        url: 'https://plants.ces.ncsu.edu/plants/kalanchoe-blossfeldiana/',
        accessed: '2026-11-04',
      },
    ],
  },
];

export function findCareGuide(slug: string): CareGuide | undefined {
  return CARE_GUIDES.find((g) => g.slug === slug);
}

/** The guide's visible H1, which is also its Article `headline`. */
export function careGuideHeading(guide: CareGuide): string {
  return guide.heading ?? `${guide.commonName} care`;
}
