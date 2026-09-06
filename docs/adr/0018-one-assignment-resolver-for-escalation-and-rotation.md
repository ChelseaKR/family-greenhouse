# 0018 — One assignment resolver for auto-handoff escalation and care rotation

**Status:** Accepted

**Date:** 2026-09-03

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0010](0010-settled-read-states.md) (how the plan-gated control
renders an unknown plan); the paid-feature ideation brief §4.4, §4.6, §5, §7.

## Context

Before this decision, three things could put a name on a task and one thing
could re-route it: a manual assignment (including a claim), a space's usual
caregiver (`assignmentSource: 'space_default'`), and — nothing else. Vacation
windows re-routed whoever held the task, at read time, without rewriting the
row. That was already three rules spread over `taskService.createTask`,
`taskService.claimTask`, `reminders.ts` and `annotateTasksWithCoverage`, each
re-deriving "who does this task belong to right now" from the row.

The brief asks for two more mechanisms. **Auto-handoff** (§4.4): a task nobody
has done by _N_ days overdue quietly goes up for grabs and the rest of the
household is told, so the person who always notices never has to be the one
who asks. **Care rotation** (§4.6): "the balcony alternates between Sam and
Priya, weekly", evaluated when a task's next occurrence is generated. The
brief's own warning about §4.6 is the whole reason this record exists:
_"rotation + vacation + claiming + escalation is four assignment mechanisms
interacting. That's where the bugs live. … make escalation and rotation share
one assignment resolver rather than two."_

Two forces pull in opposite directions on the same feature pair:

- **Notification volume.** Escalation adds a _new class_ of email to a product
  whose users already receive reminders, digests, pest alerts and recaps. Done
  wrong, it builds the nagging the product promised to remove.
- **Wedge depth vs. revenue.** Rotation is a good feature, but Tody ships
  auto-rotation in its free-forever tier; the research demoted it from the
  ranked list. Escalation has no free competitor and is the literal sentence
  of the north star.

## Decision

### One resolver, one precedence order

`backend/src/services/assignmentResolver.ts` is the only place that answers
"who is this task's assignee right now?" It is pure — callers load members and
vacation windows once per household and resolve any number of tasks against
that context — and both new features are built on it rather than beside it.

Precedence, highest first:

1. **Explicit.** `assignedTo` set with `assignmentSource: null`. A person chose
   (or claimed) this. Rotation and space defaults never touch it. Only
   escalation may lift it, and only after the household's threshold.
2. **Escalated this occurrence.** `escalatedForDue === nextDue` and nobody holds
   it. The occurrence is up for grabs on purpose; nothing re-assigns it until
   it is claimed or completed.
3. **Rotation.** The plant's space has a rotation and at least one eligible
   member for the occurrence's due date. Eligible means a current member who
   is not away (vacation window covering that instant). Members on vacation
   are skipped, not stalled: the turn passes to the next eligible member.
4. **Space default caregiver**, if still a member.
5. **Unassigned** — up for grabs.

After that, and only at read time: an assignee inside an active vacation
window with a reachable cover is delivered to the cover. The row is never
rewritten for a vacation; the mapping ends when the window ends.

Rotation is **time-indexed from an anchor**, not a stored turn counter:
`period = ⌊(due − anchor) / 7 days⌋` for weekly, calendar months from the
anchor for monthly, and the turn is `memberIds[period mod n]` walked forward
past anyone away. This makes "whose turn" a function of the clock, so the
server derives it for the space list (`rotationTurn`) and the UI never
re-implements the algorithm. It is evaluated at the new occurrence's `nextDue`
when a completion generates it, so a task due next week goes to next week's
person. Inherited assignments (`space_default`, `rotation`) are re-resolved on
every completion; explicit ones are not touched.

### Escalation is at-most-once, decided by DynamoDB

The hourly reminder scan already fetches every household's due-window tasks.
Escalation rides on that list and, when nothing is at the 5-day floor,
performs zero reads. When something is, one `GetItem` returns both the rule
and the plan. Each escalation is a single conditional `UpdateItem` pinned to
the occurrence (`nextDue` unchanged) and to once-only (`escalatedForDue` not
already this `nextDue`). Recipients are notified only after that write
succeeds. A failed send is logged, not retried into next hour's nag.

### Notification-volume guardrails

- **Off by default.** No household escalates until an admin turns it on.
- **Floor of 5 days overdue**, enforced by the request schema, again by
  `setEscalationRule`, and again on read (`normalizeEscalateAfterDays`), so a
  stored value below the floor reads as off. Ceiling 60 days.
- **Once per occurrence.** A completion advances `nextDue`, which is the only
  thing that re-arms the rule.
- **One roll-up per recipient per run**, not one email per task.
- **Never the person it was taken from.** An escalation is not a nag.
- **Never anyone away** (their reminders are already re-routed) and **never
  anyone inside their DND window**. We do not queue for DND: the daily
  reminder roll-up already carries the now-unassigned task next morning.
- **Plan gate re-checked in the scan.** A downgraded household keeps its stored
  rule but the scan stops acting on it; no data cleanup is needed.

### Rotation is free; escalation is paid

Rotation ships to every tier, with no plan check anywhere in its path. A free
competitor already gives it away, so gating it would be a reason to leave, not
a reason to pay — and it deepens the wedge the free tier exists to prove
(≥1.5 active members per household). Escalation is gated to plans with
`householdToolkit` (`models/plans.ts`: Garden and Greenhouse). It requires a
"someone else" to escalate to, which is the coordination product's defensible
sentence, and it is the paid layer on top of the free claiming primitive: free
lets a housemate pick a task up; paid makes the app do the asking.

### Cost

~$0.002 per household per month at any plausible volume: the scan the reminder
fan-out already performs, one `GetItem` per household-hour that has something
at the floor, one conditional write per escalated occurrence, and SES sends at
~$0.0001 each. Twenty escalations a month is a fifth of a cent.

## Consequences

- **Inherited assignments now follow the space.** Before, the usual caregiver
  was applied at task creation and never again; now a `space_default` or
  `rotation` task is re-resolved each time its next occurrence is generated,
  so changing a space's caregiver or rotation takes effect on the next cycle.
  Explicit assignments are unaffected. This is the intended meaning of
  "inherited".
- **`assignmentSource` gains `'rotation'`.** Claiming a rotation-assigned task
  is allowed ("Take over"), exactly as for `space_default`; the claim converts
  it to explicit and rotation leaves it alone from then on.
- **One notification template, two languages, one selected.** The backend holds
  no per-user locale (every outbound mail is English; non-English UI locales
  are still feature-flagged), so `recipientLocale` returns English. The Spanish
  template exists and is tested so threading a preference later is a one-line
  change, not a copywriting task.
- **A DND member may never receive a given escalation.** That is the trade
  chosen over queueing and re-sending; the activity feed and the next daily
  roll-up both carry the task.
- **Terraform, the dev server, the API spec and the frontend all mirror one
  new route** (`PUT /households/{id}/escalation`) and one new field per surface
  (`rotation` on spaces). The parity tests fail if any mirror is missed.
- **The resolver is a chokepoint by design.** A future mechanism (a "nudge",
  a sitter assignment) is added to its precedence list and tested against the
  same interaction cases — rotation + vacation, rotation + manual, escalation +
  vacation, escalation + claim, escalation never twice — rather than becoming
  a fifth place that reads the row.
