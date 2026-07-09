# Growth prompt library

Reusable Claude prompts that execute the content engine in [`../../marketing-plan.md`](../../marketing-plan.md). Copy a prompt, fill the `[BRACKETS]`, run it, then do the 30% that makes it human.

These are Tier 1 (copy-paste). Tier 2 is the batch generator that runs the species-page prompt over the catalog and opens a review PR. The engine doc is not present yet, so document that path when the generator exists.

## The one rule

**Claude gets you 70% of the way; you do the 30% that makes it sound like a person.** Ship nothing that's 100% model output. The 30% is: the intro, the conclusion, one real opinion or anecdote, and cutting whatever feels generic. That ratio is the whole strategy — Claude-perfect content reads like every other AI blog and _ranks worse_ than human-edited content.

## Guardrails (every prompt assumes these)

1. **Ground facts; never free-write care advice.** Care pages are generated _from_ the species data you paste in, not from the model's memory. Wrong watering advice destroys trust and rankings. If a field is missing, omit that section — don't invent it.
2. **Brand voice** (from `docs/brand.md`): warm, practical, never preachy. The friend who reminds you the plant's wilting, not the one lecturing about chlorophyll. Light humor only at the edges, never in instructions a worried plant-owner is reading.
3. **No AI tells.** Banned: "in today's world", "embark on a journey", "unlock", "elevate", "dive into", "it's worth noting", "navigate the world of", em-dash-everything, the rule-of-three cadence on every sentence.
4. **Unique value per page.** Every page needs the angle no competitor has: the **collaborative-household hook** ("here's the cadence — and how to make sure _someone_ actually does it"). A page that's just reworded plant facts is a doorway page Google deindexes.
5. **Human-in-the-loop, in batches.** Approve 10–20 at a time. Reject thin ones; don't ship volume for its own sake.
6. **Publish in waves, watch Search Console.** 20 pages → confirm they index and quality signals hold → then scale.

## Files

| Prompt                     | Use for                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `01-editorial-pipeline.md` | The weekly long-form article (topic → outline → draft → edit) |
| `02-species-care-page.md`  | ⭐ Grounded programmatic care page — the scale lever          |
| `03-repurpose.md`          | Fan one article out to tweet / Reddit / email / cross-links   |
| `04-research-synthesis.md` | Turn signup-survey replies into a prioritized themes list     |

## A note on the model

Use a strong model (Opus/Sonnet) for drafting and editing — the quality gap shows up exactly in the "doesn't read as AI" dimension that matters here. A cheaper model is fine for mechanical repurposing (#03).
