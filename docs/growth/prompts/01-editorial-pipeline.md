# Editorial pipeline — the weekly long-form

Four prompts, run in order. Targets emotional/situational queries (the ICP who just killed a plant), not generic "how to care for X" (that's the species-page generator's job). ~3.5 human hours per article; the edit pass is where it earns its keep.

---

## Step 1 — Topic discovery

> Give me 20 long-tail search queries someone who has _just realized they forgot to water a plant_ (or whose plant is dying) would type into Google. I run a collaborative plant-care app for households, so I especially want queries with **emotional or situational** intent, and queries about **shared/household** plant care. Skip generic "how to care for [plant]" — those are handled elsewhere. For each, add a one-word intent tag (panic / guilt / logistics / relationship / comparison) and a rough monthly-volume guess (high / med / low). Rank by (intent strength × my ability to genuinely help).

Pick one. Favor high-intent over high-volume.

---

## Step 2 — Outline

> Outline a 1800–2200 word article for the search query **"[QUERY]"**.
> Context: it publishes on the blog of Family Greenhouse, a collaborative plant-care app for households (couples, roommates, families). Differentiator: the _right person reminded at the right time_, not a fancier plant database.
> Requirements: 6–7 H2 sections, a contrarian or counterintuitive angle in the first third, at least two specific examples using real plant names and real numbers (watering intervals, etc.), and one section that only makes sense for a _household_ (not a solo plant owner). End with a tight, non-salesy conclusion. NO filler sections ("introduction", "why this matters", "conclusion" as a heading). For each section, one line on what it argues.

Kill the generic sections. Add your own angle.

---

## Step 3 — Draft

> Write the full ~2000-word draft from the outline above.
> Voice: warm, practical, never preachy — "the friend who reminds you the plant is wilting, not the one lecturing about chlorophyll." First person ("I", "my") is good. Short paragraphs. Specific over abstract.
> Hard bans (AI tells): "in today's world", "embark on a journey", "unlock", "elevate", "dive into", "it's worth noting", "navigate the world of". Don't open three consecutive sentences with the same cadence. Don't end every section with a tidy summary line.
> Include one place marked `[ANECDOTE]` where I should drop a personal story, and one `[OPINION]` where I should add a real take.
> Output as TSX matching the existing blog posts: a default-export React component returning `<article className="prose-fg">` with `<h2>`/`<h3>`/`<p>` — see `frontend/src/features/blog/posts/remembering-to-water.tsx`. Use `&rsquo;` / `&ldquo;` / `&rdquo;` for punctuation.

---

## Step 4 — Edit (run on YOUR rewritten draft, not the raw one)

> Here's my edited draft. Be a skeptical editor:
>
> 1. Three specific things to cut (quote them).
> 2. One place the voice sounds fake or AI-generated (quote it, say why).
> 3. One section that's asserting without evidence — what concrete example would fix it.
> 4. Is the contrarian angle actually contrarian, or is it the obvious take dressed up?
> 5. The title and meta description: give me 3 options each, optimized for the target query, under 60 / 155 chars.
>    Don't rewrite it for me — tell me what to fix.

Then: write the `POSTS` entry (slug/title/description/date/readingMinutes) and add it to `frontend/src/features/blog/posts/index.ts`.
