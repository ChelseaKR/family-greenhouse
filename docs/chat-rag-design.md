# Plant care chatbot — design

**Status:** draft, 2026-05-31. Author: paired with Claude Code.
**Decision needed before implementation lands in prod:** see "Open decisions" at the end.

## Goal

A chat companion inside Family Greenhouse that answers plant care questions with knowledge of **the user's actual plants, tasks, household, and climate** — not a generic plant-care Q&A bot bolted onto a fresh tab. The "tight integration" is the whole point; if a user asks "is it time to water the Monstera?", the bot should look at _their_ Monstera, _their_ last watering completion, and _their_ household's climate before answering.

## Non-goals (for V1)

- **No plant identification from photos** — that's a separate Plant.id integration (already stubbed in `services/perenual.ts`).
- **No multi-tenant marketing-style chat** — the bot is per-authenticated-household, full stop.
- **No agentic loops** that take destructive actions without confirmation. The bot can suggest "I'll create a watering reminder for tomorrow" but the user has to tap a Confirm button before any DDB write.
- **No voice in/out**. Text only.

## Architecture

```
                                    ┌────────────────────────┐
                                    │  Bedrock                │
                                    │  - Claude Sonnet 4.6    │
                                    │  - Titan Embeddings v2  │
                                    └──────────┬──────────────┘
                                               │ InvokeModel
   ┌──────────────────┐    ┌───────────────────▼──────────────┐
   │ Frontend         │    │ chat Lambda (handler.handler)    │
   │ ChatPanel.tsx    │◄──►│ - validateBody, authMiddleware,  │
   │ + streaming-ish  │    │   requireHousehold, rateLimit    │
   │   typewriter UX  │    │ - per-household token budget gate│
   └──────────────────┘    │ - tool-use loop (read-only V1)   │
                           │ - persist conversation in DDB    │
                           └──────────┬───────────────────────┘
                                      │ tools fan out
        ┌─────────────┬───────────────┼──────────────┬──────────────┐
        ▼             ▼               ▼              ▼              ▼
   plantService  taskService   climateService  perenual API   chatKnowledge
                                                              (S3-stored md →
                                                               embeddings in DDB)
```

## Two retrieval strategies — running both

1. **Tool use (primary)**. Claude is given a fixed set of structured tools and decides per turn what to call. This is how "tight integration" works in practice: the answer to "should I water the Monstera?" requires reading the user's plant + last-completion + climate, none of which a vector search produces.

2. **RAG (secondary)**. A small curated corpus of plant-care articles (initial seed: ~30 md files in `backend/src/data/plant-care-corpus/`, ~30k words total). Embedded with Titan Embeddings v2 (1024 dims, $0.00002/1k input tokens). Stored as a DDB item per chunk with the embedding inline. At query time the handler does cosine similarity in-memory over all chunks and injects the top 3.

   **Why not OpenSearch / pgvector / Bedrock Knowledge Bases:** the corpus is small (<1k chunks even at scale). DDB scan + cosine in Lambda is O(n) but n=200 = ~50ms. That's faster than calling a separate vector service over the network. And the alternative pricing floors ($700/mo for OpenSearch Serverless, ~$50/mo for the smallest Aurora pgvector instance) are absurd for a personal app.

## Tool catalog (V1, all read-only)

| Tool                             | Purpose                    | Reads                                                    |
| -------------------------------- | -------------------------- | -------------------------------------------------------- |
| `list_household_plants()`        | "Tell me about my plants"  | DDB `Plant` items for the active household               |
| `get_plant_details(plantId)`     | Drill in on one plant      | Plant + photo timeline + recent tasks                    |
| `list_upcoming_tasks(days?)`     | "What needs attention?"    | DDB Task items, default 7-day window                     |
| `list_recent_completions(days?)` | "When did I last water X?" | DDB completion items                                     |
| `get_household_climate()`        | Climate-aware answers      | DDB climate item; lat/lon + saved zone                   |
| `lookup_species(query)`          | Generic species info       | Perenual API (already wrapped in `services/perenual.ts`) |
| `search_care_knowledge(query)`   | Hand-curated articles      | DDB RAG embeddings (see above)                           |

**Out of scope for V1 (deferred to V2):**

- `propose_reminder_task(plantId, type, dueDate)` — returns a "confirmable" structure the UI renders as a Confirm/Cancel card. Confirmation triggers `POST /tasks`. The model never writes directly.
- `find_in_photos(query)` — semantic search across photo captions. Useful but adds a second embedding store.

## Conversation persistence

```
PK: HOUSEHOLD#<id>
SK: CHAT#<conversationId>#MSG#<isoTimestamp>
{
  role: 'user' | 'assistant' | 'tool',
  content: string | StructuredContent[],
  toolCallId?: string,
  inputTokens?: number,
  outputTokens?: number,
  cost?: number,         // dollars to 4 decimal places, for the budget gate
  ttl: <unix-sec>        // 30 days
}
```

Conversations are scoped to the active household. A user with multiple households gets a separate transcript per household. A new conversation begins when the user clicks "New chat" in the UI — there's no implicit threading.

## Cost + safety controls

- **Per-household monthly token budget**: 250k input + 50k output tokens, ≈ $1.50/month at Sonnet 4.6 list price. Gate at the handler before invoking Bedrock; over budget → return a clear "you've used this month's chat allowance" response. Resets on the 1st of each month. (Knob in `tfvars` so we can raise it for trusted households.)
- **Per-message turn cap**: max 5 tool calls per turn before forcing a final answer. Prevents infinite tool loops.
- **Per-conversation context cap**: trim oldest turns once the prompt + history > 50k tokens. Don't lose the system prompt or the last 6 turns.
- **Per-IP rate limit**: reuse `rateLimit` middleware, 20 msg/min per IP. Reuses the `audit('rate_limit.tripped')` path.
- **Audit log**: every chat turn emits `chat.message_sent` and `chat.tools_called`. The OWASP work already wired the audit infrastructure; we'd add two more cases to the union in `auditLog.ts`.

## Privacy

- The system prompt does **not** include user email, member names, or any PII beyond what the user typed.
- Tool results pass through a redactor that strips fields not on a per-tool allowlist (e.g. `get_plant_details` never returns `createdBy` or member emails).
- Conversations are scoped to the household — the bot can't be tricked into reading another household's data because every tool call applies `WHERE PK = HOUSEHOLD#${user.householdId}` internally.
- DDB items have a 30-day TTL — conversations auto-expire.
- No conversation data is ever sent to a third party other than Bedrock itself (which is in-account, in-region, and excluded from training per AWS's Bedrock data policy).

## Streaming

Not in V1. API Gateway HTTP API doesn't support Lambda response streaming, and adding a Function URL is a separate auth story (need to validate the JWT in-handler instead of at API GW). For MVP: synchronous response, the frontend renders a "typing…" indicator until the full response lands. Expected latency: 3–8 seconds for an answer with 2–3 tool calls.

V2 streaming options to evaluate (in order of preference):

1. Lambda Function URL with response streaming + manual JWT validation. Easiest to add later.
2. WebSocket via API Gateway WebSocket API. Real streaming but a whole new API.
3. SSE over HTTP API. Doesn't really work — buffering breaks SSE.

## Bedrock model + region

- **Model:** `anthropic.claude-sonnet-4-20250514-v1:0` (Sonnet 4.6 once GA on Bedrock in us-east-1 — the system prompt confirms 4.6 is the current Claude flagship; if it's not yet on Bedrock in the user's region at deploy time, fall back to `anthropic.claude-3-5-sonnet-20241022-v2:0`).
- **Region:** us-east-1 (same as the rest of the stack — keeps inter-service latency low and avoids cross-region data movement).
- **Model access:** has to be requested in the Bedrock console once per account. Free; usually granted instantly for Claude models. **User must do this before the first invocation succeeds.**

## Infrastructure additions

- New Lambda handler group `chat` — same packaging as the existing 12 groups, brings the count to 13.
- IAM policy on the Lambda role: `bedrock:InvokeModel` on `anthropic.claude-*` and `amazon.titan-embed-*` model ARNs in us-east-1.
- DDB access patterns: new SK prefix `CHAT#`; uses the existing PK+SK schema, no new GSIs. TTL attribute is already on the table.
- New S3 prefix `s3://family-greenhouse-corpus-<env>/` — holds the markdown source for the RAG corpus, versioned. Embeddings are computed once at deploy time by a build script and written to DDB; the S3 source is the audit trail.
- Three new API routes: `POST /chat/messages`, `GET /chat/conversations`, `GET /chat/conversations/{id}/messages`.

## Phases

**MVP (this session):**

1. Skeleton chat handler with tool-use loop against a real Claude on Bedrock.
2. Three read-only tools: `list_household_plants`, `list_upcoming_tasks`, `get_household_climate`.
3. Conversation persistence in DDB.
4. Per-household budget gate (stub the counter — actually wire it once a real conversation happens).
5. Frontend chat panel with synchronous send + typing indicator.
6. **No RAG yet** — pure tool-use to validate the loop end-to-end.

**V1 (next session):** 7. The remaining 3 read tools. 8. RAG: corpus ingest script, DDB-stored embeddings, in-Lambda cosine, top-3 retrieval. 9. Initial 30-article corpus seeded.

**V2:** 10. Write-side tool: `propose_reminder_task` with confirm-card UI. 11. Streaming via Lambda Function URL. 12. Photo semantic search via second embedding store.

## Open decisions

| Decision                                                 | My recommendation              | Need from user                                                         |
| -------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| Skip OpenSearch / pgvector for RAG, use in-Lambda cosine | Yes — saves $700/mo            | Confirm                                                                |
| Sync response, no streaming for MVP                      | Yes — defer Function URL story | Confirm                                                                |
| Per-household token budget = 250k in + 50k out / month   | Knob in tfvars; defaults safe  | Confirm or change number                                               |
| Conversation TTL 30 days                                 | Reasonable for forensics + UX  | Confirm                                                                |
| Bedrock model access                                     | Required, free                 | **You must request access in Bedrock console** before first invocation |

## Open risks

- **Hallucinated care advice.** Even with tool use, Claude can confidently invent care details. Mitigation: every assistant message includes a small footer like "Generated by AI based on your plant data — verify before acting." For pesticide/herbicide questions, add a hard refusal in the system prompt.
- **Cost surprises if the budget gate has a bug.** Mitigation: also gate at the AWS Budget level — alarm at $5/month/account. Worst case the user gets a SNS notification, not a $500 bill.
- **PII leakage in tool results.** Mitigation: tool output redactor + integration tests asserting redactor strips emails.
- **Tool-use loop divergence.** Claude could call the same tool repeatedly. Mitigation: per-turn tool call cap (5) + deduplication of identical tool calls within a turn.
