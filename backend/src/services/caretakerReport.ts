/**
 * Proof-of-visit report assembly — pure functions over visit records.
 *
 * The report is the artefact a household hands to whoever is paying: for a
 * date range it says who came, when they arrived, what they did, and what
 * they said about it. Everything here is deterministic and side-effect free
 * so it can be unit-tested without DynamoDB; the read that feeds it lives in
 * `caretakerService.listVisits` and is allowed to throw.
 *
 * Two honesty rules are built into the shape:
 *
 *   1. **A visit's counts are authoritative, its detail is not.** Visit rows
 *      cap stored detail at `VISIT_DETAIL_CAP` entries per kind while keeping
 *      exact counters. When they disagree, the report says how many lines it
 *      cannot show instead of quietly reporting the shorter number.
 *   2. **Empty is not the same as unknown.** This module only ever describes
 *      visits it was actually given. A failed read never reaches here — the
 *      handler surfaces the failure and the page renders "we could not load
 *      this", not an empty report (ADR 0010).
 */
import type { CaretakerVisit } from './caretakerService.js';

export interface CaretakerReportVisit extends CaretakerVisit {
  /** Detail lines the visit record could not store, per kind. Always ≥ 0. */
  omitted: { tasks: number; photos: number; notes: number };
  /** True when any detail line is missing, so the report can say so. */
  detailTruncated: boolean;
}

export interface CaretakerReportTotals {
  visits: number;
  tasksCompleted: number;
  photos: number;
  notes: number;
  caretakers: number;
}

export interface CaretakerReportByCaretaker {
  caretakerId: string;
  caretakerName: string;
  visits: number;
  tasksCompleted: number;
  photos: number;
  notes: number;
  firstVisitAt: string;
  lastVisitAt: string;
}

export interface CaretakerReport {
  householdId: string;
  /** Inclusive range boundaries, as ISO instants. */
  from: string;
  to: string;
  generatedAt: string;
  visits: CaretakerReportVisit[];
  totals: CaretakerReportTotals;
  byCaretaker: CaretakerReportByCaretaker[];
}

const nonNegative = (n: number) => (n > 0 ? n : 0);

function withOmissions(visit: CaretakerVisit): CaretakerReportVisit {
  const omitted = {
    tasks: nonNegative(visit.taskCount - visit.tasksCompleted.length),
    photos: nonNegative(visit.photoCount - visit.photos.length),
    notes: nonNegative(visit.noteCount - visit.notes.length),
  };
  return {
    ...visit,
    omitted,
    detailTruncated: omitted.tasks + omitted.photos + omitted.notes > 0,
  };
}

/**
 * Build the report for a range from the visits that fall in it.
 *
 * `visits` must be exactly what the range query returned — this function does
 * not filter by date, because silently dropping rows would make the totals
 * disagree with the rows shown for reasons the reader cannot see.
 */
export function buildCaretakerReport(input: {
  householdId: string;
  from: string;
  to: string;
  visits: CaretakerVisit[];
  generatedAt: string;
}): CaretakerReport {
  const visits = input.visits
    .slice()
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
    .map(withOmissions);

  const byCaretaker = new Map<string, CaretakerReportByCaretaker>();
  for (const visit of visits) {
    const existing = byCaretaker.get(visit.caretakerId);
    if (!existing) {
      byCaretaker.set(visit.caretakerId, {
        caretakerId: visit.caretakerId,
        // The name is denormalised onto each visit at the time it happened,
        // so a renamed or revoked seat never rewrites history. The most
        // recent visit's name wins for the summary row.
        caretakerName: visit.caretakerName,
        visits: 1,
        tasksCompleted: visit.taskCount,
        photos: visit.photoCount,
        notes: visit.noteCount,
        firstVisitAt: visit.startedAt,
        lastVisitAt: visit.lastActionAt,
      });
      continue;
    }
    existing.caretakerName = visit.caretakerName;
    existing.visits += 1;
    existing.tasksCompleted += visit.taskCount;
    existing.photos += visit.photoCount;
    existing.notes += visit.noteCount;
    if (visit.startedAt < existing.firstVisitAt) existing.firstVisitAt = visit.startedAt;
    if (visit.lastActionAt > existing.lastVisitAt) existing.lastVisitAt = visit.lastActionAt;
  }

  const totals: CaretakerReportTotals = {
    visits: visits.length,
    // Counters, not array lengths — see the truncation rule above.
    tasksCompleted: visits.reduce((sum, v) => sum + v.taskCount, 0),
    photos: visits.reduce((sum, v) => sum + v.photoCount, 0),
    notes: visits.reduce((sum, v) => sum + v.noteCount, 0),
    caretakers: byCaretaker.size,
  };

  return {
    householdId: input.householdId,
    from: input.from,
    to: input.to,
    generatedAt: input.generatedAt,
    visits,
    totals,
    byCaretaker: [...byCaretaker.values()].sort((a, b) =>
      a.caretakerName.localeCompare(b.caretakerName)
    ),
  };
}

/**
 * Normalise a requested `from`/`to` (calendar dates or ISO instants) into the
 * inclusive instant range the query uses. Returns null when the range is
 * unusable, so the handler answers 400 rather than guessing at a window and
 * producing a report for the wrong dates.
 */
export function resolveReportRange(
  from: unknown,
  to: unknown
): { fromIso: string; toIso: string } | null {
  // These arrive straight off the query string, so their runtime type is the
  // caller's to prove, not ours to assume. A repeated `?from=a&from=b` is an
  // array on Express (and the declared `string` type would be a lie), and
  // `.length` on an array means something entirely different from `.length`
  // on a date string — so refuse a non-string outright rather than branch on
  // a tampered type and produce a report for the wrong window.
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const start = Date.parse(from.length === 10 ? `${from}T00:00:00.000Z` : from);
  const end = Date.parse(to.length === 10 ? `${to}T23:59:59.999Z` : to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (end < start) return null;
  return { fromIso: new Date(start).toISOString(), toIso: new Date(end).toISOString() };
}
