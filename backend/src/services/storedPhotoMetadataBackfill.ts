/**
 * Backfill: remove location metadata from plant photos that are ALREADY in the
 * images bucket. `services/photoMetadata.ts` explains why stored photos can
 * carry it, and #849 stops new uploads from bringing it in. The operator
 * entrypoint is `scripts/stripStoredPhotoMetadata.ts`, and the runbook entry
 * is "Strip location metadata from stored photos" in docs/runbooks.md.
 *
 * ## What it does
 *
 * It lists EVERY version under `plants/` and `trash/plants/` (a trashed
 * plant's photos can be restored, so they count), reads each one, and inspects
 * its metadata. A dry run stops there and reports counts.
 *
 * With `apply`, each CURRENT version that carries location (or, with
 * `allMetadata`, any metadata) is rewritten in place under the same key:
 *
 * - The image data is copied byte for byte and never re-encoded. A JPEG keeps
 *   its orientation.
 * - The rewrite keeps the object's Content-Type, Cache-Control and user
 *   metadata (sitter photos carry `via-sitter` / `sitter-link-id`).
 * - The PUT is conditional on the ETag that was read (`If-Match`). An object
 *   that a live request replaced, deleted or moved to the trash in between is
 *   left alone and counted as `raced`, so the backfill can never bring back a
 *   photo someone deleted. Re-running picks up whatever raced.
 * - The rewritten object is inspected again before the write. Bytes that still
 *   carry what was meant to go are never written.
 *
 * ## Old versions
 *
 * The production bucket is versioned, so a rewrite leaves the ORIGINAL bytes
 * behind as a noncurrent version. CloudFront can't reach it: the OAC grant is
 * `s3:GetObject` only, a specific version needs `s3:GetObjectVersion`, and the
 * `/plants/*` cache policy forwards no query string, so a viewer can't ask
 * for one. The bucket's `expire-noncurrent-versions` rule deletes it 30 days
 * after it became noncurrent. Until then, anyone in the AWS account with
 * `s3:GetObjectVersion` can still read it. `deleteOldVersions` deletes those
 * versions now, and the replaced version too, but only after its replacement
 * is written. That can't be undone, so it is a separate switch from `apply`.
 *
 * ## What it never does
 *
 * It never logs or returns a coordinate, a place name, a camera model or an
 * object key. Keys matter here: CloudFront serves `/plants/*` without a
 * signature, so a key is a working link to the photo. Findings name an object
 * by the first 8 characters of its file name.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  PhotoMetadataError,
  carriesLocation,
  carriesMetadata,
  inspectPhotoMetadata,
  stripPhotoMetadata,
  type PhotoMetadataReport,
} from './photoMetadata.js';

/** Every prefix a plant photo can live under. */
export const PHOTO_PREFIXES = ['plants/', 'trash/plants/'] as const;

export interface BackfillOptions {
  /** Write stripped current versions. False = dry run: reads only. */
  apply: boolean;
  /** Also delete versions holding location metadata. Needs `apply`. */
  deleteOldVersions: boolean;
  /** Target any metadata, not only location. */
  allMetadata: boolean;
  prefixes?: readonly string[];
}

export type Outcome =
  /** Nothing targeted in it. */
  | 'clean'
  /** Dry run: would be rewritten. */
  | 'would-strip'
  /** Rewritten and verified. */
  | 'stripped'
  /** Changed or gone between read and write; left alone. Re-run. */
  | 'raced'
  /** Could not be inspected or stripped; left alone. See `reason`. */
  | 'skipped'
  /** A noncurrent version holding targeted metadata (dry run or no delete). */
  | 'old-version-kept'
  /** A noncurrent version holding targeted metadata, deleted. */
  | 'old-version-deleted';

export interface Finding {
  /** First 8 characters of the file name. Never the key. */
  ref: string;
  prefix: string;
  current: boolean;
  outcome: Outcome;
  reason?: string;
  /** Booleans only (plus orientation), for the targeted versions. */
  report?: PhotoMetadataReport;
}

export interface BackfillReport {
  apply: boolean;
  deleteOldVersions: boolean;
  allMetadata: boolean;
  currentScanned: number;
  noncurrentScanned: number;
  /** Current versions carrying location metadata when read. */
  currentWithLocation: number;
  /** Noncurrent versions carrying location metadata when read. */
  noncurrentWithLocation: number;
  /** Current versions carrying any metadata the strip removes. */
  currentWithAnyMetadata: number;
  wouldStrip: number;
  stripped: number;
  raced: number;
  skipped: number;
  oldVersionsDeleted: number;
  /** Noncurrent versions still holding targeted metadata after this run. */
  oldVersionsRemaining: number;
  /** A stripped object under `plants/`, which CloudFront may have cached. */
  cdnInvalidationNeeded: boolean;
  findings: Finding[];
}

/** First 8 characters of the object's file name: enough to tell objects apart. */
export function objectRef(key: string): string {
  return (key.split('/').pop() ?? '').slice(0, 8);
}

interface ListedVersion {
  key: string;
  versionId: string;
  isLatest: boolean;
}

async function listVersions(s3: S3Client, bucket: string, prefix: string) {
  const versions: ListedVersion[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      })
    );
    for (const version of page.Versions ?? []) {
      if (!version.Key || !version.Key.startsWith(prefix)) continue;
      versions.push({
        key: version.Key,
        // An unversioned bucket (local dev, a suspended staging bucket)
        // reports the literal version id "null".
        versionId: version.VersionId ?? 'null',
        isLatest: version.IsLatest === true,
      });
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);
  return versions;
}

/** A conditional write lost to a live request, or the object is gone. */
function isRace(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  return (
    e?.name === 'PreconditionFailed' ||
    e?.name === 'ConditionalRequestConflict' ||
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    status === 412 ||
    status === 409 ||
    status === 404
  );
}

function emptyReport(options: BackfillOptions): BackfillReport {
  return {
    apply: options.apply,
    deleteOldVersions: options.apply && options.deleteOldVersions,
    allMetadata: options.allMetadata,
    currentScanned: 0,
    noncurrentScanned: 0,
    currentWithLocation: 0,
    noncurrentWithLocation: 0,
    currentWithAnyMetadata: 0,
    wouldStrip: 0,
    stripped: 0,
    raced: 0,
    skipped: 0,
    oldVersionsDeleted: 0,
    oldVersionsRemaining: 0,
    cdnInvalidationNeeded: false,
    findings: [],
  };
}

/**
 * Run the backfill over one bucket. Reads everything; writes only with
 * `apply`; deletes versions only with `apply` AND `deleteOldVersions`.
 */
export async function runPhotoMetadataBackfill(
  s3: S3Client,
  bucket: string,
  options: BackfillOptions
): Promise<BackfillReport> {
  const report = emptyReport(options);
  const deleting = report.deleteOldVersions;
  const targets = (inspected: PhotoMetadataReport) =>
    options.allMetadata ? carriesMetadata(inspected) : carriesLocation(inspected);

  for (const prefix of options.prefixes ?? PHOTO_PREFIXES) {
    for (const version of await listVersions(s3, bucket, prefix)) {
      const ref = objectRef(version.key);
      const base = { ref, prefix, current: version.isLatest };
      if (version.isLatest) report.currentScanned += 1;
      else report.noncurrentScanned += 1;

      let got;
      try {
        got = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: version.key, VersionId: version.versionId })
        );
      } catch (err) {
        if (isRace(err)) {
          // Deleted by the lifecycle rule or a live request since the listing.
          if (version.isLatest) report.raced += 1;
          report.findings.push({ ...base, outcome: 'raced', reason: 'gone before it was read' });
          continue;
        }
        throw err;
      }
      const bytes = await got.Body!.transformToByteArray();

      let inspected: PhotoMetadataReport;
      try {
        inspected = inspectPhotoMetadata(bytes);
      } catch (err) {
        if (!(err instanceof PhotoMetadataError)) throw err;
        report.skipped += 1;
        report.findings.push({ ...base, outcome: 'skipped', reason: err.message });
        continue;
      }
      if (carriesLocation(inspected)) {
        if (version.isLatest) report.currentWithLocation += 1;
        else report.noncurrentWithLocation += 1;
      }
      if (version.isLatest && carriesMetadata(inspected)) report.currentWithAnyMetadata += 1;

      if (!targets(inspected)) {
        report.findings.push({ ...base, outcome: 'clean' });
        continue;
      }

      // A noncurrent version can't be rewritten, only deleted.
      if (!version.isLatest) {
        if (deleting) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: version.key,
              VersionId: version.versionId,
            })
          );
          report.oldVersionsDeleted += 1;
          report.findings.push({ ...base, outcome: 'old-version-deleted', report: inspected });
        } else {
          report.oldVersionsRemaining += 1;
          report.findings.push({ ...base, outcome: 'old-version-kept', report: inspected });
        }
        continue;
      }

      let stripped: Uint8Array;
      try {
        stripped = stripPhotoMetadata(bytes).bytes;
        // Never write bytes that still carry what this run removes. (The
        // orientation-only EXIF a JPEG keeps doesn't count; see photoMetadata.ts.)
        if (carriesMetadata(inspectPhotoMetadata(stripped))) {
          throw new PhotoMetadataError('stripped bytes still carry metadata');
        }
      } catch (err) {
        if (!(err instanceof PhotoMetadataError)) throw err;
        report.skipped += 1;
        report.findings.push({
          ...base,
          outcome: 'skipped',
          reason: err.message,
          report: inspected,
        });
        continue;
      }

      if (!options.apply) {
        report.wouldStrip += 1;
        // In a versioned bucket its original becomes an old version the
        // moment it is rewritten.
        if (version.versionId !== 'null') report.oldVersionsRemaining += 1;
        report.findings.push({ ...base, outcome: 'would-strip', report: inspected });
        continue;
      }

      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: version.key,
            Body: stripped,
            ContentType: got.ContentType,
            CacheControl: got.CacheControl,
            ContentDisposition: got.ContentDisposition,
            Metadata: got.Metadata,
            IfMatch: got.ETag,
          })
        );
      } catch (err) {
        if (!isRace(err)) throw err;
        report.raced += 1;
        report.findings.push({
          ...base,
          outcome: 'raced',
          reason: 'changed before it was rewritten',
        });
        continue;
      }
      report.stripped += 1;
      if (prefix === 'plants/') report.cdnInvalidationNeeded = true;
      report.findings.push({ ...base, outcome: 'stripped', report: inspected });

      // The version just replaced still holds the original bytes.
      if (deleting && version.versionId !== 'null') {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: version.key,
            VersionId: version.versionId,
          })
        );
        report.oldVersionsDeleted += 1;
      } else if (version.versionId !== 'null') {
        report.oldVersionsRemaining += 1;
      }
    }
  }
  return report;
}
