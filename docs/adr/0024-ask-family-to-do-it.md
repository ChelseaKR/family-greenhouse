# 0024 — "Ask family to do it" is a second door onto one state

**Status:** Accepted

**Date:** 2026-09-04

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0018](0018-one-assignment-resolver-for-escalation-and-rotation.md)
(the assignment precedence this reuses), [ADR 0010](0010-settled-read-states.md)
(why "nobody was reached" is reported rather than rounded to success),
`backend/src/services/upgradeRequests.ts` (the existing "a member asks someone
for something" feature this is modelled on).

## Context

A member who cannot do a task has had exactly two options: `POST
/tasks/{id}/unclaim`, which releases the occurrence and tells nobody, or
saying nothing at all. Neither is asking. The household's most common real
sentence — _"I'm travelling until Sunday, can someone water the fiddle leaf?"_
— had no home in the product, so it happened in a group chat, or it did not
happen and the plant went dry.

Auto-handoff escalation (ADR 0018) already produces the state that sentence
wants: the occurrence up for grabs, the household told once, nothing
re-assigning it until someone claims or completes it. What it does not have is
a person. It fires on a clock, five days late, and deliberately names nobody —
_"the app nags so nobody has to"_. The ask is the same destination reached
deliberately, at the moment the person knows they cannot do it, with a reason
attached.

Two things could reasonably have been built instead, and both were rejected:

- **A parallel `asked` state.** ADR 0018's precedence list has four levels and
  five interaction pairs that are tested against each other (rotation +
  vacation, rotation + manual, escalation + claim, escalation + vacation,
  escalation never twice). A second "up for grabs, but by a person" level
  doubles that matrix for no behavioural difference: in both cases nothing may
  re-assign the occurrence until it is claimed or completed.
- **A plan gate.** Escalation is paid because it is _automation_. Asking is a
  person talking to their own household — the same category as `claim` and
  `unclaim`, which are free.

## Decision

### One state, two doors

An ask drives the occurrence into the **existing** ESCALATED slot (ADR 0018,
precedence 2): `assignedTo`, `assignedToName` and `assignmentSource` cleared,
`escalatedForDue` pinned to the current `nextDue`, `GSI2PK`/`GSI2SK` removed.
No new precedence level exists, so the resolver, the rotation interaction, the
vacation re-routing and the claim path are unchanged and already tested.

What is new is provenance, not precedence: `helpAskedBy`, `helpAskedByName`,
`helpAskedNote` and `helpAskedForDue` on the task row. `helpAskedForDue` pins
the occurrence exactly as `escalatedForDue` does, which buys three things at
once — the same occurrence cannot be asked about twice, a completion re-arms
the ask by advancing `nextDue`, and the ask's _openness_ becomes derivable
rather than stored.

Because the hourly scan skips any task whose `escalatedForDue` already equals
its `nextDue`, a human ask also stops the app nagging about a lapse a person
has already raised. That falls out of sharing the state; it is not extra code.

### There is no "cancel my ask"

An ask is open exactly while `helpAskedForDue === nextDue` **and** nobody
holds the task (`askFamilyRule.isHelpRequestOpen`). So claiming the task back
closes the ask, and completing it closes the ask, with no second route, no
second write and no stale "Sam asked for help" hanging over work Sam has since
taken back. A cancel button would also be a lie about the part that matters:
the household has already been told, and no write un-sends a push.

### Guardrails, all borrowed rather than re-derived

`askFamilyRule.askRecipients` **is** `escalationRule.escalationRecipients` —
the same function object, re-exported, with a test asserting the identity. If
the two doors ever filtered recipients differently, one of them would start
waking someone on holiday. So an ask never reaches: the asker, anyone inside
an active vacation window (`isAwayAt`), or anyone inside their Do-Not-Disturb
window. One message per recipient.

Volume is bounded twice. Per occurrence, by the conditional write on
`helpAskedForDue`, so two taps cannot both notify. Per person, by **one ask
per task per member per 24 hours**, enforced with a conditional `PutItem` on a
`TASK_HELP_ASK#{taskId}#{userId}` marker carrying a TTL — the technique
`upgradeRequests.ts` uses, and specifically not an in-memory limiter, which
would bind to one warm Lambda container and to none of the others.

The write ordering is deliberate: every read that decides who hears about the
ask happens **before** the marker; the marker before the task write; the task
write before the fan-out. A task write that loses its race hands the marker
back, so a member beaten to it by a housemate does not also lose their turn.

### Reaching nobody is a result

`POST /tasks/{id}/ask` answers with `recipients` (who was told, names only —
never emails), `skipped` (who was left out, and whether it was `away` or
`dnd`), and `delivered` (how many recipients had a channel actually send).
Three different answers stay three different answers:

| Outcome                             | Meaning                             |
| ----------------------------------- | ----------------------------------- |
| `recipients: []`                    | nobody could be reached right now   |
| `recipients: [...]`, `delivered: 0` | we tried; nothing left the building |
| `delivered: n > 0`                  | _n_ people actually got it          |

The UI renders all three distinctly. Collapsing them into "Asked your family"
would be this repository's named dominant defect — an absence rendered as a
value — in the one place where the value _is_ whether a person was reached.

For the same reason the roster, the vacation windows and every member's
notification preferences are read **without a catch**. A failed read is not an
empty household: it aborts the ask before anything is written, rather than
producing a cheerful `notified: 0`.

### Localisation

Each recipient's message is composed in their own language via
`services/email/locale.ts` — their `emailLocale`, else the household's
prevailing choice, else English. Every member's preferences are already in
hand for the DND check, so `householdLocaleFrom` costs no extra read.

## Consequences

- **Free on every tier, and `models/plans.ts` is untouched.** There is no plan
  branch anywhere in the ask's path. Charging a member to ask their own
  household for help would be a reason to leave.
- **The task row grows five nullable fields** and `itemToTask` is now exported
  from `taskService` so the ask's own conditional write maps its `ALL_NEW`
  result through the one mapper rather than a second copy that could silently
  stop carrying a field.
- **`escalatedFrom` is shared.** A human ask writes the same
  `escalatedAt`/`escalatedForDue`/`escalatedFrom` trio, preserving an earlier
  auto-handoff's previous holder rather than overwriting it with null.
  `helpAskedBy` is what tells the two doors apart, and the task row's badge
  reads it first so an ask is never mislabelled "auto-handoff".
- **The activity feed gains `task.help_requested`**, which unlike
  `task.escalated` has a human actor and may carry a note. Its `notified: 0` is
  a real outcome and the renderer treats it as one.
- **Anyone may ask about an unassigned or _inherited_ task; nobody may ask
  about someone else's explicit claim** (403). That is the same line
  `claimTask` already draws: a space default, a Move Day split or a rotation
  turn is a suggestion anyone may take over, while an explicit claim is a
  person's own to release.
- **The trigger lives on the Tasks page.** The dashboard's upcoming-tasks card
  renders the resulting badge and note but does not host the compose dialog;
  the row's action set there is already at its width budget.
- **Terraform, the dev server, the OpenAPI spec and the frontend all mirror
  one new route** (`POST /tasks/{id}/ask`). The parity tests fail if any
  mirror is missed.
