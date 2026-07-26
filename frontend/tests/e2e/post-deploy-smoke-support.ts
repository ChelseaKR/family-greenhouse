const EMAIL_TEMPLATE_TOKEN = '{tag}';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOUSEHOLD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUSEHOLD_MEMBERSHIP_PATTERN =
  /^HOUSEHOLD#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

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

/** Match the virtual-hosted and path-style Amazon S3 endpoints used by presigned PUTs. */
export function isAmazonS3Hostname(hostname: string): boolean {
  return (
    hostname === 's3.amazonaws.com' ||
    /(?:^|\.)s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/i.test(hostname)
  );
}

export interface SmokeS3ObjectTarget {
  bucket: string;
  key: string;
}

const S3_DATA_ENDPOINT_PATTERN = /^s3(?:[.-][a-z0-9.-]+)?\.amazonaws\.com$/i;
const S3_VIRTUAL_HOST_PATTERN = /^(.+)\.(s3(?:[.-][a-z0-9.-]+)?\.amazonaws\.com)$/i;
const S3_NON_DATA_ENDPOINT_PATTERN = /(?:^|[.-])(control|object-lambda|outposts)(?:[.-]|$)/i;
const S3_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function isS3DataEndpoint(hostname: string): boolean {
  return S3_DATA_ENDPOINT_PATTERN.test(hostname) && !S3_NON_DATA_ENDPOINT_PATTERN.test(hostname);
}

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
  if (isS3DataEndpoint(hostname)) {
    const separator = decodedPath.indexOf('/');
    if (separator <= 0) {
      throw new Error('Path-style presigned S3 URL did not contain a bucket and key');
    }
    return assertSafeS3Target(decodedPath.slice(0, separator), decodedPath.slice(separator + 1));
  }

  const virtualHosted = S3_VIRTUAL_HOST_PATTERN.exec(hostname);
  if (!virtualHosted || !isS3DataEndpoint(virtualHosted[2])) {
    throw new Error('Presigned upload URL did not target an Amazon S3 data endpoint');
  }
  return assertSafeS3Target(virtualHosted[1], decodedPath);
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
