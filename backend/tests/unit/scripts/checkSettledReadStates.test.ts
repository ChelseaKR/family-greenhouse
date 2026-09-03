/**
 * The backend settled-read-state ratchet (`scripts/check-settled-read-states.mjs`,
 * ADR 0010) has to be able to FAIL, or it is a report with a green tick. These
 * tests run the real script as a child process against fixture trees and
 * check both directions of the ratchet: a masked read is caught, the
 * codebase's own correct idioms are not, and a baseline entry that no longer
 * matches anything fails the run.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../../scripts/check-settled-read-states.mjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(files: Record<string, string>, accepted: Record<string, string> = {}): RunResult {
  const root = mkdtempSync(join(tmpdir(), 'reads-ratchet-'));
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const abs = join(src, name);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  const baseline = join(root, 'baseline.json');
  writeFileSync(baseline, JSON.stringify({ accepted }));
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--src', src, '--baseline', baseline], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const PREAMBLE = `
import { GetCommand, QueryCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
`;

describe('settled-read-state ratchet (backend)', () => {
  describe('catches the masked-read shapes', () => {
    it('a catch that returns 0 after a GetCommand (the leafHealthBudget shape)', () => {
      const out = run({
        'services/budget.ts': `${PREAMBLE}
export async function getUsage(id: string): Promise<number> {
  try {
    const result = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: id } }));
    const used: unknown = result.Item?.used;
    return typeof used === 'number' && used > 0 ? used : 0;
  } catch (err) {
    logger.warn({ err }, 'budget_read_failed');
    return 0;
  }
}`,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('services/budget.ts::getUsage::catch-returns-empty');
      expect(out.stderr).toContain('returns 0 on failure');
    });

    it('a catch that returns [] after a QueryCommand', () => {
      const out = run({
        'services/keys.ts': `${PREAMBLE}
export async function listKeys(id: string): Promise<string[]> {
  try {
    const r = await dynamodb.send(new QueryCommand({ TableName: TABLE_NAME }));
    return (r.Items ?? []).map((i) => i.id as string);
  } catch (err) {
    logger.warn({ err }, 'keys_read_failed');
    return [];
  }
}`,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('services/keys.ts::listKeys::catch-returns-empty');
    });

    it('a catch that returns null when the try also returns null for "not found"', () => {
      const out = run({
        'services/cache.ts': `${PREAMBLE}
export async function readCache(pk: string): Promise<string | null> {
  try {
    const r = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: pk } }));
    if (!r.Item) return null;
    return r.Item.payload as string;
  } catch (err) {
    return null;
  }
}`,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('services/cache.ts::readCache::catch-returns-empty');
      expect(out.stderr).toContain('the try block also yields null');
    });

    it('an object literal that names no failure state (the enrichment budget shape)', () => {
      const out = run({
        'services/budget.ts': `${PREAMBLE}
export async function check(): Promise<{ used: number; limit: number; blocked: boolean }> {
  const limit = 80;
  try {
    const r = await dynamodb.send(new UpdateCommand({ TableName: TABLE_NAME, ReturnValues: 'UPDATED_NEW' }));
    const used = (r.Attributes?.used as number) ?? 1;
    return { used, limit, blocked: used > limit };
  } catch (err) {
    return { used: 0, limit, blocked: false };
  }
}`,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('services/budget.ts::check::catch-returns-empty');
    });

    it('a swallowing catch that leaves a defaulted variable in place', () => {
      const out = run({
        'handlers/x.ts': `${PREAMBLE}
import { householdService } from '../services/householdService.js';
export async function handler(id: string): Promise<string> {
  let actorName = 'Someone';
  try {
    const member = await householdService.getMemberByUserId(id, id);
    actorName = member?.name || 'Someone';
  } catch (err) {
    logger.warn({ err }, 'lookup_failed');
  }
  return actorName;
}`,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('handlers/x.ts::handler::catch-swallows-into-default');
    });

    it('a swallowing catch followed by one return that serves both outcomes', () => {
      const out = run({
        'services/names.ts': `${PREAMBLE}
export async function getUserName(id: string, email: string): Promise<string> {
  try {
    const r = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: id } }));
    if (r.Item?.name) return r.Item.name as string;
  } catch {
    // fall through
  }
  return email.split('@')[0];
}`,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain(
        'services/names.ts::getUserName::catch-swallows-then-shared-return'
      );
    });

    it('a promise .catch that resolves a read to an empty list', () => {
      const out = run({
        'services/chain.ts': `${PREAMBLE}
export function listPlants(id: string): Promise<unknown[]> {
  return dynamodb
    .send(new QueryCommand({ TableName: TABLE_NAME }))
    .then((r) => r.Items ?? [])
    .catch(() => []);
}`,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('services/chain.ts::listPlants::promise-catch-returns-empty');
    });
  });

  describe('leaves the correct idioms alone', () => {
    it('the identifyBudget shape: number on success, null on failure', () => {
      const out = run({
        'services/budget.ts': `${PREAMBLE}
export async function getUsage(id: string): Promise<number | null> {
  try {
    const result = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: id } }));
    const used: unknown = result.Item?.used;
    return typeof used === 'number' && used > 0 ? used : 0;
  } catch (err) {
    logger.warn({ err }, 'budget_read_failed');
    return null;
  }
}`,
      });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('passed');
    });

    it('a discriminated failure object (available: false against available: true)', () => {
      const out = run({
        'services/budget.ts': `${PREAMBLE}
export async function check(): Promise<unknown> {
  const limit = 80;
  try {
    const r = await dynamodb.send(new UpdateCommand({ TableName: TABLE_NAME, ReturnValues: 'UPDATED_NEW' }));
    const used = (r.Attributes?.used as number) ?? 1;
    return { used, limit, blocked: used > limit, available: true };
  } catch (err) {
    return { used: 0, limit, blocked: false, available: false };
  }
}`,
      });
      expect(out.code).toBe(0);
    });

    it('a named failure state ({ status: "unavailable" })', () => {
      const out = run({
        'services/x.ts': `${PREAMBLE}
export async function resolve(id: number): Promise<unknown> {
  try {
    const r = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: id } }));
    return { status: 'resolved', value: r.Item?.name ?? null };
  } catch (err) {
    return { status: 'unavailable' };
  }
}`,
      });
      expect(out.code).toBe(0);
    });

    it('null counters where the success path never writes a literal null (householdUsage)', () => {
      const out = run({
        'services/usage.ts': `${PREAMBLE}
function asCount(v: unknown): number | null { return typeof v === 'number' ? v : null; }
export async function counters(id: string): Promise<unknown> {
  try {
    const r = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: id } }));
    return { plantCount: asCount(r.Item?.plantCount), memberCount: asCount(r.Item?.memberCount) };
  } catch (err) {
    return { plantCount: null, memberCount: null };
  }
}`,
      });
      expect(out.code).toBe(0);
    });

    it('a catch that ends in throw (ConditionalCheckFailed → null, everything else propagates)', () => {
      const out = run({
        'services/x.ts': `${PREAMBLE}
export async function bump(id: string): Promise<number | null> {
  try {
    const r = await dynamodb.send(new UpdateCommand({ TableName: TABLE_NAME, ReturnValues: 'ALL_NEW' }));
    return r.Attributes ? (r.Attributes.n as number) : null;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}`,
      });
      expect(out.code).toBe(0);
    });

    it('a swallowing catch that records the failure in state (the /health probe shape)', () => {
      const out = run({
        'handlers/health.ts': `${PREAMBLE}
export async function health(): Promise<string> {
  let database: 'ok' | 'error' = 'ok';
  try {
    await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: 'HEALTHCHECK' } }));
  } catch {
    database = 'error';
  }
  return database;
}`,
      });
      expect(out.code).toBe(0);
    });

    it('a defaulted variable that is thrown on rather than proceeded on', () => {
      const out = run({
        'services/x.ts': `${PREAMBLE}
export async function reconcile(id: string, err: Error): Promise<void> {
  let applied = false;
  try {
    const existing = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: id } }));
    applied = existing.Item?.status === 'applied';
  } catch {
    // preserve the original error
  }
  if (!applied) throw err;
}`,
      });
      expect(out.code).toBe(0);
    });

    it('writes: a failed PutCommand reported as false is not a read', () => {
      const out = run({
        'services/x.ts': `${PREAMBLE}
export async function reserve(id: string): Promise<boolean> {
  try {
    await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: { PK: id } }));
    return true;
  } catch (err) {
    return false;
  }
}`,
      });
      expect(out.code).toBe(0);
    });

    it('a .catch on a fire-and-forget write is not a read', () => {
      const out = run({
        'handlers/x.ts': `${PREAMBLE}
import { activity } from '../services/activity.js';
export function record(): void {
  activity.recordActivity({ type: 'x' }).catch((err) => {
    logger.warn({ err }, 'activity_record_failed');
  });
}`,
      });
      expect(out.code).toBe(0);
    });

    it('.catch(() => null) on a read whose chain never yields null on success', () => {
      const out = run({
        'services/x.ts': `${PREAMBLE}
export function getUsage(id: string): Promise<number | null> {
  return dynamodb
    .send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: id } }))
    .then((r) => (typeof r.Item?.used === 'number' ? r.Item.used : 0))
    .catch(() => null);
}`,
      });
      expect(out.code).toBe(0);
    });
  });

  describe('the ratchet', () => {
    const masked = {
      'services/budget.ts': `${PREAMBLE}
export async function getUsage(id: string): Promise<number> {
  try {
    const r = await dynamodb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: id } }));
    return (r.Item?.used as number) ?? 0;
  } catch (err) {
    return 0;
  }
}`,
    };

    it('passes when every finding is in the baseline', () => {
      const out = run(masked, {
        'services/budget.ts::getUsage::catch-returns-empty': 'test fixture',
      });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('1 accepted occurrences (baseline 1, ratchet-only)');
    });

    it('fails on a baseline entry that no longer matches anything (the list may only shrink)', () => {
      const out = run(
        { 'services/fine.ts': `${PREAMBLE}\nexport const x = 1;\n` },
        {
          'services/budget.ts::getUsage::catch-returns-empty':
            'fixed, but the entry was left behind',
        }
      );
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('no longer match anything');
      expect(out.stderr).toContain('services/budget.ts::getUsage::catch-returns-empty');
    });

    it('skips test files', () => {
      const out = run({ 'services/budget.test.ts': masked['services/budget.ts'] });
      expect(out.code).toBe(0);
    });
  });
});
