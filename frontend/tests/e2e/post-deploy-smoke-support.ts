const EMAIL_TEMPLATE_TOKEN = '{tag}';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOUSEHOLD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUSEHOLD_MEMBERSHIP_PATTERN =
  /^HOUSEHOLD#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How a smoke fixture is identified in DynamoDB — STRUCTURALLY, by an attribute
 * written at creation, never by matching a name.
 *
 * The defect this exists for: production held 38 households, 35 of them called
 * "Smoke Test Household", left behind by runs whose teardown never got to
 * execute. Nothing anywhere excluded them, so every count of "how many
 * households does this product have" was 92% test debris. The obvious fix —
 * match the string "Smoke Test Household" — breaks the day someone names their
 * home that, and it silently deletes their data when it does. An attribute the
 * application never writes cannot be collided with.
 *
 * `scripts/sweep-test-fixtures.mjs` reads these same names. It asserts on
 * startup that this file still declares every one of them, so the two cannot
 * drift apart without the sweeper refusing to run.
 */
export const TEST_FIXTURE = {
  /** Present and `true` only on rows a test fixture created. */
  flag: 'isTestFixture',
  /** The run that created the row, so one run's debris is separable. */
  runId: 'testFixtureRunId',
  /** ISO 8601. The sweeper's age gate reads this, not the row's own createdAt. */
  createdAt: 'testFixtureCreatedAt',
  /** Which harness made it, so a second fixture source is distinguishable. */
  source: 'testFixtureSource',
  /** Value written by the post-deploy smoke test. */
  sourceValue: 'post-deploy-smoke',
  /** Partition prefix of the claim row. */
  partitionPrefix: 'TESTFIXTURE#',
  entityType: 'TestFixtureRun',
} as const;

/**
 * A claim row: one per smoke run, written BEFORE the browser flow starts.
 *
 * This is the part that survives a run that dies. Stamping the household row
 * is not enough on its own, because a run can be killed between "POST
 * /households returned 201" and "the stamp landed" — and a killed run is
 * exactly the case that leaked the 35. The claim row is written while the only
 * thing that exists is the Cognito user, and it records that user's `sub`, so
 * the sweeper can find every household the fixture ever joined through GSI1
 * even if no household row was ever stamped.
 *
 * It carries no `ttl` deliberately. A TTL would let DynamoDB delete the claim
 * before a sweep ran and strand the debris it points at, with nothing left to
 * find it by. The sweeper deletes the claim last, after the rows it indexes.
 */
export interface TestFixtureClaim {
  PK: string;
  SK: 'METADATA';
  entityType: string;
  isTestFixture: true;
  testFixtureRunId: string;
  testFixtureCreatedAt: string;
  testFixtureSource: string;
  /** Cognito `sub` — an opaque id, never an email or any other identifier. */
  cognitoSub: string;
  /** Cognito service Username, which is a separate contract from `sub`. */
  cognitoUsername: string;
}

/** Partition key of a run's claim row. */
export function testFixtureClaimPartition(runId: string): string {
  if (!UUID_PATTERN.test(runId)) {
    throw new Error('Test fixture run id must be a UUID');
  }
  return `${TEST_FIXTURE.partitionPrefix}${runId}`;
}

/** Build the claim row for one smoke run. */
export function buildTestFixtureClaim(input: {
  runId: string;
  createdAt: string;
  cognitoSub: string;
  cognitoUsername: string;
}): TestFixtureClaim {
  if (!input.cognitoSub || !input.cognitoUsername) {
    throw new Error('Test fixture claim needs both a Cognito sub and username');
  }
  if (Number.isNaN(Date.parse(input.createdAt))) {
    throw new Error('Test fixture claim needs an ISO 8601 createdAt');
  }
  return {
    PK: testFixtureClaimPartition(input.runId),
    SK: 'METADATA',
    entityType: TEST_FIXTURE.entityType,
    isTestFixture: true,
    testFixtureRunId: input.runId,
    testFixtureCreatedAt: input.createdAt,
    testFixtureSource: TEST_FIXTURE.sourceValue,
    cognitoSub: input.cognitoSub,
    cognitoUsername: input.cognitoUsername,
  };
}

/**
 * The `UpdateItem` arguments that stamp an already-created household row as a
 * fixture. Separate from the claim row because the household is created by the
 * real API through the real UI — the test only learns its id from the 201.
 *
 * `attribute_exists(PK)` so a stamp can never CREATE a row: if the household is
 * not there, that is a failure to report, not a row to invent.
 */
export function buildHouseholdFixtureStamp(input: {
  householdId: string;
  runId: string;
  createdAt: string;
}): {
  Key: { PK: string; SK: string };
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, { S: string } | { BOOL: boolean }>;
} {
  if (!HOUSEHOLD_ID_PATTERN.test(input.householdId)) {
    throw new Error('Household fixture stamp needs a household UUID');
  }
  if (!UUID_PATTERN.test(input.runId)) {
    throw new Error('Household fixture stamp needs a run id UUID');
  }
  return {
    Key: { PK: `HOUSEHOLD#${input.householdId}`, SK: 'METADATA' },
    UpdateExpression: 'SET #flag = :flag, #run = :run, #at = :at, #src = :src',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: {
      '#flag': TEST_FIXTURE.flag,
      '#run': TEST_FIXTURE.runId,
      '#at': TEST_FIXTURE.createdAt,
      '#src': TEST_FIXTURE.source,
    },
    ExpressionAttributeValues: {
      ':flag': { BOOL: true },
      ':run': { S: input.runId },
      ':at': { S: input.createdAt },
      ':src': { S: TEST_FIXTURE.sourceValue },
    },
  };
}

/**
 * Build a unique address from an operator-configured, deliverable mailbox
 * template such as `fg-smoke+{tag}@example.com`. Requiring the placeholder
 * avoids reusing/deleting a real account, while requiring configuration keeps
 * the smoke test from inventing recipients that hard-bounce.
 */
export function buildSmokeEmail(template: string | undefined, tag: string): string {
  if (!template) {
    throw new Error(
      'E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE is required (for example, fg-smoke+{tag}@example.com)'
    );
  }
  if (template.trim() !== template) {
    throw new Error('E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE must not contain surrounding whitespace');
  }
  if (!/^[a-z0-9-]{1,48}$/i.test(tag)) {
    throw new Error('Smoke email tag must contain only 1-48 letters, numbers, or hyphens');
  }

  const tokenCount = template.split(EMAIL_TEMPLATE_TOKEN).length - 1;
  const at = template.lastIndexOf('@');
  if (tokenCount !== 1 || template.indexOf(EMAIL_TEMPLATE_TOKEN) > at) {
    throw new Error(
      'E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE must contain exactly one {tag} placeholder before @'
    );
  }

  const email = template.replace(EMAIL_TEMPLATE_TOKEN, tag);
  const [localPart] = email.split('@');
  if (!EMAIL_PATTERN.test(email) || email.length > 254 || localPart.length > 64) {
    throw new Error('E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE produced an invalid email address');
  }
  return email;
}

/** Membership rows store the household lookup key in GSI1SK, not SK. */
export function householdIdFromMembershipItem(item: Record<string, unknown>): string | null {
  const attribute = item['GSI1SK'];
  const value =
    typeof attribute === 'object' &&
    attribute !== null &&
    'S' in attribute &&
    typeof attribute.S === 'string'
      ? attribute.S
      : '';
  const match = HOUSEHOLD_MEMBERSHIP_PATTERN.exec(value);
  return match?.[1] ?? null;
}

/** Validate the authoritative id returned by POST /households. */
export function householdIdFromCreateResponse(response: unknown): string {
  const id =
    typeof response === 'object' &&
    response !== null &&
    'id' in response &&
    typeof response.id === 'string'
      ? response.id
      : '';
  if (!HOUSEHOLD_ID_PATTERN.test(id)) {
    throw new Error('POST /households did not return a valid household UUID');
  }
  return id;
}

export interface CleanupStep {
  label: string;
  run: () => Promise<void>;
}

/** Attempt every cleanup branch, then fail once with all observed errors. */
export async function runAllCleanupSteps(steps: CleanupStep[]): Promise<void> {
  const failures: Error[] = [];

  for (const step of steps) {
    try {
      await step.run();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      failures.push(new Error(`${step.label}: ${detail}`, { cause }));
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Post-deploy smoke cleanup failed in ${failures.length} step(s): ${failures
        .map((failure) => failure.message)
        .join('; ')}`
    );
  }
}

export interface SafeResponseDiagnostic {
  hostname: string;
  status: number;
}

/**
 * Reduce a response to fields that are safe to include in smoke failures.
 *
 * In particular, never include a pathname, query string, or full URL here:
 * presigned S3 PUT URLs carry credentials in their query parameters.
 */
export function safeResponseDiagnostic(rawUrl: string, status: number): SafeResponseDiagnostic {
  let hostname = '<invalid-url>';
  try {
    hostname = new URL(rawUrl).hostname || '<invalid-url>';
  } catch {
    // Keep the diagnostic useful without echoing attacker-controlled input.
  }
  return { hostname, status };
}

const AMAZONAWS_HOST_SUFFIX = '.amazonaws.com';
const S3_NON_DATA_LABELS = new Set(['control', 'object-lambda', 'outposts']);
const S3_NON_DATA_SERVICE_PREFIXES = ['s3-control', 's3-object-lambda', 's3-outposts'];

function isAsciiDnsLabel(label: string): boolean {
  if (!label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) return false;
  for (const character of label) {
    const code = character.charCodeAt(0);
    const isLowercaseLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isLowercaseLetter && !isDigit && character !== '-') return false;
  }
  return true;
}

function isS3ServiceLabel(label: string): boolean {
  if (label === 's3') return true;
  if (!label.startsWith('s3-') || label.length === 3) return false;
  return !S3_NON_DATA_SERVICE_PREFIXES.some(
    (prefix) => label === prefix || label.startsWith(`${prefix}-`)
  );
}

/**
 * Return the label where an S3 data endpoint begins. Scanning labels keeps
 * validation linear-time and avoids backtracking on attacker-controlled hosts.
 */
function s3DataEndpointLabelIndex(hostname: string): number {
  const normalized = hostname.toLowerCase();
  if (!normalized.endsWith(AMAZONAWS_HOST_SUFFIX)) return -1;

  const prefix = normalized.slice(0, -AMAZONAWS_HOST_SUFFIX.length);
  const labels = prefix.split('.');
  if (labels.some((label) => !isAsciiDnsLabel(label))) return -1;

  for (let index = labels.length - 1; index >= 0; index -= 1) {
    if (!isS3ServiceLabel(labels[index])) continue;
    if (labels.slice(index + 1).some((label) => S3_NON_DATA_LABELS.has(label))) continue;
    return index;
  }
  return -1;
}

/** Match the virtual-hosted and path-style Amazon S3 endpoints used by presigned PUTs. */
export function isAmazonS3Hostname(hostname: string): boolean {
  return s3DataEndpointLabelIndex(hostname) >= 0;
}

export interface SmokeS3ObjectTarget {
  bucket: string;
  key: string;
}

const S3_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function decodeS3Path(pathname: string): string {
  try {
    return decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    throw new Error('Presigned S3 URL contained an invalid encoded path');
  }
}

function assertSafeS3Target(bucket: string, key: string): SmokeS3ObjectTarget {
  if (
    !S3_BUCKET_PATTERN.test(bucket) ||
    bucket.includes('..') ||
    bucket.includes('.-') ||
    bucket.includes('-.')
  ) {
    throw new Error('Presigned S3 URL did not contain a valid bucket');
  }
  if (!key || key.includes('\0')) {
    throw new Error('Presigned S3 URL did not contain an object key');
  }
  return { bucket, key };
}

/**
 * Extract the exact bucket/key from either URL shape emitted by S3:
 *
 *   https://bucket.s3.region.amazonaws.com/key
 *   https://s3.region.amazonaws.com/bucket/key
 *
 * Errors intentionally never echo the input because its query string carries
 * temporary AWS credentials.
 */
export function s3ObjectTargetFromPresignedUrl(rawUrl: string): SmokeS3ObjectTarget {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Presigned S3 upload URL was invalid');
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Presigned S3 upload URL was not a safe HTTPS URL');
  }

  const hostname = url.hostname.toLowerCase();
  const decodedPath = decodeS3Path(url.pathname);
  const endpointLabelIndex = s3DataEndpointLabelIndex(hostname);
  if (endpointLabelIndex === 0) {
    const separator = decodedPath.indexOf('/');
    if (separator <= 0) {
      throw new Error('Path-style presigned S3 URL did not contain a bucket and key');
    }
    return assertSafeS3Target(decodedPath.slice(0, separator), decodedPath.slice(separator + 1));
  }

  if (endpointLabelIndex < 1) {
    throw new Error('Presigned upload URL did not target an Amazon S3 data endpoint');
  }
  const hostPrefix = hostname.slice(0, -AMAZONAWS_HOST_SUFFIX.length);
  const bucket = hostPrefix.split('.').slice(0, endpointLabelIndex).join('.');
  return assertSafeS3Target(bucket, decodedPath);
}

export interface SmokeS3VersionIdentifier {
  key: string;
  versionId: string;
}

export interface SmokeS3VersionPage {
  versions?: Array<{ key?: string; versionId?: string }>;
  deleteMarkers?: Array<{ key?: string; versionId?: string }>;
  isTruncated?: boolean;
  nextKeyMarker?: string;
  nextVersionIdMarker?: string;
}

export interface SmokeS3VersionStore {
  listVersions: (input: {
    bucket: string;
    prefix: string;
    keyMarker?: string;
    versionIdMarker?: string;
  }) => Promise<SmokeS3VersionPage>;
  deleteVersions: (input: { bucket: string; objects: SmokeS3VersionIdentifier[] }) => Promise<void>;
}

async function listExactSmokeS3Versions(
  target: SmokeS3ObjectTarget,
  store: SmokeS3VersionStore
): Promise<SmokeS3VersionIdentifier[]> {
  const found = new Map<string, SmokeS3VersionIdentifier>();
  const seenMarkers = new Set<string>();
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  do {
    const page = await store.listVersions({
      bucket: target.bucket,
      prefix: target.key,
      keyMarker,
      versionIdMarker,
    });
    for (const candidate of [...(page.versions ?? []), ...(page.deleteMarkers ?? [])]) {
      if (candidate.key !== target.key) continue;
      if (!candidate.versionId) {
        throw new Error('Exact S3 cleanup found a record without a version id');
      }
      found.set(candidate.versionId, {
        key: target.key,
        versionId: candidate.versionId,
      });
    }

    if (!page.isTruncated) break;
    if (!page.nextKeyMarker) {
      throw new Error('Exact S3 cleanup received a truncated page without a continuation marker');
    }
    const markerFingerprint = `${page.nextKeyMarker}\0${page.nextVersionIdMarker ?? ''}`;
    if (seenMarkers.has(markerFingerprint)) {
      throw new Error('Exact S3 cleanup received a repeated continuation marker');
    }
    seenMarkers.add(markerFingerprint);
    keyMarker = page.nextKeyMarker;
    versionIdMarker = page.nextVersionIdMarker;
  } while (true);

  return [...found.values()];
}

/**
 * Permanently remove every Version and DeleteMarker for one exact presigned
 * object, then re-enumerate it as a teardown invariant.
 *
 * An undefined target means the flow failed before presign; no AWS call is
 * made. This function never broadens cleanup to a plant or household prefix.
 */
export async function purgeExactSmokeS3Object(
  target: SmokeS3ObjectTarget | undefined,
  store: SmokeS3VersionStore
): Promise<void> {
  if (!target) return;

  const versions = await listExactSmokeS3Versions(target, store);
  for (let offset = 0; offset < versions.length; offset += 1000) {
    await store.deleteVersions({
      bucket: target.bucket,
      objects: versions.slice(offset, offset + 1000),
    });
  }

  const remaining = await listExactSmokeS3Versions(target, store);
  if (remaining.length > 0) {
    throw new Error(`${remaining.length} exact S3 version record(s) remained after cleanup`);
  }
}

export interface SmokeDynamoKey {
  PK: string;
  SK: string;
}

export interface SmokePartitionStore {
  listKeys: (partitionKey: string) => Promise<SmokeDynamoKey[]>;
  deleteKeys: (keys: SmokeDynamoKey[]) => Promise<void>;
}

/**
 * Purge every row in each partition owned by a smoke fixture, then query the
 * partitions again as a teardown invariant.
 *
 * Cleanup intentionally owns partition boundaries instead of enumerating
 * current entity types. The authenticated smoke creates both household rows
 * and user-scoped delivery markers (including WELCOME#FIRST_HOUSEHOLD), and
 * future marker types must not require another hand-maintained delete list.
 */
export async function purgeSmokeOwnedPartitions(
  partitionKeys: string[],
  store: SmokePartitionStore
): Promise<void> {
  const uniquePartitionKeys = [...new Set(partitionKeys)];

  await runAllCleanupSteps(
    uniquePartitionKeys.map((partitionKey) => ({
      label: `DynamoDB partition ${partitionKey}`,
      run: async () => {
        const keys = await store.listKeys(partitionKey);
        const mismatched = keys.filter((key) => key.PK !== partitionKey);
        if (mismatched.length > 0) {
          throw new Error(
            `partition query returned ${mismatched.length} row(s) owned by another partition`
          );
        }

        if (keys.length > 0) {
          await store.deleteKeys(keys);
        }

        const remaining = await store.listKeys(partitionKey);
        if (remaining.length > 0) {
          throw new Error(
            `${remaining.length} row(s) remained after cleanup: ${remaining
              .slice(0, 5)
              .map((key) => `${key.PK}/${key.SK}`)
              .join(', ')}`
          );
        }
      },
    }))
  );
}
