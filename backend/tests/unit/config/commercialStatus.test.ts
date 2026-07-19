import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_HOLD_ACTIVE,
  COMMERCIAL_HOLD_EFFECTIVE_DATE,
  isPublicRegistrationAllowed,
  isPaymentActivityAllowed,
  paymentsAreAvailable,
  publicRegistrationIsAvailable,
} from '../../../src/config/commercialStatus.js';

describe('repository commercial status', () => {
  it('keeps the commercial hold active while allowing free public registration', () => {
    expect(COMMERCIAL_HOLD_ACTIVE).toBe(true);
    expect(COMMERCIAL_HOLD_EFFECTIVE_DATE).toBe('2026-07-14');
    expect(paymentsAreAvailable()).toBe(false);
    expect(publicRegistrationIsAvailable()).toBe(true);
  });

  it.each([undefined, '', '0', 'true', 'TRUE', 'yes', '01', ' 1', '1 ', '\n1'])(
    'rejects a missing or non-exact runtime enablement value: %s',
    (value) => {
      expect(isPaymentActivityAllowed(false, value)).toBe(false);
      expect(isPaymentActivityAllowed(true, value)).toBe(false);
    }
  );

  it('requires both an inactive hold and the exact string 1', () => {
    expect(isPaymentActivityAllowed(true, '1')).toBe(false);
    expect(isPaymentActivityAllowed(false, '1')).toBe(true);
  });

  it.each([undefined, null, false, '', 'true', 'false', '1', 0, 1, {}, []])(
    'keeps public registration closed for any value except boolean true: %s',
    (value) => {
      expect(isPublicRegistrationAllowed(value)).toBe(false);
    }
  );

  it('allows registration eligibility only for an explicit boolean true', () => {
    expect(isPublicRegistrationAllowed(true)).toBe(true);
  });
});

describe('production IaC commercial-hold invariants', () => {
  const root = new URL('../../../../', import.meta.url);
  const apiModule = readFileSync(new URL('infrastructure/modules/api/main.tf', root), 'utf8');
  const authModule = readFileSync(new URL('infrastructure/modules/auth/main.tf', root), 'utf8');
  const monitoringModule = readFileSync(
    new URL('infrastructure/modules/monitoring/main.tf', root),
    'utf8'
  );
  const rootModule = readFileSync(new URL('infrastructure/main.tf', root), 'utf8');
  const rootVariables = readFileSync(new URL('infrastructure/variables.tf', root), 'utf8');
  const productionVars = readFileSync(
    new URL('infrastructure/environments/production/terraform.tfvars', root),
    'utf8'
  );
  const productionWorkflow = readFileSync(
    new URL('.github/workflows/cd-production.yml', root),
    'utf8'
  );
  const stagingWorkflow = readFileSync(new URL('.github/workflows/cd-staging.yml', root), 'utf8');
  const frontendSnapshotCleanup = readFileSync(
    new URL('.github/scripts/purge-frontend-snapshot-versions.sh', root),
    'utf8'
  );

  it('does not wire PAYMENTS_ENABLED into any Lambda environment', () => {
    expect(apiModule).not.toMatch(/\bPAYMENTS_ENABLED\b/);
  });

  it('keeps every committed production Stripe price id blank and the live gate false', () => {
    const priceLines = productionVars
      .split('\n')
      .filter((line) => /^stripe_price_id_[a-z_]+\s*=/.test(line.trim()));

    expect(priceLines).toHaveLength(5);
    for (const line of priceLines) {
      expect(line).toMatch(/^stripe_price_id_[a-z_]+\s*=\s*""\s*$/);
    }
    expect(productionVars).toMatch(/^stripe_price_ids_are_live\s*=\s*false\s*$/m);
  });

  it('enables Cognito public self-signup explicitly while keeping the IaC default closed', () => {
    expect(authModule).toMatch(
      /allow_admin_create_user_only\s*=\s*!var\.public_registration_enabled/
    );
    expect(rootVariables).toMatch(
      /variable "public_registration_enabled"\s*{[\s\S]*?default\s*=\s*false\s*}/
    );
    expect(productionVars).toMatch(/^public_registration_enabled\s*=\s*true\s*$/m);
  });

  it('keeps Cognito default email configuration valid when SES addresses are blank', () => {
    expect(authModule).toMatch(
      /reply_to_email_address\s*=\s*var\.email_reply_to != "" \? var\.email_reply_to : \(var\.email_from_address != "" \? var\.email_from_address : null\)/
    );
    expect(authModule).not.toMatch(/reply_to_email_address\s*=\s*coalesce\(/);
  });

  it('creates the account-global Cost Explorer anomaly monitor only in production', () => {
    expect(rootModule).toMatch(
      /enable_cost_anomaly_monitor\s*=\s*var\.environment == "production"/
    );
    expect(monitoringModule).toMatch(
      /resource "aws_ce_anomaly_monitor" "services"\s*{[\s\S]*?count\s*=\s*var\.enable_cost_anomaly_monitor \? 1 : 0/
    );
    expect(monitoringModule).toMatch(/to\s*=\s*aws_ce_anomaly_monitor\.services\[0\]/);
    expect(monitoringModule).toMatch(
      /monitor_arn_list\s*=\s*\[aws_ce_anomaly_monitor\.services\[0\]\.arn\]/
    );
  });

  it('serializes first-time Lambda function URL policy updates', () => {
    expect(apiModule).toMatch(
      /resource "aws_lambda_permission" "chat_stream_url"\s*{[\s\S]*?depends_on\s*=\s*\[aws_lambda_function_url\.chat_stream\]/
    );
  });

  it('deploys the registration API before exposing the public frontend form', () => {
    const deployFrontend = productionWorkflow.slice(
      productionWorkflow.indexOf('  deploy-frontend:'),
      productionWorkflow.indexOf('  deploy-backend:')
    );
    const deployBackend = productionWorkflow.slice(
      productionWorkflow.indexOf('  deploy-backend:'),
      productionWorkflow.indexOf('  smoke-tests:')
    );
    expect(deployFrontend).toMatch(/needs:\s*\[[^\]]*deploy-backend[^\]]*\]/);
    expect(deployBackend).not.toMatch(/needs:\s*\[[^\]]*deploy-frontend[^\]]*\]/);
  });

  it('snapshots and restores a failed release as one coordinated rollback', () => {
    const terraform = productionWorkflow.slice(
      productionWorkflow.indexOf('  terraform:'),
      productionWorkflow.indexOf('  deploy-frontend:')
    );
    const deployFrontend = productionWorkflow.slice(
      productionWorkflow.indexOf('  deploy-frontend:'),
      productionWorkflow.indexOf('  deploy-backend:')
    );
    const deployBackend = productionWorkflow.slice(
      productionWorkflow.indexOf('  deploy-backend:'),
      productionWorkflow.indexOf('  smoke-tests:')
    );
    const smoke = productionWorkflow.slice(
      productionWorkflow.indexOf('  smoke-tests:'),
      productionWorkflow.indexOf('  rollback:')
    );
    const rollback = productionWorkflow.slice(
      productionWorkflow.indexOf('  rollback:'),
      productionWorkflow.indexOf('  notify:')
    );

    expect(terraform.indexOf('Snapshot Cognito registration policy')).toBeLessThan(
      terraform.indexOf('Terraform Plan')
    );
    expect(terraform).toMatch(/user_pool_id=\$\{USER_POOL_ID}/);
    expect(terraform).toMatch(/public_registration_enabled=\$\{REGISTRATION_ENABLED}/);
    expect(terraform).toMatch(/admin_create_user_only=\$\{ADMIN_ONLY}/);
    expect(terraform).toMatch(/admin_create_user_only=.*[\s\S]*ready=true/);

    expect(productionWorkflow).toMatch(
      /FRONTEND_SNAPSHOT_PREFIX: frontend-snapshots\/\$\{\{ github\.run_id }}/
    );
    expect(productionWorkflow).not.toMatch(/FRONTEND_SNAPSHOT_PREFIX:.*run_attempt/);
    expect(deployFrontend).toMatch(/Snapshot current frontend for rollback/);
    expect(deployFrontend).toMatch(/snapshot-complete/);
    expect(deployFrontend).toMatch(/SNAPSHOT_MARKER="\$\{RUNNER_TEMP\}\/snapshot-complete"/);
    expect(deployFrontend).toMatch(/--body "\$SNAPSHOT_MARKER"/);
    expect(deployFrontend).not.toMatch(/--body \/dev\/null/);
    expect(deployFrontend).toMatch(/cloudfront wait invalidation-completed/);
    expect(deployBackend.indexOf('Capture previous Lambda versions and packages')).toBeLessThan(
      deployBackend.indexOf('Mark Lambda rollback snapshot ready')
    );
    expect(deployBackend).toMatch(/aws lambda get-function[\s\S]*?--qualifier "\$ver"/);
    expect(deployBackend).toMatch(/Code\.Location/);
    expect(deployBackend).toMatch(/snapshot_size=.*aws s3api head-object/);
    expect(deployBackend).toMatch(/rollback package was not stored correctly/);
    expect(deployBackend).toMatch(/lambda wait function-updated-v2/);
    expect(deployBackend).toMatch(/API_URL:\s*\$\{\{ needs\.terraform\.outputs\.api_url }}/);
    expect(deployBackend).toMatch(/url="\$\{API_URL\}\/health"/);
    expect(deployBackend).toMatch(/components\?\.database\?\.status\s*!==\s*'ok'/);
    expect(deployBackend).not.toMatch(/vars\.PRODUCTION_API_URL/);
    expect(smoke).toMatch(/needs:\s*\[[^\]]*terraform[^\]]*\]/);
    expect(smoke).toMatch(/E2E_BASE_URL:\s*\$\{\{ needs\.terraform\.outputs\.site_url }}/);
    expect(smoke).toMatch(/E2E_API_URL:\s*\$\{\{ needs\.terraform\.outputs\.api_url }}/);
    expect(smoke).toMatch(/E2E_TABLE_NAME:/);
    expect(smoke).toMatch(
      /E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE:\s*\$\{\{ secrets\.E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE }}/
    );
    expect(rollback).toMatch(
      /needs:\s*\[[^\]]*terraform[^\]]*deploy-frontend[^\]]*smoke-tests[^\]]*\]/
    );
    expect(rollback).toMatch(/needs\.smoke-tests\.result != 'success'/);
    expect(rollback).toMatch(/needs\.terraform\.outputs\.registration_snapshot_ready == 'true'/);
    expect(rollback).toMatch(/-var="public_registration_enabled=\$\{REGISTRATION_ENABLED_BEFORE}/);
    expect(rollback).not.toMatch(/public_registration_enabled=false/);
    expect(rollback).toMatch(/AllowAdminCreateUserOnly/);
    expect(rollback).toMatch(/USER_POOL_ID_BEFORE/);
    expect(rollback).toMatch(/--exclude "snapshot-complete"/);
    expect(rollback).toMatch(/lambda wait function-updated-v2/);
    expect(rollback).toMatch(/steps\.download_versions\.outcome == 'success'/);
    expect(rollback).toMatch(/Verify rollback outcome/);
    expect(rollback).toMatch(/REGISTRATION_OUTCOME/);
    expect(rollback).toMatch(/BACKEND_OUTCOME/);

    for (const id of [
      'checkout',
      'aws_credentials',
      'terraform_setup',
      'restore_registration',
      'restore_frontend',
      'download_versions',
      'restore_backend',
    ]) {
      expect(rollback).toMatch(new RegExp(`id: ${id}[\\s\\S]{0,700}continue-on-error: true`));
    }

    const restoreRegistration = rollback.indexOf('Restore Cognito registration policy');
    const restoreFrontend = rollback.indexOf('Restore previous frontend');
    const restoreBackend = rollback.indexOf('Restore previous Lambda versions');
    expect(restoreRegistration).toBeGreaterThan(-1);
    expect(restoreFrontend).toBeGreaterThan(restoreRegistration);
    expect(restoreBackend).toBeGreaterThan(restoreFrontend);
  });

  it('purges every version of a run-scoped frontend snapshot only after recovery is safe', () => {
    const successCleanup = productionWorkflow.slice(
      productionWorkflow.indexOf('  cleanup-success-snapshot:'),
      productionWorkflow.indexOf('  rollback:')
    );
    const rollback = productionWorkflow.slice(
      productionWorkflow.indexOf('  rollback:'),
      productionWorkflow.indexOf('  notify:')
    );
    const notify = productionWorkflow.slice(productionWorkflow.indexOf('  notify:'));

    expect(successCleanup).toMatch(/needs:\s*smoke-tests/);
    expect(successCleanup).toMatch(/needs\.smoke-tests\.result == 'success'/);
    expect(successCleanup).toMatch(/purge-frontend-snapshot-versions\.sh/);
    expect(successCleanup).toMatch(/persist-credentials:\s*false/);

    const verifyRollback = rollback.indexOf('Verify rollback outcome');
    const purgeRollback = rollback.indexOf(
      'Purge completed rollback frontend snapshot versions and delete markers'
    );
    const reportRollback = rollback.indexOf('Report successful rollback');
    expect(verifyRollback).toBeGreaterThan(-1);
    expect(purgeRollback).toBeGreaterThan(verifyRollback);
    expect(reportRollback).toBeGreaterThan(purgeRollback);
    expect(rollback).toMatch(/steps\.verify_rollback\.outcome == 'success'/);
    expect(rollback).toMatch(/purge-frontend-snapshot-versions\.sh/);

    expect(notify).toMatch(/cleanup-success-snapshot/);
    expect(notify).toMatch(/CLEANUP_RESULT/);

    expect(frontendSnapshotCleanup).toContain('^frontend-snapshots/[0-9]+$');
    expect(frontendSnapshotCleanup).toMatch(/while true/);
    expect(frontendSnapshotCleanup).toMatch(/list-object-versions/);
    expect(frontendSnapshotCleanup).toMatch(/--prefix "\$exact_prefix"/);
    expect(frontendSnapshotCleanup).toMatch(/\.Versions \/\/ \[\]/);
    expect(frontendSnapshotCleanup).toMatch(/\.DeleteMarkers \/\/ \[\]/);
    expect(frontendSnapshotCleanup).toMatch(/delete-objects/);
    expect(frontendSnapshotCleanup).toMatch(/\.Errors \/\/ \[\]/);
  });

  it('runs the deployed staging smoke against Terraform outputs', () => {
    const buildFrontend = stagingWorkflow.slice(
      stagingWorkflow.indexOf('  build-frontend:'),
      stagingWorkflow.indexOf('  deploy-frontend:')
    );
    const deployFrontend = stagingWorkflow.slice(
      stagingWorkflow.indexOf('  deploy-frontend:'),
      stagingWorkflow.indexOf('  deploy-backend:')
    );
    const deployBackend = stagingWorkflow.slice(
      stagingWorkflow.indexOf('  deploy-backend:'),
      stagingWorkflow.indexOf('  e2e-tests:')
    );
    const smoke = stagingWorkflow.slice(
      stagingWorkflow.indexOf('  e2e-tests:'),
      stagingWorkflow.indexOf('  notify:')
    );

    expect(buildFrontend).toMatch(/needs:\s*terraform/);
    expect(buildFrontend).toMatch(/VITE_API_URL:\s*\$\{\{ needs\.terraform\.outputs\.api_url }}/);
    expect(buildFrontend).not.toMatch(/STAGING_API_URL/);
    expect(deployFrontend).toMatch(/needs:\s*\[[^\]]*build-frontend[^\]]*deploy-backend[^\]]*\]/);
    expect(deployFrontend).toMatch(/cloudfront wait invalidation-completed/);
    expect(deployBackend).toMatch(/needs:\s*\[[^\]]*terraform[^\]]*build-frontend[^\]]*\]/);
    expect(deployBackend).toMatch(/lambda wait function-updated-v2/);
    expect(deployBackend).toMatch(/API_URL:\s*\$\{\{ needs\.terraform\.outputs\.api_url }}/);
    expect(deployBackend).toMatch(/url="\$\{API_URL\}\/health"/);
    expect(deployBackend).toMatch(/components\?\.database\?\.status\s*!==\s*'ok'/);
    expect(deployBackend).not.toMatch(/STAGING_API_URL/);
    expect(smoke).toMatch(/needs:\s*\[[^\]]*terraform[^\]]*\]/);
    expect(smoke).toMatch(/E2E_BASE_URL:\s*\$\{\{ needs\.terraform\.outputs\.site_url }}/);
    expect(smoke).toMatch(/E2E_API_URL:\s*\$\{\{ needs\.terraform\.outputs\.api_url }}/);
    expect(smoke).toMatch(
      /E2E_USER_POOL_ID:\s*\$\{\{ needs\.terraform\.outputs\.cognito_user_pool_id }}/
    );
    expect(smoke).toMatch(
      /E2E_TABLE_NAME:\s*\$\{\{ needs\.terraform\.outputs\.dynamodb_table_name }}/
    );
    expect(smoke).toMatch(
      /E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE:\s*\$\{\{ secrets\.E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE }}/
    );
    expect(smoke).toMatch(/playwright\.smoke\.config\.ts/);
    expect(smoke).not.toMatch(/PLAYWRIGHT_BASE_URL/);
    expect(stagingWorkflow).not.toMatch(/STAGING_API_URL/);
    expect(stagingWorkflow).not.toMatch(/\$\{\{ vars\.STAGING_(?:URL|COGNITO)/);
  });

  it('restricts manual production dispatches to main', () => {
    expect(productionWorkflow).toMatch(/Require main for manual production dispatch/);
    expect(productionWorkflow).toMatch(/refs\/heads\/main/);
  });
});
