# Research synthesis

Real telemetry from the first users is the highest-value input the roadmap can get. This turns raw signup replies (the "what made you sign up?" email) into a prioritized, decision-ready summary — the highest-leverage use of Claude here, because it directly reorders the roadmap.

---

## The prompt

> Below are [N] replies from new users answering "What made you sign up, and what would make this a no-brainer for you?" Synthesize, don't summarize.
>
> 1. **Themes**, ranked by frequency — for each: the theme, how many users, and a representative verbatim quote.
> 2. **The job they're hiring us for** — in their words, not mine. Is it "remember to water" or "stop fighting with my partner about chores" or something I didn't expect?
> 3. **Friction**: where did people say (or imply) they almost didn't sign up / almost gave up.
> 4. **Feature requests vs. underlying needs** — separate the literal ask from the need behind it.
> 5. **The one thing** the data says I should build/fix next, and why — and the one thing on my roadmap this data suggests is _less_ important than I think.
> 6. **Quotes I could use** (with permission) as testimonials or landing-page copy.
>
> Be blunt. If the replies don't actually support a clear next step, say so rather than inventing one.
>
> REPLIES:
>
> ```
> [paste, one per line or separated by ---]
> ```

## How to use the output

- Item 5 feeds directly into the next sprint's priorities.
- Item 2 ("the job") may rewrite your landing-page headline — test it.
- Re-run this every ~25 new replies. The themes will shift as the user base grows; that shift is itself signal.
