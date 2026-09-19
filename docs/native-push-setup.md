# Native push: owner setup

Native push notifications for the iOS and Android apps are **built and switched
off**. They stay off until every step below is done and checked on a device.
There are two switches, and both default to off:

| Switch                                   | Where                                                                                                  | Default |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| `native_push_enabled` (deployment)       | `infrastructure/environments/production/terraform.tfvars` becomes `NATIVE_PUSH_ENABLED` on the Lambdas | `false` |
| `VITE_NATIVE_PUSH_ENABLED` (store build) | your local `frontend/.env.mobile.production` (the committed template must say `false`)                 | `false` |

While `native_push_enabled` is false, the backend sends no device push, and the
notification preferences tell the apps `devicePush: {ios: false, android:
false}`, so they show no opt-in and no Settings row. That holds whatever
credentials exist. While `VITE_NATIVE_PUSH_ENABLED` is false, the build never
loads the push plugin at all.

**How delivery works.** iOS goes to APNs directly, with a token-based `.p8`
key. Android goes through Firebase Cloud Messaging (FCM). They differ because
`@capacitor/push-notifications` gives the iOS app a raw APNs token, and FCM can
only send to iOS through the Firebase iOS SDK, which this app doesn't embed.
So Firebase is needed for Android only, and the APNs key is **not** uploaded
to Firebase. See `backend/src/services/apnsNotifier.ts` for the full reasoning.

**Credentials never enter the repository.** The APNs key and the Firebase
service-account JSON live in AWS Secrets Manager. Terraform only gets their
secret **names** (not secret) and grants the notification Lambdas
`GetSecretValue` on exactly those two secrets. `google-services.json` is
gitignored and stays on the build machine (`scripts/validate-store-release.mjs`
fails if it or any `.p8` is ever tracked).

Placeholders below are in `<ANGLE_BRACKETS>`. Nothing here changes production
until step 7.

## 1. Firebase project (Android)

1. Go to <https://console.firebase.google.com> → **Add project**, or pick an
   existing one. Name it `family-greenhouse`. Google Analytics for the project:
   **off**. The app declares no Firebase Analytics, and turning it on would add
   a data type to the Play Data safety form.
2. In the project, go to **Add app → Android**:
   - Android package name: `net.familygreenhouse.app`
   - App nickname: `Family Greenhouse Android`
   - Debug signing certificate SHA-1: leave blank (it isn't needed for FCM).
3. **Download `google-services.json`**, and put it at
   `frontend/android/app/google-services.json` on the build machine only. The
   Gradle build applies the Google services plugin only when that file exists.
   Skip the "Add Firebase SDK" steps, because the Capacitor plugin already
   includes it.
4. Don't add an iOS app to this Firebase project. iOS doesn't use FCM (see
   above), so there's no `GoogleService-Info.plist` to download, and none
   should be added to the Xcode project.

## 2. FCM sender credential (Android)

1. In Firebase, go to **Project settings → Service accounts → Generate new
   private key**. This downloads a JSON file with `project_id`, `client_email`
   and `private_key`.
2. Check that **Firebase Cloud Messaging API (V1)** shows as **Enabled**
   under **Project settings → Cloud Messaging**. The legacy API isn't used.
3. Store the JSON in Secrets Manager (us-east-1), then **delete the
   downloaded file**:

   ```bash
   aws secretsmanager create-secret \
     --region us-east-1 \
     --name family-greenhouse/production/fcm-service-account \
     --description "Firebase service account for Android push (FCM HTTP v1)" \
     --secret-string file://<PATH_TO_DOWNLOADED_SERVICE_ACCOUNT>.json
   rm <PATH_TO_DOWNLOADED_SERVICE_ACCOUNT>.json
   ```

## 3. APNs auth key (iOS)

1. Go to Apple Developer → **Certificates, Identifiers & Profiles → Keys**,
   then **+**. Name it `Family Greenhouse APNs`, tick **Apple Push
   Notifications service (APNs)**, then choose **Configure → Sandbox &
   Production**. **Continue → Register**.
2. **Download the `.p8` file.** Apple lets you download it only once. Note
   the **Key ID** (10 characters) shown on the key's page. The Team ID is
   `6X5YH93QNM` (Membership details, not the Enrollment ID).
3. Under **Identifiers → `net.familygreenhouse.app`**, make sure **Push
   Notifications** is ticked. `App.entitlements` already declares
   `aps-environment`, and Release builds use `production`.
4. Store the key as JSON in Secrets Manager, then **delete the `.p8`** (keep
   an offline backup only if you want one; Apple never shows it again):

   ```bash
   aws secretsmanager create-secret \
     --region us-east-1 \
     --name family-greenhouse/production/apns-auth-key \
     --description "APNs token-based auth key for iOS push" \
     --secret-string "$(jq -n \
       --arg keyId '<APNS_KEY_ID>' \
       --arg teamId '6X5YH93QNM' \
       --rawfile privateKey '<PATH_TO>/AuthKey_<APNS_KEY_ID>.p8' \
       '{keyId: $keyId, teamId: $teamId, privateKey: $privateKey}')"
   rm '<PATH_TO>/AuthKey_<APNS_KEY_ID>.p8'
   ```

   The backend refuses (and logs `apns_credentials_unavailable`) if the Key ID
   or Team ID isn't 10 characters, or if the value isn't a private key.

## 4. Point Terraform at the secrets (switch still off)

In `infrastructure/environments/production/terraform.tfvars`:

```hcl
native_push_enabled           = false   # still off
fcm_service_account_secret_id = "family-greenhouse/production/fcm-service-account"
apns_auth_key_secret_id       = "family-greenhouse/production/apns-auth-key"
apns_environment              = "production"
```

Merge that as its own PR. It deploys with the next release tag. With the
switch still off, the only effect is the Lambdas' environment and IAM grant.

**No `gh secret set` is needed for push.** The two values Terraform gets are
secret **names**, which aren't sensitive, and the key material goes straight
from your machine into Secrets Manager without passing through GitHub. To
confirm both secrets exist under the names Terraform expects:

```bash
aws secretsmanager describe-secret --region us-east-1 \
  --secret-id family-greenhouse/production/apns-auth-key --query ARN
aws secretsmanager describe-secret --region us-east-1 \
  --secret-id family-greenhouse/production/fcm-service-account --query ARN
```

## 5. Build the apps with push

In your local `frontend/.env.mobile.production` (gitignored), set:

```bash
VITE_NATIVE_PUSH_ENABLED=true
```

Then run `npm run mobile:release -- frontend/.env.mobile.production`. With
`VITE_NATIVE_PUSH_ENABLED=true`, the release validator refuses to build unless
`frontend/android/app/google-services.json` exists and names
`net.familygreenhouse.app`, and it always requires the iOS `aps-environment`
entitlement.

## 6. Test on staging first (optional but recommended)

Repeat steps 2 to 4 with `family-greenhouse/staging/...` names in
`infrastructure/environments/staging/terraform.tfvars`, and set
`native_push_enabled = true` there. Use `apns_environment = "sandbox"` for a
build run from Xcode, and `"production"` for TestFlight.

## 7. Turn it on in production

In `infrastructure/environments/production/terraform.tfvars`, set:

```hcl
native_push_enabled = true
```

This is a PR. It takes effect with the next release tag, which you create.

## 8. Check on a device

On a TestFlight build and a Play internal-testing build carrying step 5, work
through each of these:

1. Settings → Notifications shows **This device → Turn on**, and the Tasks page
   shows the opt-in card while there's care on the list. Nothing is asked at
   launch.
2. Tap **Turn on**. The OS asks once. Allow it.
3. Trigger a reminder (a task due today, outside your quiet hours; an admin
   can call `POST /notifications/run-reminders`). It arrives on the phone
   with the task count on the app icon. Tapping it opens `/tasks`.
4. Set quiet hours around now and run it again. Nothing arrives until the
   window ends.
5. Sign out, then sign in as a different account. The first account's
   reminders stop arriving on that phone.
6. Deny the permission in the phone's Settings and reopen the app. The row
   explains how to turn it back on, and the device is removed server-side.

Logs to watch (CloudWatch, notification Lambdas):

- `apns_send_failed` with `reason`: `BadDeviceToken` means the build's APNs
  environment and `apns_environment` disagree. `InvalidProviderToken` means a
  wrong Key ID or Team ID.
- `device_push_failed` (FCM).
- `apns_credentials_unavailable` / `device_push_credentials_unavailable` mean
  the secret isn't readable.

## 9. Store listings

Once it's on and verified:

- App Store privacy label: **Device ID**, linked to the user, not used for
  tracking, purpose App Functionality. It's already declared in
  `PrivacyInfo.xcprivacy`. The push token is a device identifier used only to
  deliver the app's own notifications, never for advertising, analytics or
  tracking. See docs/APP-STORE.md.
- Play Data safety: **Device or other IDs**, collected, not shared, purpose
  App functionality, and optional (only when the person turns notifications
  on).
- The listing's "reminders are email-only" line
  (`docs/mobile-release-checklist.md`) can change once a store build carries
  push.

## Turning it off again

Set `native_push_enabled = false` and ship a release. Sending stops, and the
apps stop offering it. Registered devices stay registered, so turning it back
on resumes without anyone opting in again. To remove the credentials entirely:

```bash
aws secretsmanager delete-secret --region us-east-1 \
  --secret-id family-greenhouse/production/apns-auth-key --recovery-window-in-days 7
aws secretsmanager delete-secret --region us-east-1 \
  --secret-id family-greenhouse/production/fcm-service-account --recovery-window-in-days 7
```

Then revoke the APNs key in Apple Developer → Keys, and delete the service
account key in Firebase → Project settings → Service accounts.
