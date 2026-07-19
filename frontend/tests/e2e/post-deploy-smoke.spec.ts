/**
 * Post-deploy smoke test against a real deployed environment.
 *
 * What this catches: the regression you can't see in unit/integration tests
 * because they don't run against the real Cognito/API Gateway. Specifically,
 * it asserts that public registration reaches Cognito's confirmation-ready
 * state, and that a separate confirmed fixture can sign in, create a
 * household, land on the dashboard, and see plants/tasks panels load without
 * 403s — the failure mode from the 2026-05-31 access-token-vs-id-token bug.
 *
 * Usage:
 *
 *   E2E_BASE_URL=https://familygreenhouse.net \
 *   E2E_API_URL=https://api-id.execute-api.us-east-1.amazonaws.com/production \
 *   E2E_USER_POOL_ID=us-east-1_XXXXXXXXX \
 *   E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE='fg-smoke+{tag}@example.com' \
 *   AWS_REGION=us-east-1 \
 *     npx playwright test post-deploy-smoke --config tests/e2e/playwright.smoke.config.ts
 *
 * The test creates two one-off users: the public /register flow creates an
 * unconfirmed account through the real API, while the authenticated-flow
 * fixture is created separately through the Cognito Admin API so it can skip
 * the inbox-only confirmation step. Both users are deleted on teardown.
 *
 * AWS credentials come from the ambient environment — locally that's the
 * `family-greenhouse` profile via AWS_PROFILE; in CI it's the OIDC role
 * configured in the workflow.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  DescribeUserPoolCommand,
  ListUsersCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  DynamoDBClient,
  QueryCommand,
  BatchWriteItemCommand,
  type AttributeValue,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import {
  buildSmokeEmail,
  householdIdFromCreateResponse,
  householdIdFromMembershipItem,
  runAllCleanupSteps,
} from './post-deploy-smoke-support';

const USER_POOL_ID = process.env.E2E_USER_POOL_ID;
const API_URL = process.env.E2E_API_URL?.replace(/\/+$/, '');
const TABLE_NAME = process.env.E2E_TABLE_NAME ?? 'family-greenhouse-production';
const REGION = process.env.AWS_REGION || 'us-east-1';
const PUBLIC_SIGNUP_EMAIL_TEMPLATE = process.env.E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE;

if (!USER_POOL_ID) {
  throw new Error('E2E_USER_POOL_ID is required for post-deploy smoke tests');
}
if (!API_URL) {
  throw new Error('E2E_API_URL is required for post-deploy smoke tests');
}

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

function smokeEmail(kind: 'public' | 'authenticated'): string {
  // The operator owns the template and must point it at a mailbox that accepts
  // the generated tags. This test deliberately has no invented-domain fallback:
  // Cognito sends real confirmation/welcome email, and fake local parts create
  // hard bounces that damage SES reputation.
  const stamp = randomUUID().replace(/-/g, '').slice(0, 12);
  return buildSmokeEmail(PUBLIC_SIGNUP_EMAIL_TEMPLATE, `${kind}-${stamp}`);
}

const PASSWORD = 'E2E-Smoke!Pass1234';

test.beforeAll(async () => {
  const pool = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: USER_POOL_ID }));
  expect(pool.UserPool?.AdminCreateUserConfig?.AllowAdminCreateUserOnly).toBe(false);
});

interface ConfirmedFixture {
  username: string;
  sub: string;
  /** Authoritative id returned by POST /households; avoids relying on GSI propagation. */
  householdId?: string;
}

async function deleteCognitoUser(username: string): Promise<void> {
  try {
    await cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      })
    );
  } catch (error) {
    if ((error as Error).name !== 'UserNotFoundException') throw error;
  }
}

async function createConfirmedUser(email: string): Promise<ConfirmedFixture> {
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

  try {
    // The app stores memberships under JWT `sub`, while Cognito deletion takes
    // the service Username. They often look alike but are separate contracts,
    // so retain both explicitly.
    let sub = created.User?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value;
    if (!sub) {
      const fetched = await cognito.send(
        new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username })
      );
      sub = fetched.UserAttributes?.find((attribute) => attribute.Name === 'sub')?.Value;
    }
    if (!sub) throw new Error('AdminCreateUser/AdminGetUser did not return a Cognito sub');

    // Required to flip the user out of FORCE_CHANGE_PASSWORD.
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        Password: PASSWORD,
        Permanent: true,
      })
    );
    return { username, sub };
  } catch (setupError) {
    try {
      await deleteCognitoUser(username);
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        `Confirmed smoke fixture setup failed and ${username} could not be cleaned up`,
        { cause: cleanupError }
      );
    }
    throw setupError;
  }
}

async function findUserByEmail(email: string, attempts = 1): Promise<UserType | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await cognito.send(
      new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Filter: `email = "${email}"`,
        Limit: 1,
      })
    );
    const user = result.Users?.find((candidate) =>
      candidate.Attributes?.some(
        (attribute) => attribute.Name === 'email' && attribute.Value === email
      )
    );
    if (user) return user;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return undefined;
}

async function deletePublicSignupUser(email: string, knownUsername?: string): Promise<void> {
  const username = knownUsername ?? (await findUserByEmail(email, 5))?.Username;
  if (!username) return;

  await deleteCognitoUser(username);
}

async function deleteHouseholdRows(householdId: string, sub: string): Promise<void> {
  let pending: WriteRequest[] = [
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
          SK: { S: `MEMBER#${sub}` },
        },
      },
    },
  ];

  for (let attempt = 1; attempt <= 3 && pending.length > 0; attempt += 1) {
    const result = await ddb.send(
      new BatchWriteItemCommand({ RequestItems: { [TABLE_NAME]: pending } })
    );
    pending = result.UnprocessedItems?.[TABLE_NAME] ?? [];
    if (pending.length > 0 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }

  if (pending.length > 0) {
    throw new Error(`${pending.length} DynamoDB delete request(s) remained unprocessed`);
  }
}

async function deleteUserAndHouseholds(fixture: ConfirmedFixture): Promise<void> {
  // First find every household the user is a member of via GSI1
  // (GSI1PK: USER#<sub>, GSI1SK: HOUSEHOLD#<id>) so we can tear down the rows
  // the smoke test's UI flow created. Without this teardown, every
  // smoke run would leave orphan HOUSEHOLD rows in DDB.
  const householdIds = new Set<string>(fixture.householdId ? [fixture.householdId] : []);

  await runAllCleanupSteps([
    {
      label: `DynamoDB membership lookup for Cognito sub ${fixture.sub}`,
      run: async () => {
        const malformedKeys: string[] = [];
        // GSI1 is eventually consistent. The create response normally gives
        // us an authoritative id immediately; if the test failed before that
        // response was captured, retry an empty GSI result before giving up.
        const maxAttempts = fixture.householdId ? 1 : 5;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          let exclusiveStartKey: Record<string, AttributeValue> | undefined;
          let foundOnAttempt = false;
          do {
            const page = await ddb.send(
              new QueryCommand({
                TableName: TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'GSI1PK = :pk',
                ExpressionAttributeValues: { ':pk': { S: `USER#${fixture.sub}` } },
                ExclusiveStartKey: exclusiveStartKey,
              })
            );
            for (const item of page.Items ?? []) {
              const householdId = householdIdFromMembershipItem(item);
              if (householdId) {
                householdIds.add(householdId);
                foundOnAttempt = true;
              } else {
                malformedKeys.push(item['GSI1SK']?.S ?? '<missing>');
              }
            }
            exclusiveStartKey = page.LastEvaluatedKey;
          } while (exclusiveStartKey);

          if (foundOnAttempt || attempt === maxAttempts) break;
          await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        }

        if (malformedKeys.length > 0) {
          throw new Error(`invalid membership GSI1SK value(s): ${malformedKeys.join(', ')}`);
        }
      },
    },
    {
      label: `DynamoDB household rows for Cognito sub ${fixture.sub}`,
      run: async () => {
        // Smoke-created households are single-member and contain no plants or
        // tasks, so each cleanup is exactly METADATA + MEMBER#<sub>.
        await runAllCleanupSteps(
          [...householdIds].map((householdId) => ({
            label: `household ${householdId}`,
            run: () => deleteHouseholdRows(householdId, fixture.sub),
          }))
        );
      },
    },
    {
      label: `Cognito user ${fixture.username}`,
      run: () => deleteCognitoUser(fixture.username),
    },
  ]);
}

test.describe('public registration smoke', () => {
  let email: string | undefined;
  let username: string | undefined;

  test.afterEach(async () => {
    if (email) await deletePublicSignupUser(email, username);
  });

  test('public /register reaches an unconfirmed, confirmation-ready Cognito account', async ({
    page,
  }) => {
    email = smokeEmail('public');

    await page.goto('/register');
    await page.getByLabel(/full name/i).fill('Public Signup Smoke');
    await page.getByLabel(/email address/i).fill(email);
    await page.locator('input[autocomplete="new-password"]').first().fill(PASSWORD);
    await page.locator('input[autocomplete="new-password"]').nth(1).fill(PASSWORD);

    const signupResponsePromise = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' && new URL(response.url()).pathname.endsWith('/auth/signup')
      );
    });
    await page.getByRole('button', { name: /create account/i }).click();
    const signupResponse = await signupResponsePromise;

    expect(signupResponse.status()).toBe(201);
    await expect(page).toHaveURL(/\/confirm-email/);
    await expect(page.getByText(email)).toBeVisible();

    const createdUser = await findUserByEmail(email, 10);
    expect(createdUser?.UserStatus).toBe('UNCONFIRMED');
    expect(createdUser?.Enabled).toBe(true);
    expect(createdUser?.Username).toBeTruthy();
    username = createdUser?.Username;
  });
});

test.describe('post-deploy smoke', () => {
  let email: string;
  let fixture: ConfirmedFixture | undefined;
  const apiErrors: { url: string; status: number }[] = [];

  test.beforeEach(async ({ page }) => {
    email = smokeEmail('authenticated');
    fixture = await createConfirmedUser(email);
    apiErrors.length = 0;
    page.on('response', (resp) => {
      const url = resp.url();
      const status = resp.status();
      if (status >= 400 && url.startsWith(`${API_URL}/`)) {
        apiErrors.push({ url, status });
      }
    });
  });

  test.afterEach(async () => {
    if (fixture) await deleteUserAndHouseholds(fixture);
  });

  test('fresh user → login → onboarding → dashboard renders cleanly', async ({ page }) => {
    const activeFixture = fixture;
    if (!activeFixture) throw new Error('Confirmed smoke fixture was not created');

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();

    // First sign-in lands on onboarding (no household yet).
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });

    // Pick "Create a new household".
    await page.getByRole('button', { name: /create a new household/i }).click();
    await page.getByLabel(/household name/i).fill('Smoke Test Household');
    const householdResponsePromise = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' && new URL(response.url()).pathname.endsWith('/households')
      );
    });
    await page.getByRole('button', { name: /create household/i }).click();
    const householdResponse = await householdResponsePromise;
    expect(householdResponse.status()).toBe(201);
    activeFixture.householdId = householdIdFromCreateResponse(await householdResponse.json());

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
