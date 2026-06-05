# Incident response

What to do when production breaks. Pair this with [`runbooks.md`](runbooks.md) (the step-by-step fixes for specific failures) and [`support.md`](support.md) (how user-reported issues get triaged).

Today the team is small enough that "on-call" is "whoever is awake." This doc exists so that when there are two of us — or when it's 3am — nobody has to invent a process mid-incident.

## Severity levels

| Sev       | Definition                                             | Examples                                                                      | Response                                                 |
| --------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| **SEV-1** | App unusable for all/most users; data at risk          | Login broken, API 5xx storm, DynamoDB unavailable, data loss                  | Drop everything. Start a timeline. Fix or roll back now. |
| **SEV-2** | A major feature is broken for many users; no data risk | Billing checkout failing, reminders not sending, image upload broken          | Same day. Mitigate, then fix.                            |
| **SEV-3** | Degraded or broken for some users; workaround exists   | One integration down (Perenual/Plant.id), slow p95, cosmetic but user-visible | Next business day. Track as a normal bug.                |

When unsure, **round up** for the first 15 minutes, then downgrade once scope is clear.

## First 15 minutes (any SEV-1/2)

1. **Acknowledge.** Note the start time. If a second person is around, one drives, one scribes.
2. **Confirm it's real.** Hit `GET /health` (the Route53 monitor alarms on this). Load `https://familygreenhouse.net`. Is it you or everyone? Check the CloudWatch dashboard `family-greenhouse-production` (API 5xx, Lambda errors/p95, DDB throttles).
3. **Find the blast radius.** One handler group or all? One household or all? Recent deploy? `git log --oneline -5` and check whether a deploy/tag landed in the last hour.
4. **Stop the bleeding before you fix the cause.** Prefer rollback over a forward-fix under pressure — see [`runbooks.md` → Roll back a bad deploy](runbooks.md#roll-back-a-bad-deploy). A production smoke failure already triggers **auto-rollback** of the Lambda code (see `cd-production.yml`), so check whether that already fired.
5. **Communicate.** If users are affected, post to the status channel / status page. "We're aware of <X>, investigating" beats silence.

## Escalation

- **Solo:** you are the escalation. Use the runbooks; don't improvise on data-destructive steps (restores, deletes) — read the runbook first.
- **Two+ engineers:** the person who took the page owns the incident until explicitly handed off ("you have the conn"). The owner decides rollback vs forward-fix and writes the post-mortem.
- **Vendor-side:** if the root cause is AWS (region event), Stripe, or another provider, link their status page in the timeline and switch to monitoring + comms — there's no code fix to make.

## After it's over (SEV-1/2 → post-mortem)

Write a short blameless post-mortem within 48h. Template:

```
# Post-mortem: <short title> — <date>

## Summary
One paragraph: what broke, who was affected, for how long.

## Timeline (UTC)
- HH:MM  first signal (alarm / user report)
- HH:MM  acknowledged
- HH:MM  mitigation applied
- HH:MM  resolved

## Impact
Users affected, features down, any data loss.

## Root cause
The actual cause, not the symptom.

## What went well / what didn't
Detection, response, tooling gaps.

## Action items
- [ ] <owner> <concrete fix or guardrail> — so this class of failure can't recur
```

The point of the action items is to convert each incident into a guardrail (an alarm, a test, a runbook entry). Add new runbook entries here as you learn them.
