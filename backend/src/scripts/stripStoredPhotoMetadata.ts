#!/usr/bin/env -S npx tsx
/**
 * Operator CLI: remove location metadata from plant photos already stored in
 * the images bucket. `services/storedPhotoMetadataBackfill.ts` carries the
 * contract, and `services/photoMetadata.ts` explains the defect. Nothing calls
 * this automatically, and it has NOT been run against production.
 *
 * It lives under `src/` for the same reason as `backfillTokenHashes.ts`: so
 * `tsc --noEmit` and `eslint` cover it. It is never bundled.
 *
 * RUN IT AFTER the release carrying #849 is deployed. Until then, the web app
 * can still store a photo with its location in it. Run it again once the app
 * builds from before #849 are out of use: an installed native build or a
 * cached web app keeps its old upload code until it updates.
 *
 * WHERE TO RUN IT: it reads every photo's bytes into the memory of the machine
 * it runs on. To keep them inside AWS, run it from AWS CloudShell in us-east-1
 * (clone, `npm ci`, then the commands below). It writes nothing to disk and
 * never prints a coordinate, a place name, a camera model or an object key.
 *
 * Dry run by default: it reads everything and reports counts. `--confirm`
 * rewrites each current photo that carries location, in place, under the same
 * key. `--delete-old-versions` (only with `--confirm`) also deletes the
 * versions that still hold the original bytes. That can't be undone, and
 * without it the bucket's lifecycle rule expires them 30 days after they are
 * replaced. `--all-metadata` targets every EXIF/XMP/IPTC block, not only
 * location.
 *
 *   IMAGES_BUCKET=family-greenhouse-images-production-<suffix> \
 *     npm run backfill:photo-metadata --workspace backend
 *   ... -- --confirm
 *   ... -- --confirm --delete-old-versions
 *
 * Exit status: 0 = done (or dry run), 2 = something raced or was skipped (read
 * the findings and re-run), 1 = error.
 */
import { parseArgs } from 'node:util';
import { S3Client } from '@aws-sdk/client-s3';
import {
  PHOTO_PREFIXES,
  runPhotoMetadataBackfill,
  type BackfillOptions,
  type BackfillReport,
} from '../services/storedPhotoMetadataBackfill.js';

export interface CliArgs extends BackfillOptions {
  bucket: string;
}

/** Pure parse: throws a readable Error rather than exiting, so it is testable. */
export function parseCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env
): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      bucket: { type: 'string' },
      confirm: { type: 'boolean', default: false },
      'delete-old-versions': { type: 'boolean', default: false },
      'all-metadata': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const bucket = values.bucket ?? env.IMAGES_BUCKET;
  if (!bucket) {
    throw new Error('Name the images bucket: --bucket <name> or IMAGES_BUCKET=<name>.');
  }
  const apply = values.confirm ?? false;
  const deleteOldVersions = values['delete-old-versions'] ?? false;
  if (deleteOldVersions && !apply) {
    throw new Error('--delete-old-versions only works with --confirm.');
  }
  return {
    bucket,
    apply,
    deleteOldVersions,
    allMetadata: values['all-metadata'] ?? false,
    prefixes: [...PHOTO_PREFIXES],
  };
}

/** The report, as the operator reads it. Counts and short refs only. */
export function formatReport(report: BackfillReport): string {
  const target = report.allMetadata ? 'any metadata' : 'location metadata';
  const lines = [
    `Scanned ${report.currentScanned} current photo(s) and ${report.noncurrentScanned} old version(s).`,
    `Carrying location when read: ${report.currentWithLocation} current, ${report.noncurrentWithLocation} old.`,
    `Carrying any removable metadata: ${report.currentWithAnyMetadata} current.`,
  ];
  if (report.apply) {
    lines.push(
      `Rewritten without ${target}: ${report.stripped}. Raced (re-run): ${report.raced}. Skipped: ${report.skipped}.`
    );
  } else {
    lines.push(
      `Would rewrite without ${target}: ${report.wouldStrip}. Skipped: ${report.skipped}.`
    );
  }
  if (report.deleteOldVersions) {
    lines.push(`Old versions deleted: ${report.oldVersionsDeleted}.`);
  }
  if (report.oldVersionsRemaining > 0) {
    lines.push(
      `Old versions still holding the original bytes: ${report.oldVersionsRemaining}. ` +
        'Only AWS account principals can read them, and the lifecycle rule deletes them 30 days ' +
        'after they were replaced. --confirm --delete-old-versions deletes them now.'
    );
  }
  for (const finding of report.findings) {
    if (finding.outcome === 'clean') continue;
    const where = `${finding.prefix}…/${finding.ref}${finding.current ? '' : ' (old version)'}`;
    lines.push(`  ${finding.outcome}: ${where}${finding.reason ? ` (${finding.reason})` : ''}`);
  }
  if (report.cdnInvalidationNeeded) {
    lines.push(
      '',
      'CloudFront may still serve the old bytes of a rewritten photo from its cache (up to a year',
      'for a sitter photo). Invalidate the photo path:',
      '  aws cloudfront create-invalidation --distribution-id "$(terraform -chdir=infrastructure output -raw cloudfront_distribution_id)" --paths "/plants/*"'
    );
  }
  if (!report.apply) {
    lines.push('', 'Dry run only. Pass --confirm to rewrite. Nothing was written.');
  }
  return lines.join('\n');
}

export async function main(
  argv: readonly string[],
  s3: S3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' })
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error('\nSee the usage block at the top of this script.');
    return 1;
  }
  const report = await runPhotoMetadataBackfill(s3, args.bucket, args);
  console.info(formatReport(report));
  // A raced or skipped photo is not a failure of the run, but it is not done
  // either: say so in the exit status so a wrapper can't read it as finished.
  return report.raced > 0 || report.skipped > 0 ? 2 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
