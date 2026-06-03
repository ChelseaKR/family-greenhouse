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
  pestName: string;
  message: string;
}

function currentMonthName(now = new Date()): string {
  return MONTHS[now.getUTCMonth()];
}

function pestActiveThisMonth(pest: PerenualPestSummary, monthName: string): boolean {
  const text = (pest.description ?? '').toLowerCase();
  // If no description mentions any month at all, treat the pest as
  // "always relevant" — better to notify than to silently skip species
  // with thin upstream data.
  const anyMonth = MONTHS.some((m) => text.includes(m));
  if (!anyMonth) return true;
  return text.includes(monthName);
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

async function recordAlertedAt(plantId: string, pestId: number): Promise<void> {
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

export async function evaluatePestAlerts(
  householdId: string,
  now = new Date()
): Promise<PestAlert[]> {
  const plants = await getPlants(householdId);
  const month = currentMonthName(now);
  const alerts: PestAlert[] = [];

  for (const plant of plants) {
    if (!plant.perenualSpeciesId || !plant.species) continue;
    const pests = await listPestsForSpeciesCached(plant.species);
    if (!pests || pests.length === 0) continue;

    // Pick the first seasonally-active pest we haven't alerted on
    // recently. One alert per plant per cycle keeps the volume sane.
    for (const pest of pests) {
      if (!pestActiveThisMonth(pest, month)) continue;
      const last = await lastAlertedAt(plant.id, pest.id);
      if (withinQuarter(last, now.getTime())) continue;

      alerts.push({
        plantId: plant.id,
        plantName: plant.name,
        pestName: pest.commonName,
        message: `Your ${plant.name} may be entering ${pest.commonName} season — give it a quick check.`,
      });
      await recordAlertedAt(plant.id, pest.id);
      break;
    }
  }

  return alerts;
}
