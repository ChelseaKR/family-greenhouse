# Sprout integration

Family Greenhouse can route authenticated plant-care chat through the separate
Apache-2.0 [Sprout](https://github.com/ChelseaKR/sprout) service. This is a
first-party API integration, not a code or data merge.

## Privacy boundary

The backend sends only the user's question plus a server-verified canonical
species, a coarse light category, task type, and relative days due/completed.
The user-editable species field is never forwarded. Before transmission it
replaces known plant nicknames with the verified species (or “this plant” when
none is verified) and redacts common email and phone patterns. It never sends
stored notes, photos, household/member IDs, member records, free-form species or
locations, coordinates, or exact task timestamps. Sprout rejects unknown
payload fields and labels corpus answers and household observations separately.
As with any free-text field, users should not put sensitive personal
information in a chat question.

## The payload is a subset, and says so

What crosses is reduced twice: only plants with a **server-resolved canonical
species** are eligible (the user-editable species field never crosses, so a
plant that has never been matched is dropped outright), and what survives that
is then capped at `SPROUT_CONTEXT_CAP` (100) plants and 100 tasks.

Both reductions used to be invisible. The payload carried `plants` and `tasks`
and nothing else, so a household whose plants had never been species-matched
sent `plants: []` — indistinguishable, to the thing writing the answer, from a
household with no plants. Sprout's reply carries
`household_observations`: numeric claims about the user's own collection,
stamped `provenance: 'household'`. A subset was being reported as a total.

Every request now also carries `coverage`:

```jsonc
"coverage": {
  "plants": {
    "total": 150,      // everything the household has
    "included": 100,   // what actually crossed
    "unmatched": 30,   // dropped by the canonical-species filter
    "truncated": 20,   // dropped by the cap, after the filter
    "cap": 100,
    "complete": false  // included === total; the only honest bare count
  },
  "tasks": { /* same shape */ },
  "partial": true      // either set is a strict subset
}
```

These are **aggregate integers only**. No strings, so the privacy boundary
above is unchanged: `coverage` says how many plants did not cross, never
anything about them. `unmatched` and `truncated` stay separate because one is a
privacy control and the other is a size limit.

On the response side, Family Greenhouse attaches the coverage of the set an
observation was computed over to that observation, from **its own** count of
the household rather than from anything in the reply — so a reply cannot
overstate its own coverage. `provenance: 'household'` says where a number came
from; `coverage.complete` says how much of the household it covers.

## What the chat turn does with the reply

`askSprout` returns five fields. A turn read two of them — the prose and the
citations — and dropped `disclosure`, `observations` and `coverage` on the
floor, so the coverage work above was wired to nothing (#579). What happens to
each now:

- **`disclosure`** is shown to the user and persisted with the answer as a
  `disclosure` content block, so a reloaded transcript carries it too. Every
  word is Sprout's; Family Greenhouse writes none of it. The request now sends
  the language of the question (the rule `chat/blockCopy.ts` already uses for
  the block messages), so the disclosure arrives in the language the reader is
  having the conversation in. An empty disclosure — the schema permits one —
  renders nothing and logs `sprout_answer_without_disclosure` rather than
  passing for a delivered one.
- **`coverage`** is persisted as a `coverage` content block on the answer,
  whether or not it is partial, because the prose came from the same reduced
  set. That is what lets a stored answer still be qualified later; before it,
  the facts lived only for the lifetime of the function call. Aggregate
  integers only, so it crosses to the browser under the same contract it
  crossed to Sprout under. It is also what the answer is now CHECKED against —
  see the next section.
- **`observations`** are counted on the `chat.message_sent` audit line and are
  deliberately not persisted. Storing a household-scoped numerator for a later
  consumer to render without its denominator is the #549 defect pre-built, and
  what such a number may assert is the same open decision.

The audit line carries `observationCount`, `disclosed`, `coveragePartial` and
the plant/task included/total/unmatched/truncated integers, so "did this answer
come from a subset of the household?" is answerable in production without
waiting for any of that to be rendered.

Citation, disclosure and coverage blocks are Family Greenhouse display
metadata, not Anthropic content blocks: `chat/types.ts` lists them and
`toBedrockMessages` strips every one before a later Bedrock fallback replays
the conversation.

## What an answer may assert over a partial payload

Settled in [ADR 0026](adr/0026-household-counts-over-a-partial-payload-block.md).
Sprout is given the coverage and can qualify a number itself; this is the check
that it did, made on the boundary Family Greenhouse owns because the household
total is ours.

Before the answer is persisted or delivered, `checkHouseholdClaims`
(`chat/groundingGuard.ts`) reads it for claims about the size or composition of
the user's own collection — a number or a universal quantifier attached to a
household noun, in English or Spanish, in a sentence that refers to the user's
plants or tasks. A claim over a set whose `complete` is false is unsupported:

- **"You have 100 plants."** — blocked. The household has 250; 100 crossed.
- **"None of your plants are toxic to cats."** — blocked. The plants that did
  not cross are the unmatched ones, which is where an unidentified plant is.
- **"Of your 250 plants, 100 have a confirmed species."** — delivered. A count
  is supported when the sentence states the household total, which is the
  number we sent it. A universal claim gets no such exception.
- **"Water pothos when the top inch of soil is dry."** — untouched. Corpus
  advice about plants in general is not a claim about this household.

A blocked answer is replaced by `HOUSEHOLD_COVERAGE_BLOCK_COPY` in the language
of the question, on the ADR 0009 / 0011 precedent, and loses its citations and
Sprout's disclosure with it — the sentence delivered is Family Greenhouse's, so
Sprout's per-answer note does not belong under it. The `coverage` block stays:
it is the reason for the refusal. `chat_grounding_blocked` records it with
`blockedOn: 'household-coverage'`, and the audit line carries
`householdCoverageBlocked`.

One thing this does **not** settle, an owner decision:

- **Whether the cap stays.** It is a real cap, not a page size — nothing
  fetches the remainder. It remains for now because the payload crosses a
  service boundary; raising or removing it is a separate call, and raising it
  would only move the point at which a household stops being fully represented.

Sprout rejects unknown payload fields, so `coverage` must be accepted there
before `sprout_integration_enabled` is set in any environment.

## Enablement

Store the same high-entropy HMAC secret in each deployment. For Family
Greenhouse, create a Secrets Manager value under the existing
`family-greenhouse/*` namespace and set:

```hcl
sprout_integration_enabled   = "1"
sprout_api_url               = "https://api.sprout.chelseakr.com"
sprout_integration_secret_id = "family-greenhouse/sprout-integration"
```

Set `SPROUT_FAMILY_GREENHOUSE_SECRET` to the secret value in the Sprout API
runtime. Signed requests expire after five minutes. The rollout is read-only;
task proposals and mutations remain in Family Greenhouse and require the
existing explicit confirmation flow.

If Sprout is unavailable during the initial rollout, the existing assistant is
used as a temporary fallback and a structured warning is emitted. Disable the
feature immediately by clearing `sprout_integration_enabled`.

`sprout_api_url` is intentionally restricted to the documented HTTPS host in
both Terraform and the runtime client. This prevents a typo or compromised
configuration from redirecting minimized household context or signed requests
to an internal/arbitrary endpoint.
