/**
 * Server-side ad-conversion reporting for Google Ads and Meta
 * (Facebook/Instagram) — the two paid-acquisition channels under
 * evaluation (docs/paid-acquisition-readiness.md).
 *
 * Fires from the same two trusted, at-most-once backend seams
 * `capture()` (serverAnalytics.ts) already uses as the product-analytics
 * source of truth:
 *
 *   - signup_completed  — POST /auth/confirm, once Cognito confirms the
 *                          email (handlers/auth/handler.ts). The browser
 *                          holds no JWT yet at that point, so this is a
 *                          trusted backend event, not a client pixel.
 *   - subscription_paid — the Stripe webhook, once a subscription reaches
 *                          `active` from a non-active status (the
 *                          money-moved signal; services/billing.ts). Reuses
 *                          the exact `isNew` + status-transition guard
 *                          already gating `capture()` there, so this can
 *                          never double-fire on a Stripe redelivery.
 *
 * FULLY INERT today. No ad-platform credential is configured in any
 * environment (`GOOGLE_ADS_*`, `META_CAPI_*` are unset everywhere), so
 * `reportAdConversion` currently does nothing but return immediately. This
 * module creates no ad account, spends no money, and is not wired to a
 * real conversion ID — see the file for the exact env vars an owner would
 * set to activate each platform, once she has created the ad account and
 * has real IDs to put there.
 *
 * Server-side over a client-side pixel, on purpose:
 *   - Needs no browser cookie or blockable third-party script — consistent
 *     with the cookieless posture already adopted for PostHog (see
 *     docs/analytics.md and services/analytics.ts's `EventName` doc
 *     comments, which this module's two event names are drawn from
 *     verbatim rather than inventing new ones).
 *   - Fires from a guard that already de-duplicates (webhook redelivery;
 *     one confirmation per signup), so it can't double-count the way a
 *     client script re-firing on back-navigation or a retried XHR can.
 *   - An ad blocker cannot suppress it, unlike a client-side pixel.
 *
 * Known gap (documented, not built here): neither platform's conversion
 * actually ATTRIBUTES to an ad without a click identifier (Google's
 * `gclid`/`gbraid`/`wbraid`, Meta's `fbclid`/`fbc`). This app captures
 * none today (grep confirms no `gclid`/`fbclid` reference exists anywhere
 * in frontend/src as of this writing). `hashedEmail` alone lets Meta's
 * Conversions API attempt probabilistic/deterministic matching at reduced
 * quality; Google Ads has no path to attribute a conversion at all without
 * a click id. Capturing and passing through a click id is Phase 2, laid
 * out in docs/paid-acquisition-readiness.md — deliberately not built in
 * this pass since it touches the registration payload and has zero users
 * to validate against before real campaigns exist.
 *
 * Never throws to its caller — same contract as `capture()`. An ad
 * platform outage or a bad credential must never fail a signup
 * confirmation or a Stripe webhook.
 */

import { createHash } from 'node:crypto';
import { logger } from './logger.js';

export type AdConversionName = 'signup_completed' | 'subscription_paid';

export interface AdConversionProps {
  /** Plan the household paid for. `subscription_paid` only. */
  plan?: 'garden' | 'greenhouse';
  /**
   * USD value of the conversion, when known — the plan's `monthlyPrice`
   * from `models/plans.ts`. Feeds Target ROAS / value-based bidding once
   * campaigns exist. Callers must pass the real catalog price; never
   * fabricate one here.
   */
  valueUsd?: number;
  /**
   * Lower-cased, trimmed email, HASHED BY THE CALLER before this function
   * ever sees it (see `hashEmail` below). This module never receives,
   * logs, or forwards a raw email — matching the "never send email... in
   * product analytics" posture `serverAnalytics.ts` already documents for
   * the first-party rail.
   */
  hashedEmail?: string;
}

/** SHA-256 hex digest of a lower-cased, trimmed email — the join key both
 *  Google Ads Enhanced Conversions and Meta's Conversions API expect for
 *  email-based matching. Call at the point where the raw email is already
 *  in hand (e.g. the confirm-email handler); never persist the raw value
 *  alongside the hash. */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function isGoogleAdsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_ADS_CONVERSION_ID);
}

function isMetaCapiConfigured(): boolean {
  return Boolean(process.env.META_CAPI_PIXEL_ID && process.env.META_CAPI_ACCESS_TOKEN);
}

/**
 * Best-effort, fire-and-forget ad-conversion report. No-ops completely
 * (no network call, not even a log line past the initial trace) when
 * neither platform is configured — which is every environment today.
 */
export async function reportAdConversion(
  event: AdConversionName,
  props: AdConversionProps = {}
): Promise<void> {
  if (!isGoogleAdsConfigured() && !isMetaCapiConfigured()) return;

  logger.info(
    {
      msg: 'ad_conversion_report',
      event,
      plan: props.plan,
      hasHashedEmail: Boolean(props.hashedEmail),
    },
    'ad_conversion_report'
  );

  try {
    // sendToGoogleAds is synchronous today (documented stub, no request
    // sent); called directly rather than folded into the Promise.all below
    // so a real async implementation later is a one-line change here.
    sendToGoogleAds(event, props);
    await sendToMetaCapi(event, props);
  } catch {
    // Never throw — see file header. An ad-platform outage must not fail
    // the signup confirmation or the Stripe webhook it's attached to.
  }
}

/**
 * NOT YET IMPLEMENTED. Google Ads' conversion-upload path (Enhanced
 * Conversions for Leads via `ConversionUploadService`) needs OAuth2 (client
 * id/secret + a long-lived refresh token from the ad account owner), a
 * developer token, and a customer id — none of which exist until Chelsea
 * creates the ad account and completes Google's own developer-token
 * approval. `GOOGLE_ADS_CONVERSION_ID` is checked so the gate above is
 * exercisable in a test, but this stays a stub — see
 * docs/paid-acquisition-readiness.md §5 for the exact fields to wire once
 * those credentials exist, rather than shipping an untestable guess at the
 * request shape now.
 */
function sendToGoogleAds(_event: AdConversionName, _props: AdConversionProps): void {
  if (!isGoogleAdsConfigured()) return;
  logger.warn(
    { msg: 'ad_conversion_google_not_implemented' },
    'GOOGLE_ADS_CONVERSION_ID is set but the upload call is not implemented yet — see docs/paid-acquisition-readiness.md §5'
  );
}

/**
 * Meta Conversions API — a plain authenticated REST POST, so (unlike
 * Google Ads) this is a real, working call once `META_CAPI_PIXEL_ID` and
 * `META_CAPI_ACCESS_TOKEN` are set to real values. `event_name` uses Meta's
 * own standard-event vocabulary (`CompleteRegistration` /
 * `Subscribe`), matched from this module's app-internal event names so
 * Meta's reporting UI recognizes them without custom-event setup.
 */
async function sendToMetaCapi(event: AdConversionName, props: AdConversionProps): Promise<void> {
  if (!isMetaCapiConfigured()) return;

  const pixelId = process.env.META_CAPI_PIXEL_ID;
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  const metaEventName = event === 'signup_completed' ? 'CompleteRegistration' : 'Subscribe';

  const userData: Record<string, unknown> = {};
  if (props.hashedEmail) userData.em = [props.hashedEmail];

  const body = {
    data: [
      {
        event_name: metaEventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'system_generated',
        user_data: userData,
        custom_data: {
          ...(props.valueUsd !== undefined ? { value: props.valueUsd, currency: 'USD' } : {}),
          ...(props.plan ? { content_name: props.plan } : {}),
        },
      },
    ],
  };

  await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${accessToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
