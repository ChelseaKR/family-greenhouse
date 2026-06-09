# Species care page — the scale lever ⭐

Generates one grounded care page per species. Targets "how often to water [plant]", "[plant] care", "why is my [plant] dying". This is the prompt the **batch generator** runs over the catalog; it's also fine to run by hand.

The discipline that makes this work (and keeps Google happy): **the model writes prose, but every fact comes from the data you paste in.** Run it with real data from your catalog / Perenual — never let it recall watering numbers from memory.

---

## The prompt

> You are writing a care page for the houseplant below for Family Greenhouse, a collaborative plant-care app for households. Output a JSON object matching the `CareGuide` type at the end.
>
> **Grounding rule (non-negotiable):** every factual claim — watering interval, light, toxicity, difficulty, humidity, common problems — must come from the DATA block. If a field is absent, omit the section that needs it. Do **not** supply numbers or claims from your own knowledge. When unsure, write less.
>
> **Voice:** warm, practical, never preachy — the friend who reminds you the plant's wilting, not the one lecturing about chlorophyll. Plain words. Specific numbers from the data. Light humor only in the `honestBit`, never in the care instructions a worried owner is reading. Bans: "in today's world", "unlock", "elevate", "dive into", "lush green companion", "thrive in your space".
>
> **The differentiator you must weave in once, naturally:** this plant's care is easy to *know* and easy to *forget* — and in a shared home the failure mode is "I thought you watered it." One section (`sharedCare`) should address keeping the plant alive when more than one person lives there. Don't make it an ad; make it genuinely useful.
>
> **SEO:** the `faqs` (3–4) should answer the actual long-tail questions people type ("how often", "why yellow leaves", "is it toxic to cats", "how much light"). Keep each answer 1–3 sentences, grounded.
>
> DATA:
> ```
> commonName: [e.g. Pothos]
> alsoKnownAs: [Devil's Ivy, Epipremnum aureum]
> scientificName: [Epipremnum aureum]
> wateringIntervalDays: [e.g. 7-10]
> light: [e.g. bright indirect; tolerates low]
> difficulty: [e.g. very easy]
> toxicity: [e.g. toxic to cats and dogs if ingested]
> humidity: [average household is fine]
> commonProblems: [yellow leaves = overwatering; brown crispy tips = underwatering/low humidity; leggy = too little light]
> notes: [any extra grounded facts]
> ```
>
> Output ONLY this JSON (no prose around it):
> ```ts
> {
>   slug: string,            // kebab-case, e.g. "pothos"
>   commonName: string,
>   scientificName: string,
>   alsoKnownAs: string[],
>   metaTitle: string,       // <60 chars, includes the common name + "care"
>   metaDescription: string, // <155 chars, includes "how often to water"
>   summary: string,         // 1-2 sentence lead
>   quickFacts: {            // grounded, for the at-a-glance table
>     water: string, light: string, difficulty: string,
>     toxicity: string, humidity: string,
>   },
>   sections: {              // 2-4 short paragraphs each, markdown-free plain prose
>     watering: string,      // "how often to water" — the headline query
>     light: string,
>     problems: string,      // "why is my [plant] dying"
>     sharedCare: string,    // the household angle
>     honestBit: string,     // founder voice, one real opinion, light humor ok
>   },
>   faqs: { q: string, a: string }[],
> }
> ```

---

## After generation

- Paste the JSON into `frontend/src/features/care/careGuides.ts`.
- **Review for accuracy first** — spot-check the watering interval and toxicity against the source data. These are the two fields a wrong answer does real harm (a pet owner trusts the toxicity line).
- Rewrite `honestBit` in your own voice if it's bland — that's the section that signals a human wrote this.
- Confirm the page renders at `/care/[slug]` and the FAQ schema validates ([Rich Results Test](https://search.google.com/test/rich-results)).

## Picking which species to generate first

Order by **search volume**, not catalog order. The ~150 most-owned houseplants (pothos, snake plant, monstera, peace lily, ZZ, philodendron, fiddle leaf, spider, aloe, succulents…) are 90% of the traffic. Do those, confirm they index, then decide whether the long tail is worth it.
