/**
 * Post-deploy smoke test against a real deployed environment.
 *
 * What this catches: the regression you can't see in unit/integration tests
 * because they don't run against the real Cognito/API Gateway. Specifically,
 * it asserts that a fresh user can sign in, create a household, land on the
 * dashboard, and see plants/tasks panels load without 403s — the failure
 * mode from the 2026-05-31 access-token-vs-id-token bug.
 *
 * Usage:
 *
 *   E2E_BASE_URL=https://familygreenhouse.net \
 *   E2E_USER_POOL_ID=us-east-1_XXXXXXXXX \
 *   E2E_USER_POOL_CLIENT_ID=<cognito-client-id> \
 *   AWS_REGION=us-east-1 \
 *     npx playwright test post-deploy-smoke --config tests/e2e/playwright.smoke.config.ts
 *
 * The test creates a one-off user via the Cognito Admin API (skipping the
 * email-verification step that would otherwise need an inbox), exercises the
 * UI, then deletes the user on teardown. No state remains in prod.
 *
 * AWS credentials come from the ambient environment — locally that's the
 * `family-greenhouse` profile via AWS_PROFILE; in CI it's the OIDC role
 * configured in the workflow.
 */
import { test, expect } from '@playwright/test';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, QueryCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';

const USER_POOL_ID = process.env.E2E_USER_POOL_ID;
const TABLE_NAME = process.env.E2E_TABLE_NAME ?? 'family-greenhouse-production';
const REGION = process.env.AWS_REGION || 'us-east-1';

if (!USER_POOL_ID) {
  throw new Error('E2E_USER_POOL_ID is required for post-deploy smoke tests');
}

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

function uniqueEmail(): string {
  // Use the +tag convention so smoke-test users are visible but easy to
  // bulk-delete if cleanup ever lags. The plus-addressed local part is
  // also valid on Cognito (it stores `local+tag` verbatim).
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `e2e-smoke+${stamp}@familygreenhouse.net`;
}

const PASSWORD = 'E2E-Smoke!Pass1234';

async function createConfirmedUser(email: string): Promise<string> {
  const created = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: 'E2E Smoke' },
      ],
      MessageAction: 'SUPPRESS',
    })
  );
  const username = created.User?.Username;
  if (!username) throw new Error('AdminCreateUser did not return a username');

  // Required to flip the user out of FORCE_CHANGE_PASSWORD.
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      Password: PASSWORD,
      Permanent: true,
    })
  );
  return username;
}

async function deleteUserAndHouseholds(username: string): Promise<void> {
  // First find every household the user is a member of via GSI1
  // (PK: USER#<sub>, SK: HOUSEHOLD#<id>) so we can tear down the rows
  // the smoke test's UI flow created. Without this teardown, every
  // smoke run would leave orphan HOUSEHOLD rows in DDB.
  const memberships: { householdId: string }[] = [];
  try {
    const q = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': { S: `USER#${username}` } },
      })
    );
    for (const item of q.Items ?? []) {
      const hh = item['SK']?.S?.replace(/^HOUSEHOLD#/, '');
      if (hh) memberships.push({ householdId: hh });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`DDB lookup failed for ${username}: ${(err as Error).message}`);
  }

  // For each household: delete the METADATA + MEMBER rows. Households
  // created by the smoke test are always single-member so this is two
  // rows per household.
  for (const { householdId } of memberships) {
    try {
      await ddb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [TABLE_NAME]: [
              {
                DeleteRequest: {
                  Key: {
                    PK: { S: `HOUSEHOLD#${householdId}` },
                    SK: { S: 'METADATA' },
                  },
                },
              },
              {
                DeleteRequest: {
                  Key: {
                    PK: { S: `HOUSEHOLD#${householdId}` },
                    SK: { S: `MEMBER#${username}` },
                  },
                },
              },
            ],
          },
        })
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`DDB delete failed for HH ${householdId}: ${(err as Error).message}`);
    }
  }

  try {
    await cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      })
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`AdminDeleteUser failed for ${username}: ${(err as Error).message}`);
  }
}

test.describe('post-deploy smoke', () => {
  let email: string;
  let username: string;
  const apiErrors: { url: string; status: number }[] = [];

  test.beforeEach(async ({ page }) => {
    email = uniqueEmail();
    username = await createConfirmedUser(email);
    apiErrors.length = 0;
    page.on('response', (resp) => {
      const url = resp.url();
      const status = resp.status();
      if (status >= 400 && url.includes('/production/')) {
        apiErrors.push({ url, status });
      }
    });
  });

  test.afterEach(async () => {
    if (username) await deleteUserAndHouseholds(username);
  });

  test('fresh user → login → onboarding → dashboard renders cleanly', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();

    // First sign-in lands on onboarding (no household yet).
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });

    // Pick "Create a new household".
    await page.getByRole('button', { name: /create a new household/i }).click();
    await page.getByLabel(/household name/i).fill('Smoke Test Household');
    await page.getByRole('button', { name: /create household/i }).click();

    // Successful household creation routes to /dashboard or '/'.
    await expect(page).toHaveURL(/\/(dashboard)?$/, { timeout: 15_000 });

    // Dashboard heading is visible (uses the user's first name).
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible({
      timeout: 10_000,
    });

    // Wait for the "Your Plants" panel to settle — its API call is what
    // would 403 if the household claim were missing.
    await expect(page.getByRole('heading', { name: /your plants/i })).toBeVisible();

    // Crucial assertion: no inline error alerts on the dashboard. The 403
    // failure mode rendered "Request failed with status code 403" inside
    // both the Upcoming Tasks and Your Plants panels.
    const errorAlerts = await page.getByText(/Request failed with status code/i).count();
    expect(errorAlerts).toBe(0);

    // And no 403/500 responses observed during the run.
    const fatalApiErrors = apiErrors.filter((e) => e.status === 403 || e.status >= 500);
    expect(fatalApiErrors).toEqual([]);
  });
});
