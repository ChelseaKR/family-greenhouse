/**
 * Seasonal pest pressure heads-up. We run this weekly per household:
 *
 *   1. Read the household's plants that have a perenualSpeciesId set.
 *   2. For each, fetch the pest list from Perenual (cached).
 *   3. Pick pests whose typical season matches the current month.
 *   4. Suppress duplicates: any pest already alerted on this plant within
 *      the last quarter is skipped.
 *   5. Return one alert per plant (or none) — the caller dispatches via
 *      the notification fanout.
 *
 * Our season heuristic is naive on purpose: Perenual doesn't ship a
 * structured "active months" field for pests, so we look for month names
 * in the description text. This trades precision for coverage; we'd
 * rather miss a few alerts than spam users with off-season warnings.
 */
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import { getPlants } from './plantService.js';
import { listPestsForSpeciesCached } from './enrichment.js';
import type { PerenualPestSummary } from './perenual.js';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const QUARTER_DAYS = 90;

export interface PestAlert {
  plantId: string;
  plantName: string;
  pestId: number;
  pestName: string;
  message: string;
}

function currentMonthName(now = new Date()): string {
  return MONTHS[now.getUTCMonth()];
}

function capitalize(m: string): string {
  return m[0].toUpperCase() + m.slice(1);
}

// Word-boundary match on month names. Every month except May is matched
// case-INSENSITIVELY, so "JUNE"/"june"/"June" all count. "May" is kept its
// own, case-SENSITIVE regex on purpose: the old lowercase `includes()` check
// treated the verb "may" ("aphids may appear") as the month May — virtually
// every pest description contains "may", so every pest looked May-only.
// Requiring a capital M avoids that specific false positive; a case-
// insensitive flag on this alternative alone would silently reintroduce it.
const MAY_RE = /\bMay\b/;
const OTHER_MONTHS_RE = new RegExp(
  `\\b(${MONTHS.filter((m) => m !== 'may')
    .map(capitalize)
    .join('|')})\\b`,
  'i'
);

export function pestActiveThisMonth(pest: PerenualPestSummary, monthName: string): boolean {
  const text = pest.description ?? '';
  // If no description mentions any month at all, treat the pest as
  // "always relevant" — better to notify than to silently skip species
  // with thin upstream data.
  if (!MAY_RE.test(text) && !OTHER_MONTHS_RE.test(text)) return true;
  if (monthName === 'may') return MAY_RE.test(text);
  return new RegExp(`\\b${capitalize(monthName)}\\b`, 'i').test(text);
}

async function lastAlertedAt(plantId: string, pestId: number): Promise<string | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PLANT#${plantId}`, SK: `PEST_ALERT#${pestId}` },
    })
  );
  return (result.Item?.alertedAt as string) ?? null;
}

/**
 * Write the 90-day suppression marker for a plant+pest pair. Exported so the
 * caller (the reminder run) records it only AFTER a successful delivery — a
 * failed send must not suppress the alert for a whole quarter.
 */
export async function markAlerted(plantId: string, pestId: number): Promise<void> {
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `PLANT#${plantId}`,
        SK: `PEST_ALERT#${pestId}`,
        entityType: 'PestAlert',
        plantId,
        pestId,
        alertedAt: new Date().toISOString(),
        // Sweep after a year — long-tail dedup not worth keeping forever.
        ttl: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
      },
    })
  );
}

function withinQuarter(iso: string | null, now = Date.now()): boolean {
  if (!iso) return false;
  const ms = QUARTER_DAYS * 24 * 60 * 60 * 1000;
  return now - new Date(iso).getTime() < ms;
}

export interface PestAlertsResult {
  alerts: PestAlert[];
  /**
   * True when at least one eligible plant's pest data couldn't be fetched
   * for a reason that might resolve later THIS day (budget exhausted or a
   * transient upstream error) — NOT when Perenual is simply unconfigured,
   * which is permanent and not worth flagging for retry. The caller
   * (`reminders.ts`) uses this to decide whether it's safe to mark the
   * household "checked" for today, so a transient outage doesn't silently
   * suppress alerts until tomorrow.
   */
  dataUnavailable: boolean;
}

export async function evaluatePestAlerts(
  householdId: string,
  now = new Date()
): Promise<PestAlertsResult> {
  const plants = await getPlants(householdId);
  const month = currentMonthName(now);
  const alerts: PestAlert[] = [];
  let dataUnavailable = false;

  for (const plant of plants) {
    if (!plant.perenualSpeciesId || !plant.species) continue;
    const lookup = await listPestsForSpeciesCached(plant.species);
    if (!lookup.ok) {
      if (lookup.reason !== 'unconfigured') {
        dataUnavailable = true;
        logger.warn(
          { householdId, plantId: plant.id, reason: lookup.reason },
          'pestAlerts.pest_data_unavailable'
        );
      }
      continue;
    }
    const pests = lookup.pests;
    if (pests.length === 0) continue;

    // Pick the first seasonally-active pest we haven't alerted on
    // recently. One alert per plant per cycle keeps the volume sane.
    for (const pest of pests) {
      if (!pestActiveThisMonth(pest, month)) continue;
      const last = await lastAlertedAt(plant.id, pest.id);
      if (withinQuarter(last, now.getTime())) continue;

      alerts.push({
        plantId: plant.id,
        plantName: plant.name,
        pestId: pest.id,
        pestName: pest.commonName,
        message: `Your ${plant.name} may be entering ${pest.commonName} season — give it a quick check.`,
      });
      // NOTE: the suppression marker is deliberately NOT written here — the
      // caller calls markAlerted() after the notification actually goes out.
      break;
    }
  }

  return { alerts, dataUnavailable };
}
