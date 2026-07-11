# Support

How user-reported problems get handled. For production _outages_ (not individual user issues), see [`incidents.md`](incidents.md).

## Channel & response targets

- **Primary channel:** the support email listed in the app footer / privacy policy.
- **Targets (aspirational until volume justifies an SLA):**
  - Acknowledge within **1 business day**.
  - Anything that looks like a security report or data loss → treat as same-day, escalate to [`incidents.md`](incidents.md).

## Triage

For each report, capture: account email, household, what they expected vs saw, rough time, and whether it's reproducible. Then:

1. **Is it widespread?** Cross-check the CloudWatch dashboard and `GET /health`. If others are affected → it's an incident, not a support ticket.
2. **Is it security/privacy?** (Someone seeing another household's data, an unexpected charge, a leaked link.) → escalate immediately.
3. **Otherwise** → reproduce, file a normal bug, reply with a workaround + timeline.

## Common issues & resolutions

| Report                                                   | Likely cause                                                     | Resolution                                                                                                                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "I didn't get my confirmation / reset email"             | SES sandbox, spam folder, or unverified sender                   | Confirm SES status; ask them to check spam; resend. Auth emails go through Cognito → SES.                                                                                                                             |
| "My SMS reminders aren't arriving"                       | `SMS_NOTIFICATIONS_ENABLED` off, or number not opted-in/verified | SMS is gated; confirm it's enabled and the number opted in. See [`notifications.md`](notifications.md).                                                                                                               |
| "I paid but I'm still on the free plan"                  | Webhook delivery / signature issue                               | Follow [`runbooks.md` → Stripe webhooks not applying](runbooks.md#stripe-webhooks-not-applying). Resends are idempotent.                                                                                              |
| "I can see/can't see a household I expected"             | Membership / `X-Household-Id` scoping                            | Membership is validated server-side; check the user's memberships on their `USER#<id>` items. See [`multi-household.md`](multi-household.md).                                                                         |
| **"I removed a plant by mistake — can you restore it?"** | The plant was probably archived or given a lifecycle outcome     | Open Plants → Past plants → select the plant → Restore. Tasks, photos, care history, and lineage are preserved. Only the deliberately secondary **Delete permanently** action still requires a DynamoDB PITR restore. |
| "Can I get my data out?"                                 | —                                                                | Self-serve: Settings → export (JSON + per-household CSV for plants/tasks). Backend `GET /me/export` returns the full JSON.                                                                                            |
| "Delete my account"                                      | —                                                                | Self-serve: `DELETE /me`. Note it removes login + personal data but preserves household activity history under the (pseudonymized) member name — say so explicitly.                                                   |

## When to escalate to an incident

Two or more independent reports of the same failure in a short window, anything touching billing correctness or cross-household data exposure, or any report of data loss. Don't wait for the dashboard to confirm — round up, then downgrade.
