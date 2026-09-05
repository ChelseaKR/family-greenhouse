#!/usr/bin/env node
/**
 * Remove post-deploy test fixtures from a DynamoDB table.
 *
 * ## The defect
 *
 * On 2026-09-04 the production table held 38 households. Thirty-five of them
 * were named "Smoke Test Household" and belonged to Cognito users that no
 * longer existed — debris from post-deploy smoke runs whose teardown never got
 * to execute. Cognito was clean (the smoke test's user deletion had run, or the
 * users were removed later); only the DynamoDB rows survived. Against two real
 * registered users, 92% of the household count was test debris, and nothing
 * anywhere excluded it. Every number the product could state about itself was
 * fiction.
 *
 * The teardown in `frontend/tests/e2e/post-deploy-smoke.spec.ts` is careful and
 * complete. It just cannot run when the job is skipped, the run is cancelled,
 * or the runner dies. This script is the cleanup that does not depend on the
 * run that made the mess finishing.
 *
 * ## How a fixture is identified
 *
 * Structurally, never by name. `isTestFixture` is written at creation by the
 * smoke test and by nothing else — no application code path writes it — so a
 * real household called "Smoke Test Household" can never be mistaken for one.
 * Matching the string would have been the obvious fix and would silently
 * delete that household's data the first time someone chose the name.
 *
 * Two markers, because one is not enough:
 *
 *   - The CLAIM row, `TESTFIXTURE#<runId> / METADATA`, written before the
 *     browser flow starts. It records the fixture's Cognito `sub`, so this
 *     script can find every household that sub joined through GSI1 even if the
 *     run died before any household was stamped.
 *   - The HOUSEHOLD stamp, written onto `HOUSEHOLD#<id> / METADATA` right
 *     after the API returns 201. This is what lets a metric, a query, or an
 *     operator exclude fixtures without running this script at all.
 *
 * ## Why a sweep and not a DynamoDB TTL
 *
 * The table has TTL enabled on `ttl`, and stamping fixture rows with one would
 * be less code. It was rejected: TTL deletes ROWS, and a fixture owns
 * PARTITIONS. Expiring the household METADATA row would leave its member rows,
 * plants, and activity events behind as a worse kind of debris — orphans with
 * no household — and rows created after the stamp would carry no TTL at all.
 * Partition-scoped deletion is the only shape that finishes the job.
 *
 * ## Safety
 *
 * Dry run by default: it prints what it would delete and exits 0 without
 * touching anything. `--apply` is required to delete, and then:
 *
 *   1. Only partitions reachable from a row carrying `isTestFixture: true`.
 *   2. Only fixtures older than `--min-age-hours` (default 3), so a sweep can
 *      never race a smoke run that is still executing.
 *   3. A household is SKIPPED, loudly, if it holds a member whose Cognito sub
 *      is not one of this sweep's fixture subs. A real person can then never
 *      lose data to it, whatever else goes wrong.
 *   4. Every key is re-checked against an allowed-prefix list immediately
 *      before the delete call.
 *   5. `--max-deletes` (default 500) refuses a plan that is larger than
 *      expected rather than executing a surprise.
 *   6. Claim rows are deleted LAST, and only once the partitions they index
 *      verify empty — while a claim survives, a partial sweep is recoverable.
 *
 * ## Legacy mode (`--include-legacy`)
 *
 * Rows created before the markers existed carry neither. They cannot be swept
 * safely by rule, so they are opt-in and need `--user-pool-id`. A legacy
 * household is proposed only when EVERY member row's Cognito user is gone from
 * the pool and the household is older than the age gate — evidence, not a name
 * match. The name is printed so it can be eyeballed, and nothing is deleted
 * without `--apply`.
 *
 * ## Usage
 *
 *   # what is in there (reads only)
 *   node scripts/sweep-test-fixtures.mjs --table family-greenhouse-production
 *
 *   # marked fixtures, older than 3h
 *   node scripts/sweep-test-fixtures.mjs --table family-greenhouse-production --apply
 *
 *   # the pre-marker backlog: review the dry run first, then re-run with --apply
 *   node scripts/sweep-test-fixtures.mjs --table family-greenhouse-production \
 *     --include-legacy --user-pool-id us-east-1_XXXXXXXXX
 *
 * Credentials come from the ambient environment (AWS_PROFILE locally, the OIDC
 * role in CI).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  DynamoDBClient,
  ScanCommand,
  QueryCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// The marker contract, and the assertion that it has not drifted
// ---------------------------------------------------------------------------

/**
 * These names are declared in `TEST_FIXTURE` in
 * `frontend/tests/e2e/post-deploy-smoke-support.ts`, which is what writes them.
 * This file is plain Node and that one is TypeScript compiled by Playwright, so
 * there is no import that could tie them together. Restating them here and
 * checking the other file still declares each one is the same shape
 * `frontend/scripts/public-routes.mjs` uses for the sitemap manifests: cheap,
 * and it fails loudly instead of silently sweeping nothing.
 */
const MARKER = {
  flag: 'isTestFixture',
  runId: 'testFixtureRunId',
  createdAt: 'testFixtureCreatedAt',
  source: 'testFixtureSource',
  partitionPrefix: 'TESTFIXTURE#',
};

const SUPPORT_MODULE = 'frontend/tests/e2e/post-deploy-smoke-support.ts';

function assertMarkerContract() {
  let source;
  try {
    source = readFileSync(join(ROOT, SUPPORT_MODULE), 'utf8');
  } catch {
    throw new Error(
      `${SUPPORT_MODULE} is missing. It is what writes the fixture markers this script deletes by; refusing to run without it.`
    );
  }
  const missing = Object.values(MARKER).filter((name) => !source.includes(`'${name}'`));
  if (missing.length > 0) {
    throw new Error(
      `${SUPPORT_MODULE} no longer declares ${missing.join(', ')}. ` +
        `The fixture marker contract has drifted; refusing to delete by a name the writer may not use.`
    );
  }
}

/**
 * Nothing outside these prefixes is ever deletable, whatever the rest of this
 * script concludes. Checked again immediately before each batch write.
 */
const DELETABLE_PREFIXES = ['USER#', 'HOUSEHOLD#', MARKER.partitionPrefix];

const HOUSEHOLD_PREFIX = 'HOUSEHOLD#';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    table: process.env.FIXTURE_SWEEP_TABLE ?? 'family-greenhouse-production',
    region: process.env.AWS_REGION ?? 'us-east-1',
    minAgeHours: 3,
    maxDeletes: 500,
    apply: false,
    includeLegacy: false,
    userPoolId: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };

    if (arg === '--table') options.table = value();
    else if (arg === '--region') options.region = value();
    else if (arg === '--min-age-hours') options.minAgeHours = Number(value());
    else if (arg === '--max-deletes') options.maxDeletes = Number(value());
    else if (arg === '--user-pool-id') options.userPoolId = value();
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--include-legacy') options.includeLegacy = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.table) throw new Error('--table is required');
  if (!Number.isFinite(options.minAgeHours) || options.minAgeHours < 0) {
    throw new Error('--min-age-hours must be a non-negative number');
  }
  if (!Number.isInteger(options.maxDeletes) || options.maxDeletes <= 0) {
    throw new Error('--max-deletes must be a positive integer');
  }
  if (options.includeLegacy && !options.userPoolId) {
    throw new Error(
      '--include-legacy needs --user-pool-id: a legacy fixture is proposed only when every member of the household is gone from that Cognito pool.'
    );
  }
  return options;
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

const str = (item, name) => item?.[name]?.S;

async function scanAll(ddb, input) {
  const items = [];
  let exclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({ ...input, ExclusiveStartKey: exclusiveStartKey })
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

async function queryAll(ddb, input) {
  const items = [];
  let exclusiveStartKey;
  do {
    const page = await ddb.send(
      new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey })
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

/** Every row in one partition, as {PK, SK, entityType, userId, name}. */
async function readPartition(ddb, table, partitionKey) {
  const items = await queryAll(ddb, {
    TableName: table,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': { S: partitionKey } },
    ProjectionExpression: 'PK, SK, entityType, userId, #n, createdAt',
    ExpressionAttributeNames: { '#n': 'name' },
    ConsistentRead: true,
  });
  return items.map((item) => ({
    PK: str(item, 'PK'),
    SK: str(item, 'SK'),
    entityType: str(item, 'entityType'),
    userId: str(item, 'userId'),
    name: str(item, 'name'),
    createdAt: str(item, 'createdAt'),
  }));
}

async function deletePartition(ddb, table, partitionKey, rows) {
  const offending = rows.filter(
    (row) =>
      row.PK !== partitionKey || !DELETABLE_PREFIXES.some((prefix) => row.PK.startsWith(prefix))
  );
  if (offending.length > 0) {
    throw new Error(
      `refusing to delete ${offending.length} row(s) outside ${partitionKey} or outside ${DELETABLE_PREFIXES.join('/')}`
    );
  }

  for (let offset = 0; offset < rows.length; offset += 25) {
    let pending = rows.slice(offset, offset + 25).map((row) => ({
      DeleteRequest: { Key: { PK: { S: row.PK }, SK: { S: row.SK } } },
    }));
    for (let attempt = 1; attempt <= 3 && pending.length > 0; attempt += 1) {
      const result = await ddb.send(
        new BatchWriteItemCommand({ RequestItems: { [table]: pending } })
      );
      pending = result.UnprocessedItems?.[table] ?? [];
      if (pending.length > 0 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 200));
      }
    }
    if (pending.length > 0) {
      throw new Error(`${pending.length} delete request(s) in ${partitionKey} stayed unprocessed`);
    }
  }

  const remaining = await readPartition(ddb, table, partitionKey);
  if (remaining.length > 0) {
    throw new Error(`${remaining.length} row(s) remained in ${partitionKey} after deletion`);
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Households the fixture's Cognito sub is a member of, via GSI1. */
async function householdsForSub(ddb, table, sub) {
  const items = await queryAll(ddb, {
    TableName: table,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': { S: `USER#${sub}` } },
    ProjectionExpression: 'GSI1SK',
  });
  const ids = [];
  for (const item of items) {
    const match = /^HOUSEHOLD#([0-9a-f-]{36})$/i.exec(str(item, 'GSI1SK') ?? '');
    if (match) ids.push(match[1]);
  }
  return ids;
}

async function cognitoSubExists(cognito, userPoolId, sub) {
  const result = await cognito.send(
    new ListUsersCommand({ UserPoolId: userPoolId, Filter: `sub = "${sub}"`, Limit: 1 })
  );
  return (result.Users?.length ?? 0) > 0;
}

/**
 * Build the sweep plan from the marker rows.
 *
 * Returns { targets, skipped, subs, claims } where a target is
 * { partitionKey, reason, ageHours, rows }.
 */
async function planMarkedSweep(ddb, options, cutoffMs) {
  // `name` is a DynamoDB reserved word, hence the #n alias.
  const marked = await scanAll(ddb, {
    TableName: options.table,
    FilterExpression: '#flag = :true',
    ExpressionAttributeNames: { '#flag': MARKER.flag, '#n': 'name' },
    ExpressionAttributeValues: { ':true': { BOOL: true } },
    ProjectionExpression: `PK, SK, entityType, cognitoSub, #n, ${MARKER.runId}, ${MARKER.createdAt}, ${MARKER.source}`,
  });

  /** claim partition key -> { sub, createdAt } */
  const claims = new Map();
  /** householdId -> createdAt of the marker */
  const stampedHouseholds = new Map();
  /** householdId -> Set of claim partition keys that index it. */
  const claimsByHousehold = new Map();
  const linkHousehold = (householdId, claimKey) => {
    if (!claimKey) return;
    if (!claimsByHousehold.has(householdId)) claimsByHousehold.set(householdId, new Set());
    claimsByHousehold.get(householdId).add(claimKey);
  };

  for (const item of marked) {
    const pk = str(item, 'PK') ?? '';
    const createdAt = str(item, MARKER.createdAt);
    if (pk.startsWith(MARKER.partitionPrefix)) {
      claims.set(pk, { sub: str(item, 'cognitoSub'), createdAt, partitionKey: pk });
    } else if (pk.startsWith(HOUSEHOLD_PREFIX) && str(item, 'SK') === 'METADATA') {
      const householdId = pk.slice(HOUSEHOLD_PREFIX.length);
      stampedHouseholds.set(householdId, createdAt);
      const runId = str(item, MARKER.runId);
      if (runId) linkHousehold(householdId, `${MARKER.partitionPrefix}${runId}`);
    }
  }

  const subs = new Map(); // sub -> createdAt of its claim
  const claimBySub = new Map();
  for (const claim of claims.values()) {
    if (!claim.sub) continue;
    subs.set(claim.sub, claim.createdAt);
    claimBySub.set(claim.sub, claim.partitionKey);
  }

  // Households reachable from a claim, even if the run died before stamping.
  const householdAge = new Map(stampedHouseholds);
  for (const [sub, createdAt] of subs) {
    for (const id of await householdsForSub(ddb, options.table, sub)) {
      if (!householdAge.has(id)) householdAge.set(id, createdAt);
      linkHousehold(id, claimBySub.get(sub));
    }
  }

  /**
   * Claims that must survive this sweep. A claim is the only thing that can
   * find its run's rows once the process that made them is gone, so deleting
   * one while anything it indexes is still there would strand that debris
   * permanently — the exact failure mode this whole script exists to undo.
   */
  const blockedClaims = new Map();
  const blockClaimsFor = (householdId, why) => {
    for (const claimKey of claimsByHousehold.get(householdId) ?? []) {
      if (!blockedClaims.has(claimKey)) blockedClaims.set(claimKey, why);
    }
  };

  const ageHours = (iso) => {
    const at = Date.parse(iso ?? '');
    return Number.isNaN(at) ? null : (Date.now() - at) / 3_600_000;
  };

  const targets = [];
  const skipped = [];

  for (const [householdId, createdAt] of householdAge) {
    const partitionKey = `${HOUSEHOLD_PREFIX}${householdId}`;
    const age = ageHours(createdAt);
    if (age === null) {
      const why = `no readable ${MARKER.createdAt}`;
      skipped.push({ partitionKey, why });
      blockClaimsFor(householdId, why);
      continue;
    }
    if (Date.parse(createdAt) > cutoffMs) {
      const why = `only ${age.toFixed(1)}h old (< ${options.minAgeHours}h)`;
      skipped.push({ partitionKey, why });
      blockClaimsFor(householdId, why);
      continue;
    }

    const rows = await readPartition(ddb, options.table, partitionKey);
    // The guard that makes this unable to touch a real person's data: every
    // member of a fixture household must be a fixture.
    const outsiders = rows
      .filter((row) => row.entityType === 'HouseholdMember')
      .map((row) => row.userId)
      .filter((userId) => userId && !subs.has(userId));
    if (outsiders.length > 0) {
      const why = `${outsiders.length} member(s) are not fixture users — a real account may have joined it`;
      skipped.push({ partitionKey, why });
      blockClaimsFor(householdId, why);
      continue;
    }

    targets.push({ partitionKey, reason: 'marked fixture household', ageHours: age, rows });
  }

  for (const [sub, createdAt] of subs) {
    const partitionKey = `USER#${sub}`;
    if (Date.parse(createdAt) > cutoffMs) continue;
    const rows = await readPartition(ddb, options.table, partitionKey);
    if (rows.length === 0) continue;
    targets.push({
      partitionKey,
      reason: 'marked fixture user rows',
      ageHours: ageHours(createdAt),
      rows,
    });
  }

  return { targets, skipped, claims, subs, blockedClaims };
}

/**
 * Pre-marker debris. Opt-in, evidence-based, never name-based: a household
 * qualifies only when it has members and NONE of them still exist in Cognito.
 */
async function planLegacySweep(ddb, cognito, options, cutoffMs, alreadyTargeted) {
  const households = await scanAll(ddb, {
    TableName: options.table,
    FilterExpression: 'begins_with(PK, :p) AND SK = :s AND attribute_not_exists(#flag)',
    ExpressionAttributeNames: { '#flag': MARKER.flag, '#n': 'name' },
    ExpressionAttributeValues: { ':p': { S: HOUSEHOLD_PREFIX }, ':s': { S: 'METADATA' } },
    ProjectionExpression: 'PK, SK, #n, createdAt',
  });

  const targets = [];
  const skipped = [];
  const liveSubs = new Map();

  for (const item of households) {
    const partitionKey = str(item, 'PK') ?? '';
    if (alreadyTargeted.has(partitionKey)) continue;
    const createdAt = str(item, 'createdAt');
    const name = str(item, 'name') ?? '<unnamed>';

    if (!createdAt || Date.parse(createdAt) > cutoffMs) {
      skipped.push({
        partitionKey,
        why: `created ${createdAt ?? 'unknown'} — inside the age gate`,
      });
      continue;
    }

    const rows = await readPartition(ddb, options.table, partitionKey);
    const memberSubs = rows
      .filter((row) => row.entityType === 'HouseholdMember')
      .map((row) => row.userId)
      .filter(Boolean);

    if (memberSubs.length === 0) {
      skipped.push({
        partitionKey,
        why: 'no member rows — cannot prove it is abandoned, so not proposed',
      });
      continue;
    }

    const surviving = [];
    for (const sub of memberSubs) {
      if (!liveSubs.has(sub)) {
        liveSubs.set(sub, await cognitoSubExists(cognito, options.userPoolId, sub));
      }
      if (liveSubs.get(sub)) surviving.push(sub);
    }

    if (surviving.length > 0) {
      skipped.push({
        partitionKey,
        why: `${surviving.length} of ${memberSubs.length} member(s) still exist in Cognito — this is a real household`,
      });
      continue;
    }

    targets.push({
      partitionKey,
      reason: `legacy: named "${name}", created ${createdAt}, all ${memberSubs.length} member(s) gone from Cognito`,
      ageHours: (Date.now() - Date.parse(createdAt)) / 3_600_000,
      rows,
    });
  }

  return { targets, skipped };
}

// ---------------------------------------------------------------------------
// Report + run
// ---------------------------------------------------------------------------

function report(title, targets, skipped) {
  const rowCount = targets.reduce((total, target) => total + target.rows.length, 0);
  console.log(`\n${title}: ${targets.length} partition(s), ${rowCount} row(s)`);
  for (const target of targets) {
    console.log(
      `  ${target.partitionKey}  (${target.rows.length} row(s), ${target.ageHours === null ? 'age unknown' : `${target.ageHours.toFixed(1)}h old`})`
    );
    console.log(`      ${target.reason}`);
    for (const row of target.rows.slice(0, 6)) console.log(`      - ${row.SK}`);
    if (target.rows.length > 6) console.log(`      - … ${target.rows.length - 6} more`);
  }
  for (const entry of skipped) {
    console.log(`  SKIP ${entry.partitionKey}: ${entry.why}`);
  }
  return rowCount;
}

export async function main(argv) {
  const options = parseArgs(argv);
  assertMarkerContract();

  const ddb = new DynamoDBClient({ region: options.region });
  const cutoffMs = Date.now() - options.minAgeHours * 3_600_000;

  console.log(
    `Table ${options.table} (${options.region}); fixtures older than ${options.minAgeHours}h; ` +
      `${options.apply ? 'APPLY — rows will be deleted' : 'DRY RUN — nothing will be deleted'}`
  );

  const marked = await planMarkedSweep(ddb, options, cutoffMs);
  let rowCount = report('Marked fixtures', marked.targets, marked.skipped);
  const targets = [...marked.targets];

  if (options.includeLegacy) {
    const cognito = new CognitoIdentityProviderClient({ region: options.region });
    const targeted = new Set(targets.map((target) => target.partitionKey));
    const legacy = await planLegacySweep(ddb, cognito, options, cutoffMs, targeted);
    rowCount += report('Legacy (pre-marker) fixtures', legacy.targets, legacy.skipped);
    targets.push(...legacy.targets);
  } else {
    console.log(
      '\nLegacy (pre-marker) fixtures: not examined. Pass --include-legacy --user-pool-id <id> to review them.'
    );
  }

  // Claim rows last, and never one whose targets were skipped: while a claim
  // exists, whatever it indexes is still findable, and that is the only thing
  // standing between a skipped partition and permanently unattributable debris.
  const claimTargets = [];
  for (const claim of marked.claims.values()) {
    if (Date.parse(claim.createdAt ?? '') > cutoffMs) continue;
    const blockedBecause = marked.blockedClaims.get(claim.partitionKey);
    if (blockedBecause) {
      console.log(
        `  KEEP ${claim.partitionKey}: still indexes a skipped partition (${blockedBecause})`
      );
      continue;
    }
    const rows = await readPartition(ddb, options.table, claim.partitionKey);
    if (rows.length > 0) claimTargets.push({ partitionKey: claim.partitionKey, rows });
  }
  rowCount += claimTargets.reduce((total, target) => total + target.rows.length, 0);

  if (targets.length === 0 && claimTargets.length === 0) {
    console.log('\nNothing to sweep.');
    return 0;
  }

  if (rowCount > options.maxDeletes) {
    console.error(
      `\nRefusing to act: the plan covers ${rowCount} rows, above --max-deletes ${options.maxDeletes}. ` +
        'Re-read the plan above; raise the cap deliberately if it is right.'
    );
    return 1;
  }

  if (!options.apply) {
    console.log(
      `\nDRY RUN. ${rowCount} row(s) across ${targets.length + claimTargets.length} partition(s) would be deleted. ` +
        'Re-run with --apply to act.'
    );
    return 0;
  }

  for (const target of targets) {
    await deletePartition(ddb, options.table, target.partitionKey, target.rows);
    console.log(`deleted ${target.rows.length} row(s) from ${target.partitionKey}`);
  }
  for (const target of claimTargets) {
    await deletePartition(ddb, options.table, target.partitionKey, target.rows);
    console.log(`deleted claim ${target.partitionKey}`);
  }

  console.log(`\nSwept ${rowCount} row(s).`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
