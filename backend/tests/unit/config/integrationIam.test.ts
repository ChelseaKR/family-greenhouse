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
      /Action\s*=\s*\[[\s\S]*?"s3:ListBucket",[\s\S]*?"s3:ListBucketVersions"[\s\S]*?\][\s\S]*?Resource\s*=\s*var\.images_bucket_arn[\s\S]*?"s3:prefix"\s*=\s*\["plants\/\*", "trash\/\*"\]/
    );
  });

  it('lists exactly the two managed prefixes: live plant images and the trash (#670)', () => {
    const prefixes = apiModule.match(/"s3:prefix"\s*=\s*\[([^\]]*)\]/);
    expect(prefixes?.[1].split(',').map((p) => p.trim())).toEqual(['"plants/*"', '"trash/*"']);
  });

  it('lets self-service account deletion remove the Cognito identity', () => {
    expect(apiModule).toMatch(
      /"cognito-idp:AdminGetUser",[\s\S]*?"cognito-idp:AdminUpdateUserAttributes",[\s\S]*?"cognito-idp:AdminDeleteUser"[\s\S]*?Resource = "arn:aws:cognito-idp:\*:\*:userpool\/\$\{var\.cognito_user_pool_id\}"/
    );
  });

  it('lets user lifecycle flows batch-remove records and guard transactional writes', () => {
    const fleetPolicy = apiModule.slice(
      apiModule.indexOf('resource "aws_iam_role_policy" "lambda"'),
      apiModule.indexOf('resource "aws_iam_role_policy" "chat_stream"')
    );

    expect(fleetPolicy).toContain('"dynamodb:BatchWriteItem"');
    expect(fleetPolicy).toContain('"dynamodb:ConditionCheckItem"');
    expect(fleetPolicy).toMatch(
      /"dynamodb:BatchWriteItem"[\s\S]*?"dynamodb:ConditionCheckItem"[\s\S]*?Resource = \[[\s\S]*?var\.dynamodb_table_arn/
    );
  });

  // Production, v0.24.0 to v0.53.0: the households Lambda's suppression
  // lookup for the member list was denied dynamodb:BatchGetItem on every call,
  // so a roster never showed which addresses had bounced.
  it('lets the fleet batch-read the table, and only the table, for the suppression lookup', () => {
    const fleetPolicy = apiModule.slice(
      apiModule.indexOf('resource "aws_iam_role_policy" "lambda"'),
      apiModule.indexOf('resource "aws_iam_role_policy" "chat_stream"')
    );

    const grants = fleetPolicy.match(/"dynamodb:BatchGetItem"/g) ?? [];
    expect(grants).toHaveLength(1);
    expect(fleetPolicy).toMatch(
      /Action\s*=\s*\["dynamodb:BatchGetItem"\]\s*\n\s*Resource\s*=\s*var\.dynamodb_table_arn\s*\n/
    );
    // Nowhere else in the module: the chat-stream role does not batch-read.
    expect(apiModule.match(/"dynamodb:BatchGetItem"/g) ?? []).toHaveLength(1);
    // And the grant still has its reader: the suppression lookup batch-reads.
    const suppression = readFileSync(
      new URL('backend/src/services/emailSuppression.ts', root),
      'utf8'
    );
    expect(suppression).toContain('new BatchGetCommand(');
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
