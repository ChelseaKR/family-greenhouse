# Architecture

See [Sprout integration](sprout-integration.md) for the feature-flagged,
privacy-minimized plant-care assistant boundary.

A family-scale collaborative app, designed for low ops cost: serverless on the backend, a static SPA on the frontend, a single DynamoDB table, and a thin Express mock for local dev that mirrors the production API.

## Block diagram

```
┌────────────────┐    HTTPS    ┌──────────────────┐
│  React SPA     │◀──────────▶│  CloudFront +    │
│  (CloudFront)  │             │  S3 origin       │
└────────┬───────┘             └──────────────────┘
         │ JSON
         ▼
┌────────────────┐
│  API Gateway   │ — Cognito authorizer attaches claims
└────────┬───────┘
         │
         ▼
┌────────────────────────────────────────────────────┐
│ Lambda handlers (one per HTTP route, middy stack)  │
│ ── auth/* ── households/* ── plants/* ── tasks/*   │
│ ── notifications/* ── billing/* ── me/*            │
└────┬────────────────────┬─────────────────┬────────┘
     │                    │                 │
     ▼                    ▼                 ▼
 DynamoDB             Cognito             S3
 (single table)       (users + claims)    (plant images)
                                    │
                                    ▼
                              SES / SNS / Web Push
                              (notifications)
```

The frontend never talks to AWS services directly — every read/write goes through API Gateway and the Lambda handlers, which is what makes the local Express server (`backend/src/local-server.ts`) a safe stand-in.

## Backend layout

```
backend/src/
├── handlers/        # one folder per resource; each exports the Lambda entry points
│   ├── auth/        signup, login, confirm, refresh, forgot/reset password, resend code
│   ├── households/  create/get, members, invites, role updates, activity
│   ├── plants/      CRUD + image upload-url + confirm + identify
│   ├── tasks/       CRUD + complete + snooze
│   ├── notifications/ subscribe/unsubscribe/run-reminders/prefs
│   ├── billing/     plans, current sub, checkout, portal, webhook
│   └── me/          delete-me (GDPR)
├── middleware/      # middy middlewares: auth, validation, body-size, logging, error
├── services/        # data access + integrations (DDB, Cognito, S3, SES, SNS, Stripe, Plant.id)
├── models/          # Zod schemas + plain types + Plan catalog
├── utils/           # logger, env helper, response builders, AWS clients
└── local-server.ts  # Express mock that mirrors every Lambda for offline dev
```

A typical handler is:

```ts
export const createPlant = createHandler(async (event) => {
  const { user } = event as AuthenticatedEvent; // populated by authMiddleware
  const { validatedBody } = event as ValidatedEvent<CreatePlantInput>;
  // ...business logic by calling services...
  return createdResponse(plant);
})
  .use(authMiddleware())
  .use(requireHousehold())
  .use(validateBody(createPlantSchema));
```

`createHandler` (in `middleware/handler.ts`) sets up the standard middy stack:

1. **bodySizeGuard** — reject bodies over 256 KiB
2. **httpJsonBodyParser** with `disableContentTypeError: true` — parse application/json bodies, leave others alone
3. **httpCors** — restricted to `ALLOWED_ORIGIN` in production
4. **loggingMiddleware** — structured pino log with request-id, user-id, household-id
5. **httpErrorHandler** — turns thrown `createHttpError` into JSON responses

Per-handler middlewares (`authMiddleware`, `requireHousehold`, `requireAdmin`, `validateBody`) are stacked on top of that.

## DynamoDB schema (single table)

One table named `FamilyGreenhouse` with `PK` (string) + `SK` (string) keys, plus two GSIs.

| Entity            | PK                               | SK                     | GSI1PK                    | GSI1SK           | GSI2PK                                             | GSI2SK      |
| ----------------- | -------------------------------- | ---------------------- | ------------------------- | ---------------- | -------------------------------------------------- | ----------- |
| Household         | `HOUSEHOLD#{id}`                 | `METADATA`             | —                         | —                | —                                                  | —           |
| HouseholdMember   | `HOUSEHOLD#{id}`                 | `MEMBER#{userId}`      | `USER#{userId}`           | `HOUSEHOLD#{id}` | —                                                  | —           |
| HouseholdInvite   | `INVITE#{code}`                  | `METADATA`             | —                         | —                | —                                                  | —           |
| Plant             | `HOUSEHOLD#{id}`                 | `PLANT#{plantId}`      | —                         | —                | —                                                  | —           |
| Task              | `HOUSEHOLD#{id}`                 | `TASK#{taskId}`        | `HOUSEHOLD#{id}`          | `{nextDue ISO}`  | `HOUSEHOLD#{id}#ASSIGNEE#{userId}` _(if assigned)_ | `{nextDue}` |
| TaskCompletion    | `HOUSEHOLD#{id}#PLANT#{plantId}` | `COMPLETION#{ts}#{id}` | `HOUSEHOLD#{id}#ACTIVITY` | `{completedAt}`  | —                                                  | —           |
| PushSubscription  | `USER#{userId}`                  | `PUSH#{endpointHash}`  | —                         | —                | —                                                  | —           |
| NotificationPrefs | `USER#{userId}`                  | `PREFS`                | —                         | —                | —                                                  | —           |

A few access patterns this supports:

- "All members of a household" → query `PK = HOUSEHOLD#x AND begins_with(SK, "MEMBER#")`
- "All households a user belongs to" → query GSI1 with `PK = USER#x AND begins_with(SK, "HOUSEHOLD#")`
- "Tasks due in the next 7 days for a household" → query GSI1 with `PK = HOUSEHOLD#x AND SK <= cutoff`
- "Tasks assigned to me" → query GSI2 with `PK = HOUSEHOLD#x#ASSIGNEE#me`
- "Recent activity across the household" → query GSI1 with `PK = HOUSEHOLD#x#ACTIVITY` newest-first

There's no `entityType`-only secondary access — everything fans out from a known partition. Cross-household reads aren't possible without a Scan, which the code never does.

Service-level guarantees:

- Household creation is a single `TransactWriteCommand` so the household row + admin member row land atomically.
- Plant deletion cascades to dependent task rows + completion rows via batched `BatchWriteCommand`s in chunks of 25.
- Invites carry a `ttl` attribute (epoch seconds) so DynamoDB TTL can sweep expired invites; the app code also checks expiry as a defence-in-depth.

## Auth flow

1. User signs up → Cognito `SignUpCommand`, an email confirmation code is mailed via SES (or printed in the dev server console)
2. User confirms email → Cognito `ConfirmSignUpCommand`
3. User logs in → Cognito `InitiateAuthCommand` returns access + refresh + ID tokens
4. Subsequent requests carry the access token; API Gateway's Cognito authorizer validates it and forwards `claims` on `requestContext.authorizer.claims`
5. `authMiddleware` reads claims and attaches an `event.user` shape with `userId`, `email`, `householdId`, `householdRole`

Two things to keep in mind:

- After a user creates or joins a household, we write `custom:household_id` and `custom:household_role` via `AdminUpdateUserAttributesCommand`. **Those attribute changes only show up in the next access token Cognito mints.** The frontend's 401-refresh interceptor handles this transparently — the first request after onboarding refreshes the token before retrying.
- The local Express server uses an opaque mock token `mock-token-{uuid}-{ts}` and skips Cognito entirely. Tests that exercise auth flows hit this server through supertest.

## Frontend layout

```
frontend/src/
├── components/    cross-cutting (Button, Input, Card, Layout, ProtectedRoute, Footer…)
├── features/      page-level views grouped by domain
│   ├── auth/        login, register, confirm, forgot/reset password
│   ├── dashboard/   stats + upcoming tasks + activity
│   ├── plants/      list, detail, add, edit modal, image upload
│   ├── tasks/       list with filters
│   ├── household/   members, invites, role mgmt, onboarding, join
│   ├── settings/    notifications + billing
│   └── landing/     marketing
├── hooks/         small reusable hooks (useDebounce, useMediaQuery, useOverdueAlerts)
├── services/      typed API clients (api.ts is the axios root)
├── store/         zustand auth store
├── utils/         dates, plant name generator, species catalog, notifications helper
├── sentry.ts      Sentry init (no-op without VITE_SENTRY_DSN)
└── main.tsx       app entry
```

State management split:

- **Auth** — Zustand (`store/authStore.ts`), persisted to localStorage via the `persist` middleware. The store also handles `verifySession()` on rehydrate.
- **Server data** — TanStack Query (`@tanstack/react-query`). Mutations invalidate query keys to force refetches.
- **Form state** — react-hook-form + zod resolver.

The axios instance in `services/api.ts` carries two interceptors:

1. **Request**: attach `Authorization: Bearer <accessToken>` from the auth store
2. **Response**: on 401 to a non-`/auth/*` route, call `/auth/refresh` once, retry the original request; logout silently if refresh itself fails

## Notifications fan-out

Single entry point — `notifier.sendToUser(recipient, payload)` — looks up the recipient's `NotificationPreferences` row and concurrently dispatches to whichever channels are enabled:

- **Browser web push** via `web-push` npm package (VAPID-signed) → resolved subscription endpoints in DynamoDB
- **Email** via SES `SendEmailCommand`
- **SMS** via SNS `PublishCommand` direct-to-phone (requires `SMS_NOTIFICATIONS_ENABLED=1` flag because SMS is paid)

Each channel falls back to a structured `pino` log when its env vars aren't set, so devs can see exactly what would have shipped without spending money or needing third-party accounts.

The `runReminders` Lambda walks household members, computes their assigned-and-due tasks, and dispatches one roll-up per member. In production it's invoked by EventBridge on a cron; admins can also trigger it manually from `POST /notifications/run-reminders`.

## Billing flow

1. **Catalog** lives in `models/plans.ts` (Seedling/Garden/Greenhouse, with `maxPlants` and `maxMembers` per tier)
2. **Plan caps** are enforced at write time in `createPlant` and `joinHousehold` — exceeded caps return HTTP 402 with a friendly message
3. **Checkout**: `POST /billing/checkout` creates a Stripe Checkout Session, frontend redirects to Stripe
4. **Webhook**: Stripe posts `checkout.session.{completed,async_payment_succeeded}`, `customer.subscription.{created,updated,deleted}` → `deltaForStripeEvent` translates them into a delta → `applyStripeEvent` writes back to the household row
5. **Portal**: `POST /billing/portal` creates a Stripe Customer Portal session for managing existing subs

The local-server short-circuits the Stripe round-trip — checkout flips the household's plan immediately and returns a stub success URL. Plan caps still apply, so all the gating logic gets exercised against the real handlers.

## What's NOT yet built (and why)

- **Per-PR preview environments** — needs a Terraform workspace per PR, infrastructure work
- **EventBridge scheduled reminders** — the Lambda is built; the schedule rule needs to be provisioned in Terraform
- **Real WAF/CSP** — described in the production checklist; CloudFront response headers + AWS WAF managed rule sets, deployment-time concerns
- **Plant species DB API** — we ship a curated 110-entry catalog instead; the right step up is integrating Trefle or POWO when the curated list stops scaling
- **Multiple households per user** — the schema supports it (GSI1 on user→household). The auth middleware now accepts an `X-Household-Id` request header that overrides the Cognito-claim household for that request; the frontend has a sidebar household-switcher that uses it. The Cognito custom-attribute path remains the default; fully retiring it is a deploy migration (backfill membership rows for users who only ever had a Cognito-claim household, drop the claim from the JWT, retire the override-header code path). Tracked separately as a deploy task.
