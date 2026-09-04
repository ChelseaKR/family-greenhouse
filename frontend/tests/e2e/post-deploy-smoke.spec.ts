/**
 * Post-deploy smoke test against a real deployed environment.
 *
 * What this catches: the regression you can't see in unit/integration tests
 * because they don't run against the real Cognito/API Gateway. Specifically,
 * it asserts that public registration reaches Cognito's confirmation-ready
 * state, and that a separate confirmed fixture can sign in, create a
 * household, load the dashboard without 403s, and create a plant photo through
 * the real API Gateway → presign → S3 PUT → confirm → rendered-image path.
 * That includes the 2026-05-31 access-token-vs-id-token regression and the
 * deployed storage/CORS/CDN integration that local object-store tests replace.
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
import { fileURLToPath } from 'node:url';
import { test, expect, type APIResponse, type Page } from '@playwright/test';
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
import { S3Client, DeleteObjectsCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import {
  buildSmokeEmail,
  householdIdFromCreateResponse,
  householdIdFromMembershipItem,
  isAmazonS3Hostname,
  purgeExactSmokeS3Object,
  purgeSmokeOwnedPartitions,
  runAllCleanupSteps,
  s3ObjectTargetFromPresignedUrl,
  safeResponseDiagnostic,
  type SafeResponseDiagnostic,
  type SmokeDynamoKey,
  type SmokeS3ObjectTarget,
} from './post-deploy-smoke-support';

const USER_POOL_ID = process.env.E2E_USER_POOL_ID;
const API_URL = process.env.E2E_API_URL?.replace(/\/+$/, '');
const TABLE_NAME = process.env.E2E_TABLE_NAME ?? 'family-greenhouse-production';
const REGION = process.env.AWS_REGION || 'us-east-1';
const PUBLIC_SIGNUP_EMAIL_TEMPLATE = process.env.E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE;
const SMOKE_PHOTO_PATH = fileURLToPath(
  new URL('../../public/brand/favicon-64.png', import.meta.url)
);

if (!USER_POOL_ID) {
  throw new Error('E2E_USER_POOL_ID is required for post-deploy smoke tests');
}
if (!API_URL) {
  throw new Error('E2E_API_URL is required for post-deploy smoke tests');
}

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

function smokeEmail(kind: 'public' | 'authenticated'): string {
  // The operator owns the template and must point it at a mailbox that accepts
  // the generated tags. This test deliberately has no invented-domain fallback:
  // Cognito sends real confirmation/welcome email, and fake local parts create
  // hard bounces that damage SES reputation.
  const stamp = randomUUID().replace(/-/g, '').slice(0, 12);
  return buildSmokeEmail(PUBLIC_SIGNUP_EMAIL_TEMPLATE, `${kind}-${stamp}`);
}

const PASSWORD = 'E2E-Smoke!Pass1234';

function assertResponseStatus(response: APIResponse, expected: number, label: string): void {
  if (response.status() === expected) return;
  const diagnostic = safeResponseDiagnostic(response.url(), response.status());
  throw new Error(
    `${label} failed: ${diagnostic.hostname} returned ${diagnostic.status}; expected ${expected}`
  );
}

function parseUrlWithoutEcho(rawUrl: string, label: string): URL {
  try {
    return new URL(rawUrl);
  } catch {
    throw new Error(`${label} was not a valid URL`);
  }
}

function imageUploadUrlsFromResponse(payload: unknown): { uploadUrl: URL; imageUrl: URL } {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('uploadUrl' in payload) ||
    typeof payload.uploadUrl !== 'string' ||
    !('imageUrl' in payload) ||
    typeof payload.imageUrl !== 'string'
  ) {
    throw new Error('Image presign response did not contain uploadUrl and imageUrl');
  }

  const uploadUrl = parseUrlWithoutEcho(payload.uploadUrl, 'Image presign uploadUrl');
  const imageUrl = parseUrlWithoutEcho(payload.imageUrl, 'Image presign imageUrl');
  if (uploadUrl.protocol !== 'https:' || !isAmazonS3Hostname(uploadUrl.hostname)) {
    throw new Error(`Image presign did not target Amazon S3 over HTTPS (${uploadUrl.hostname})`);
  }
  if (imageUrl.protocol !== 'https:') {
    throw new Error(`Image delivery URL was not HTTPS (${imageUrl.hostname})`);
  }
  return { uploadUrl, imageUrl };
}

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

async function listPartitionKeys(partitionKey: string): Promise<SmokeDynamoKey[]> {
  const keys: SmokeDynamoKey[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': { S: partitionKey } },
        ProjectionExpression: 'PK, SK',
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of page.Items ?? []) {
      const PK = item['PK']?.S;
      const SK = item['SK']?.S;
      if (!PK || !SK) {
        throw new Error(`partition ${partitionKey} returned a row without string PK/SK`);
      }
      keys.push({ PK, SK });
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return keys;
}

async function deleteDynamoKeys(keys: SmokeDynamoKey[]): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += 25) {
    let pending: WriteRequest[] = keys.slice(offset, offset + 25).map(({ PK, SK }) => ({
      DeleteRequest: { Key: { PK: { S: PK }, SK: { S: SK } } },
    }));

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
      label: `DynamoDB owned rows for Cognito sub ${fixture.sub}`,
      run: async () => {
        await purgeSmokeOwnedPartitions(
          [`USER#${fixture.sub}`, ...[...householdIds].map((id) => `HOUSEHOLD#${id}`)],
          {
            listKeys: listPartitionKeys,
            deleteKeys: deleteDynamoKeys,
          }
        );
      },
    },
    {
      label: `Cognito user ${fixture.username}`,
      run: () => deleteCognitoUser(fixture.username),
    },
  ]);
}

async function deleteCurrentAccountThroughApi(page: Page): Promise<boolean> {
  const result = await page.evaluate(async (apiUrl) => {
    let bearer = '';
    try {
      const raw = window.localStorage.getItem('auth-storage');
      const parsed = raw ? (JSON.parse(raw) as { state?: Record<string, unknown> }) : null;
      const token = parsed?.state?.['idToken'] ?? parsed?.state?.['accessToken'];
      if (typeof token === 'string') bearer = token;
    } catch {
      // The error below reports a stable cleanup failure without exposing
      // persisted auth data.
    }

    if (!bearer) {
      return { status: 0, hadBearer: false };
    }

    const response = await fetch(`${apiUrl}/me`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bearer}` },
    });
    return { status: response.status, hadBearer: true };
  }, API_URL);

  if (!result.hadBearer) return false;
  if (result.status !== 204) {
    const diagnostic = safeResponseDiagnostic(`${API_URL}/me`, result.status);
    throw new Error(
      `DELETE /me cleanup failed: ${diagnostic.hostname} returned ${diagnostic.status}; expected 204`
    );
  }
  return true;
}

function safeAwsErrorName(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string'
      ? error.name
      : 'AwsError';
  return /^[A-Za-z0-9_.-]{1,80}$/.test(name) ? name : 'AwsError';
}

async function purgeUploadedS3Object(target: SmokeS3ObjectTarget | undefined): Promise<void> {
  await purgeExactSmokeS3Object(target, {
    listVersions: async ({ bucket, prefix, keyMarker, versionIdMarker }) => {
      try {
        const page = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: prefix,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          })
        );
        return {
          versions: page.Versions?.map((version) => ({
            key: version.Key,
            versionId: version.VersionId,
          })),
          deleteMarkers: page.DeleteMarkers?.map((marker) => ({
            key: marker.Key,
            versionId: marker.VersionId,
          })),
          isTruncated: page.IsTruncated,
          nextKeyMarker: page.NextKeyMarker,
          nextVersionIdMarker: page.NextVersionIdMarker,
        };
      } catch (error) {
        throw new Error(`S3 version listing failed (${safeAwsErrorName(error)})`);
      }
    },
    deleteVersions: async ({ bucket, objects }) => {
      let errorCount = 0;
      try {
        const result = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: objects.map(({ key, versionId }) => ({
                Key: key,
                VersionId: versionId,
              })),
              Quiet: true,
            },
          })
        );
        errorCount = result.Errors?.length ?? 0;
      } catch (error) {
        throw new Error(`S3 version deletion failed (${safeAwsErrorName(error)})`);
      }
      if (errorCount > 0) {
        throw new Error(`S3 version deletion returned ${errorCount} error(s)`);
      }
    },
  });
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
  let authenticatedSessionEstablished = false;
  let uploadedS3Target: SmokeS3ObjectTarget | undefined;
  const apiErrors: SafeResponseDiagnostic[] = [];

  test.beforeEach(async ({ page }) => {
    email = smokeEmail('authenticated');
    fixture = await createConfirmedUser(email);
    authenticatedSessionEstablished = false;
    uploadedS3Target = undefined;
    apiErrors.length = 0;
    page.on('response', (resp) => {
      const url = resp.url();
      const status = resp.status();
      if (status >= 400 && url.startsWith(`${API_URL}/`)) {
        apiErrors.push(safeResponseDiagnostic(url, status));
      }
    });
  });

  test.afterEach(async ({ page }) => {
    const activeFixture = fixture;
    if (!activeFixture) return;

    // Start with the same account-erasure path real users invoke, then run
    // administrative resource fallbacks independently. runAllCleanupSteps
    // guarantees the final exact-version S3 purge still runs after any earlier
    // failure, including an assertion failure after the PUT.
    await runAllCleanupSteps([
      {
        label: 'DELETE /me account cleanup',
        run: async () => {
          const deleted = await deleteCurrentAccountThroughApi(page);
          if (authenticatedSessionEstablished && !deleted) {
            throw new Error('authenticated session had no persisted bearer token');
          }
        },
      },
      {
        label: 'Administrative smoke fixture fallback',
        run: () => deleteUserAndHouseholds(activeFixture),
      },
      {
        // Always last and independent: DELETE /me can fail after creating an
        // S3 delete marker, and administrative DDB/Cognito cleanup has no S3
        // semantics. Undefined means the test never reached presign.
        label: 'Exact S3 upload fallback',
        run: () => purgeUploadedS3Object(uploadedS3Target),
      },
    ]);
  });

  test('fresh user → onboarding → real S3 plant photo renders cleanly', async ({ page }) => {
    const activeFixture = fixture;
    if (!activeFixture) throw new Error('Confirmed smoke fixture was not created');

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();

    // First sign-in lands on onboarding (no household yet).
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
    authenticatedSessionEstablished = true;

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
    assertResponseStatus(householdResponse, 201, 'Household creation');
    activeFixture.householdId = householdIdFromCreateResponse(await householdResponse.json());

    // Household creation does NOT land on the dashboard. #394 put the first-run
    // activation flow in between: a household with no plants yet always routes
    // to /welcome (see decideFirstRun). This spec only ever runs post-deploy,
    // so it is the last gate that sees this path before real users do — and a
    // failure here auto-rolls back the release. Walk the flow rather than
    // asserting the destination it had before #394.
    await expect(page).toHaveURL(/\/welcome$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /add your first plant/i })).toBeVisible({
      timeout: 10_000,
    });

    // Skip the guided one-field plant step deliberately: the whole point of
    // this test is the FULL plant form below, which is the only path that
    // exercises presign → S3 PUT → confirm → CDN render.
    await page.getByRole('button', { name: /skip for now/i }).click();

    // Whoever creates the household is its admin, so the invite step follows.
    // Asserting it (rather than tolerating either shape) keeps this honest: if
    // the creator ever stops being an admin, that is a real regression in who
    // can invite, and this should fail rather than quietly skip ahead.
    await expect(page.getByRole('heading', { name: /share the care/i })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: /go to my dashboard/i }).click();

    // Now the dashboard, at /dashboard or '/'.
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

    // Drive the production UI through the complete deployed image contract.
    // The repository PNG is decoded/downscaled by the real browser before the
    // upload, so this exercises frontend processing as well as API/S3/CDN.
    await page
      .getByRole('link', { name: /add plant/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/plants\/new$/);

    const plantName = `S3 Upload Smoke ${Date.now()}`;
    await page.getByLabel(/plant name/i).fill(plantName);
    await page.getByLabel(/choose a photo/i).setInputFiles(SMOKE_PHOTO_PATH);
    await expect(page.getByRole('img', { name: /selected plant photo preview/i })).toBeVisible();

    const plantCreatePromise = page.waitForResponse((response) => {
      const request = response.request();
      return request.method() === 'POST' && new URL(response.url()).pathname.endsWith('/plants');
    });
    const presignPromise = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        /\/plants\/[^/]+\/image$/.test(new URL(response.url()).pathname)
      );
    });
    const s3PutPromise = page.waitForResponse((response) => {
      const diagnostic = safeResponseDiagnostic(response.url(), response.status());
      return response.request().method() === 'PUT' && isAmazonS3Hostname(diagnostic.hostname);
    });
    const confirmPromise = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === 'POST' &&
        /\/plants\/[^/]+\/image\/confirm$/.test(new URL(response.url()).pathname)
      );
    });

    await page.getByRole('button', { name: /^add plant$/i }).click();

    const plantCreateResponse = await plantCreatePromise;
    assertResponseStatus(plantCreateResponse, 201, 'Plant creation');
    const plantPayload = (await plantCreateResponse.json()) as unknown;
    const plantId =
      typeof plantPayload === 'object' &&
      plantPayload !== null &&
      'id' in plantPayload &&
      typeof plantPayload.id === 'string'
        ? plantPayload.id
        : '';
    if (!/^[0-9a-f-]{36}$/i.test(plantId)) {
      throw new Error('Plant creation response did not contain a valid id');
    }

    const presignResponse = await presignPromise;
    assertResponseStatus(presignResponse, 200, 'Image presign');
    if (!new URL(presignResponse.url()).pathname.endsWith(`/plants/${plantId}/image`)) {
      throw new Error('Image presign did not target the plant returned by POST /plants');
    }
    const { uploadUrl, imageUrl } = imageUploadUrlsFromResponse(
      (await presignResponse.json()) as unknown
    );
    const s3Target = s3ObjectTargetFromPresignedUrl(uploadUrl.href);
    const expectedKeyPrefix = `plants/${activeFixture.householdId}/${plantId}/`;
    if (
      !s3Target.key.startsWith(expectedKeyPrefix) ||
      !/^[A-Za-z0-9-]+\.(jpg|png|webp)$/.test(s3Target.key.slice(expectedKeyPrefix.length))
    ) {
      throw new Error('Image presign did not issue the expected plant-scoped S3 key');
    }
    uploadedS3Target = s3Target;

    // Register the delivery assertion as soon as the presign response reveals
    // the public image URL, before the client can finish PUT + confirm + route.
    const renderedImageResponsePromise = page.waitForResponse(
      (response) =>
        response.request().resourceType() === 'image' && response.url() === imageUrl.href
    );

    const s3PutResponse = await s3PutPromise;
    assertResponseStatus(s3PutResponse, 200, 'S3 image upload');
    if (s3PutResponse.url() !== uploadUrl.href) {
      const diagnostic = safeResponseDiagnostic(s3PutResponse.url(), s3PutResponse.status());
      throw new Error(
        `S3 PUT did not use the URL issued by presign (${diagnostic.hostname}, status ${diagnostic.status})`
      );
    }
    const confirmResponse = await confirmPromise;
    assertResponseStatus(confirmResponse, 200, 'Image confirmation');
    if (!new URL(confirmResponse.url()).pathname.endsWith(`/plants/${plantId}/image/confirm`)) {
      throw new Error('Image confirmation did not target the plant returned by POST /plants');
    }
    let confirmPayload: unknown;
    try {
      confirmPayload = confirmResponse.request().postDataJSON() as unknown;
    } catch {
      throw new Error('Image confirmation request did not contain JSON');
    }
    if (
      typeof confirmPayload !== 'object' ||
      confirmPayload === null ||
      !('imageUrl' in confirmPayload) ||
      confirmPayload.imageUrl !== imageUrl.href
    ) {
      throw new Error('Image confirmation did not use the URL returned by presign');
    }
    // Playwright does not expose an XMLHttpRequest Blob through
    // request.postDataBuffer(), even when S3 accepted real bytes. A successful
    // confirm is the authoritative non-empty assertion: the API HeadObjects
    // the uploaded key and rejects ContentLength === 0 before returning 200.

    const renderedImageResponse = await renderedImageResponsePromise;
    assertResponseStatus(renderedImageResponse, 200, 'Rendered plant image');
    expect(renderedImageResponse.headers()['content-type']).toMatch(/^image\//i);
    expect(
      (await renderedImageResponse.body()).byteLength,
      'Rendered plant image response body must not be empty'
    ).toBeGreaterThan(0);

    await expect(page).toHaveURL(new RegExp(`/plants/${plantId}$`));
    await expect(page.getByRole('heading', { name: plantName })).toBeVisible();
    const renderedPhoto = page.getByRole('img', { name: `Photo of ${plantName}` });
    await expect(renderedPhoto).toBeVisible();
    await expect
      .poll(() => renderedPhoto.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);

    // And no 403/500 responses observed during the run. Diagnostics contain
    // only hostname + status, never presigned paths or query credentials.
    const fatalApiErrors = apiErrors.filter((e) => e.status === 403 || e.status >= 500);
    expect(fatalApiErrors).toEqual([]);
  });
});
