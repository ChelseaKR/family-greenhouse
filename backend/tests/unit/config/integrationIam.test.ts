import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('production integration IAM invariants', () => {
  const root = new URL('../../../../', import.meta.url);
  const apiModule = readFileSync(new URL('infrastructure/modules/api/main.tf', root), 'utf8');

  it('lets the API remove and enumerate only managed plant-image objects', () => {
    expect(apiModule).toMatch(
      /"s3:PutObject",[\s\S]*?"s3:GetObject",[\s\S]*?"s3:DeleteObject",[\s\S]*?"s3:DeleteObjectVersion"[\s\S]*?Resource = "\$\{var\.images_bucket_arn\}\/\*"/
    );
    expect(apiModule).toMatch(
      /Action\s*=\s*\[[\s\S]*?"s3:ListBucket",[\s\S]*?"s3:ListBucketVersions"[\s\S]*?\][\s\S]*?Resource\s*=\s*var\.images_bucket_arn[\s\S]*?"s3:prefix"\s*=\s*\["plants\/\*"\]/
    );
  });

  it('lets self-service account deletion remove the Cognito identity', () => {
    expect(apiModule).toMatch(
      /"cognito-idp:AdminGetUser",[\s\S]*?"cognito-idp:AdminUpdateUserAttributes",[\s\S]*?"cognito-idp:AdminDeleteUser"[\s\S]*?Resource = "arn:aws:cognito-idp:\*:\*:userpool\/\$\{var\.cognito_user_pool_id\}"/
    );
  });

  it('lets both chat Lambda roles read only the configured Sprout secret', () => {
    expect(apiModule).toMatch(
      /sprout_secret_arn\s*=[\s\S]*?startswith\(var\.sprout_integration_secret_id, "arn:"\)/
    );

    const grants =
      apiModule.match(
        /Action\s*=\s*\["secretsmanager:GetSecretValue"\]\s*\n\s*Resource\s*=\s*local\.sprout_secret_arn/g
      ) ?? [];
    expect(grants).toHaveLength(2);
  });
});
