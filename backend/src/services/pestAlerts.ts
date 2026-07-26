/**
 * Seasonal pest pressure heads-up. We run this weekly per household:
 *
 *   1. Read the household's plants that have a perenualSpeciesId set.
 *   2. For each, fetch the pest list from Perenual (cached).
 *   3. Pick pests whose typical season matches the current month.
 *   4. Return one seasonal candidate per plant. The caller applies the
 *      per-recipient 90-day suppression marker so a provider failure for one
 *      member never gets hidden by another member's successful delivery.
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

async function lastAlertedAt(
  userId: string,
  plantId: string,
  pestId: number
): Promise<string | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: `PEST_ALERT#${plantId}#${pestId}` },
    })
  );
  return (result.Item?.alertedAt as string) ?? null;
}

/**
 * True when this recipient already received this plant+pest alert within the
 * last quarter.
 */
export async function wasAlerted(
  userId: string,
  plantId: string,
  pestId: number,
  now = new Date()
): Promise<boolean> {
  return withinQuarter(await lastAlertedAt(userId, plantId, pestId), now.getTime());
}

/**
 * Write the per-recipient 90-day suppression marker only after that
 * recipient's provider accepted a delivery.
 */
export async function markAlerted(
  userId: string,
  plantId: string,
  pestId: number,
  now = new Date()
): Promise<void> {
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `USER#${userId}`,
        SK: `PEST_ALERT#${plantId}#${pestId}`,
        entityType: 'PestAlert',
        userId,
        plantId,
        pestId,
        alertedAt: now.toISOString(),
        // Sweep after a year — long-tail dedup not worth keeping forever.
        ttl: Math.floor(now.getTime() / 1000) + 60 * 60 * 24 * 365,
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

    // Pick the first seasonally-active pest. One alert per plant per cycle
    // keeps volume sane; per-recipient suppression happens during delivery.
    for (const pest of pests) {
      if (!pestActiveThisMonth(pest, month)) continue;

      alerts.push({
        plantId: plant.id,
        plantName: plant.name,
        pestId: pest.id,
        pestName: pest.commonName,
        message: `Your ${plant.name} may be entering ${pest.commonName} season — give it a quick check.`,
      });
      // NOTE: suppression is deliberately NOT checked/written here — the
      // caller does it per recipient around the actual provider send.
      break;
    }
  }

  return { alerts, dataUnavailable };
}
