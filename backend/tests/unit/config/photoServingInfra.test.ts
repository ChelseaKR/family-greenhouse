/**
 * Nothing but a signed URL can read a plant photo (ADR 0033), measured on the
 * Terraform that builds production.
 *
 * The API signs every photo a response carries (tests/integration/
 * photo-access.test.ts). That is only half the property: a signature means
 * nothing if the object can also be read WITHOUT one. So this pins the other
 * half on the infrastructure itself:
 *
 *   - no CloudFront distribution has the images bucket as an origin, so no
 *     path on any site domain can serve a photo;
 *   - the images bucket's policy allows nobody anything (it only denies plain
 *     HTTP), so the one reader is the API role through its identity policy,
 *     and the one way to lend that read is a presigned URL;
 *   - every public access block on the bucket is on.
 *
 * Each check is a function, and the last block runs the same functions over a
 * config where CloudFront DOES reach the bucket: a check that could not fail
 * on that would prove nothing on the real one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function terraformFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === '.terraform') return [];
    if (statSync(path).isDirectory()) return terraformFiles(path);
    return name.endsWith('.tf') ? [path] : [];
  });
}

const allTerraform = terraformFiles(join(ROOT, 'infrastructure'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const frontendModule = readFileSync(join(ROOT, 'infrastructure/modules/frontend/main.tf'), 'utf8');

/** The body of every `resource "<type>" "<name>" { ... }`, braces matched. */
function resourceBlocks(source: string, type: string, name?: string): string[] {
  const blocks: string[] = [];
  const header = new RegExp(`resource\\s+"${type}"\\s+"${name ?? '[^"]+'}"\\s*\\{`, 'g');
  for (const match of source.matchAll(header)) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (depth > 0 && i < source.length) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push(source.slice(match.index, i));
  }
  return blocks;
}

/** Distributions that can reach the images bucket. Must be none. */
function distributionsServingImages(source: string): string[] {
  return resourceBlocks(source, 'aws_cloudfront_distribution')
    .filter((block) => /aws_s3_bucket\.images\b/.test(block))
    .map((block) => block.split('\n')[0]);
}

/** `Effect = "Allow"` statements in the images bucket's policy. Must be none. */
function imagesBucketAllows(source: string): number {
  return resourceBlocks(source, 'aws_s3_bucket_policy')
    .filter((block) => /bucket\s*=\s*aws_s3_bucket\.images\.id/.test(block))
    .reduce((count, block) => count + (block.match(/Effect\s*=\s*"Allow"/g) ?? []).length, 0);
}

/** Any policy anywhere that grants CloudFront a read of the images bucket. */
function cloudFrontGrantsOnImages(source: string): number {
  return resourceBlocks(source, 'aws_s3_bucket_policy').filter(
    (block) => /aws_s3_bucket\.images\b/.test(block) && /cloudfront\.amazonaws\.com/.test(block)
  ).length;
}

describe('the images bucket is reachable only with a signature (ADR 0033)', () => {
  it('no CloudFront distribution has the images bucket as an origin', () => {
    expect(resourceBlocks(allTerraform, 'aws_cloudfront_distribution').length).toBeGreaterThan(0);
    expect(distributionsServingImages(allTerraform)).toEqual([]);
  });

  it('the images bucket policy allows nothing, to anyone, and refuses plain HTTP', () => {
    const [policy] = resourceBlocks(frontendModule, 'aws_s3_bucket_policy', 'images');
    expect(policy).toBeTruthy();
    expect(imagesBucketAllows(allTerraform)).toBe(0);
    expect(cloudFrontGrantsOnImages(allTerraform)).toBe(0);
    expect(policy).toMatch(/Effect\s*=\s*"Deny"/);
    expect(policy).toMatch(/"aws:SecureTransport"\s*=\s*"false"/);
  });

  it('every public access block on the images bucket is on', () => {
    const [block] = resourceBlocks(frontendModule, 'aws_s3_bucket_public_access_block', 'images');
    for (const setting of [
      'block_public_acls',
      'block_public_policy',
      'ignore_public_acls',
      'restrict_public_buckets',
    ]) {
      expect(block, setting).toMatch(new RegExp(`${setting}\\s*=\\s*true`));
    }
  });

  it('the API role can read photos, which is what makes its signatures work', () => {
    const apiModule = readFileSync(join(ROOT, 'infrastructure/modules/api/main.tf'), 'utf8');
    expect(apiModule).toMatch(
      /"s3:GetObject",[\s\S]*?Resource = "\$\{var\.images_bucket_arn\}\/\*"/
    );
  });
});

describe('negative control: the checks fail on a config where the CDN serves the images bucket', () => {
  // The shape this repository had before ADR 0033, cut down to what the checks
  // read. Each check must flag it.
  const servingConfig = `
resource "aws_cloudfront_distribution" "frontend" {
  origin {
    domain_name              = aws_s3_bucket.images.bucket_regional_domain_name
    origin_id                = "S3-images"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }
  ordered_cache_behavior {
    path_pattern     = "/plants/*"
    target_origin_id = "S3-images"
  }
}

resource "aws_s3_bucket_policy" "images" {
  bucket = aws_s3_bucket.images.id
  policy = jsonencode({
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "\${aws_s3_bucket.images.arn}/*"
      }
    ]
  })
}
`;

  it('flags the distribution, the Allow, and the CloudFront grant', () => {
    expect(distributionsServingImages(servingConfig)).toHaveLength(1);
    expect(imagesBucketAllows(servingConfig)).toBe(1);
    expect(cloudFrontGrantsOnImages(servingConfig)).toBe(1);
  });
});
