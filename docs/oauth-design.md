# OAuth for the Public API — Design

> **Status:** design only. Nothing in this document is built. It is the GA
> gate for the public API ([public-api.md](public-api.md), roadmap Y2Q4):
> API keys cover first-party scripts today; OAuth is what lets a third-party
> app act on a user's behalf without ever holding a household-wide secret.

## Why API keys aren't enough

Today's keys (`services/apiKeys.ts`) are household-scoped bearer secrets:
SHA-256-hashed at rest, looked up via GSI3, carrying scope arrays
(`read:*`, `write:tasks`), Greenhouse-gated, admin-issued. They're right for
"my own script" and wrong for "a third-party app my users sign into":

- **No user consent flow.** Only a household admin can mint a key, and the
  key represents the household, not the person who connected the app.
- **Sharing a key with a vendor is irrevocable trust.** The vendor holds the
  raw secret; rotation means a human re-pasting a string.
- **No expiry.** A leaked key is valid until someone notices.

## Protocol choice: Authorization Code + PKCE

Standard **OAuth 2.1 authorization-code flow with PKCE, no implicit grant,
no password grant**. PKCE (`S256` only) is mandatory for all clients —
public clients (mobile/SPA integrations) get no client secret at all, and
confidential clients use it anyway (defense in depth, and it keeps one code
path).

```
third-party app                FG auth surface                  FG API
     |  GET /oauth/authorize?...      |                            |
     |------------------------------->| login (Cognito Hosted UI)  |
     |                                | + consent screen           |
     |<--- 302 redirect_uri?code=... -|                            |
     |  POST /oauth/token (code+verifier)                          |
     |------------------------------->|                            |
     |<-- {access_token, refresh_token, expires_in}                |
     |  Authorization: Bearer <access_token>                       |
     |------------------------------------------------------------>|
```

## Token endpoint: new Lambda routes vs. Cognito custom scopes

Two realistic hosts for `/oauth/authorize` + `/oauth/token`:

### Option A — Cognito resource servers + custom scopes

Cognito user pools support OAuth resource servers with custom scopes
(`fg-api/read:plants` etc.) and host the authorize/token endpoints for us.

- **Pros:** zero token-issuance code to write or secure; JWKS, rotation, and
  token signing are managed; the Hosted UI already exists in our stack.
- **Cons (decisive):**
  - Cognito app clients are a _pool-level admin object_ — onboarding a
    third-party developer means Terraform/console changes, not a
    self-service registration row. (infrastructure/\*\* churn per integrator.)
  - Consent UX is Cognito's, barely brandable, and cannot render our
    scope-explanation copy ("This app will be able to complete tasks…").
  - Scope grants are per-client, not per-user-per-client; revoking one
    user's grant to one app isn't expressible.
  - No household concept: our authorization is `user → active household`,
    which Cognito scopes can't carry without custom claims + a pre-token
    Lambda anyway — at which point we're writing the hard part ourselves
    regardless.

### Option B — Our own Lambda routes (recommended)

New handler group `handlers/oauth/` behind API Gateway, same middy/router
pattern as every other group:

```
GET  /oauth/authorize     — validates client_id/redirect_uri/scope/PKCE,
                            bounces unauthenticated users through the existing
                            Cognito login, then renders the consent screen
POST /oauth/consent       — records the grant, issues the code (authenticated)
POST /oauth/token         — code+verifier → tokens; refresh_token rotation
POST /oauth/revoke        — RFC 7009 revocation
```

- Cognito stays exactly what it is today: the _authentication_ provider.
  OAuth authorization (clients, grants, consent, tokens) is our data in our
  table, using the same single-table patterns as API keys.
- Self-service client registration becomes a DDB row + admin approval, not
  an infra deploy.
- **Cost:** we own token security. Mitigations below keep the surface small.

**Decision: Option B.** Cognito's model can't express per-user-per-household
grants or a branded consent screen; we'd be fighting it forever.

### Storage sketch (single table, mirrors APIKEY rows)

```
OAUTHCLIENT#{clientId}          | METADATA            — name, redirectUris[], logo, status, ownerEmail
HOUSEHOLD#{hhId}                | OAUTHGRANT#{userId}#{clientId} — scopes[], grantedAt
OAUTH#CODE#{sha256(code)}       | METADATA            — clientId, userId, hhId, scopes, codeChallenge, ttl 60s, one-time (conditional delete)
OAUTH#REFRESH#{sha256(token)}   | METADATA            — grant ref, family id, ttl 90d, rotated-on-use
```

Access tokens are **short-lived (15 min) signed JWTs** (KMS asymmetric key,
`kid` in header) so the API authorizer verifies them statelessly — no DDB
read per request. Refresh tokens are opaque, hashed at rest (same discipline
as `fg_` keys), and **rotated on every use**; reuse of a rotated token kills
the whole family (stolen-token detection).

## Scope model

Reuse the API-key scope vocabulary 1:1 — `read:plants`, `read:tasks`,
`read:activity`, `write:tasks` — so `requireApiScope()` and the per-route
gates in `handlers/api/handler.ts` work unchanged whether the principal
arrived via API key or OAuth token. The middleware grows one branch: detect
`Bearer eyJ…` (JWT) vs `Bearer fg_…` (key) and populate the same
`event.user` + `event.apiScopes` shape, with
`user.userId = "oauth:{userId}"` and the _grant's_ household as
`householdId`. Future scopes (`write:plants`, `read:household`) land in
`API_SCOPES` once and serve both schemes. Same rule as keys: **no default
ever includes a write scope.**

## Consent screen

Rendered by the frontend at `/oauth/consent` (data from
`GET /oauth/authorize` validation): app name + logo, the requesting
developer, an explicit household picker for multi-household users (the grant
binds to ONE household), and a per-scope plain-language list — write scopes
visually flagged with the same warning styling as the API-key settings page.
Deny → redirect with `error=access_denied`. Grants are listed under
**Settings → Connected apps** with per-app revoke (deletes the grant row +
revokes the refresh-token family).

## Rotation & revocation

- **Access tokens:** expire in 15 min; no revocation list needed at this TTL.
- **Refresh tokens:** rotate on use; reuse-detection revokes the family.
- **Client secrets** (confidential clients): two active secrets per client so
  rotation is overlap-then-retire, like any API credential.
- **Signing keys:** two KMS keys live in JWKS; rotate by issuing with the new
  `kid` while the old one ages out of verification after max-TTL.
- **User-level:** revoking a grant (user) or disabling a client (us, e.g.
  abuse) takes effect within one access-token TTL.

## Webhook signing (forward-looking, for the webhooks feature)

When webhooks ship, deliveries are signed the same way Stripe signs ours
(`billing/handler.ts` verifies `stripe-signature`):

```
FG-Signature: t=<unix>, v1=HMAC_SHA256(secret, "<t>.<rawBody>")
```

Per-endpoint secret shown once at registration (the API-key UX), 5-minute
tolerance on `t` against replay, dual-secret rotation, and verify-before-
parse documented for integrators. Webhook subscriptions are created by an
OAuth client on behalf of a grant, scoped to that grant's household, and die
with the grant.

## Migration path from API keys

1. **No forced migration.** Keys remain the first-party story indefinitely;
   OAuth is additive for third parties.
2. Middleware accepts both principals (above) — zero changes to route gates.
3. Docs steer vendors: "personal script → API key; multi-user app → OAuth."
4. If a vendor has been sharing one household's API key with end users
   (the anti-pattern), their cutover is: register a client, ask users to
   connect, revoke the shared key.
5. Long-term (post-GA, not committed): write scopes on _new_ API keys could
   be restricted to OAuth-only, leaving keys read-only. Decide on real data.

## Rollout gates

| Gate                  | Criteria                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **G0 design review**  | This doc + threat model reviewed; pen-test checklist drafted (redirect-uri exact match, code replay, PKCE downgrade, mix-up attack).                                                       |
| **G1 internal alpha** | Endpoints live behind `OAUTH_ENABLED=1` (default off — same env-gate discipline as `IDENTIFY_METERING_ENABLED`); one first-party test client; tokens work against `/api/v1/*` read routes. |
| **G2 closed beta**    | Consent screen + Connected-apps settings shipped; refresh rotation + reuse detection verified in tests; 2–3 hand-picked integrators.                                                       |
| **G3 write scopes**   | `write:tasks` issuable via consent; audit logging (`api.task_*` events carry `oauth:{userId}` + clientId); rate limits per token reviewed.                                                 |
| **G4 GA**             | Self-service client registration with approval queue; revocation SLA documented; security review signed off; public-api.md flips status.                                                   |

Each gate is independently revertible: the env flag kills issuance instantly,
and the 15-minute access-token TTL bounds the blast radius of a rollback.
