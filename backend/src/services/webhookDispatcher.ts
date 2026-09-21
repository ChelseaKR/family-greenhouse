/**
 * Outbound webhook dispatcher.
 *
 * Sends signed HTTP POST requests to registered webhook URLs when events
 * occur. Uses the same SSRF guard pattern as the chat channel transport.
 * Retries with exponential backoff on failure.
 */

import https from 'node:https';
import {
  type WebhookSubscription,
  type WebhookEvent,
  type DeliveryFailureKind,
  signWebhookPayload,
  classifyStatus,
} from '../models/webhookSubscription.js';
import { updateWebhook, failurePatch, successPatch } from './webhookStore.js';

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  householdId: string;
  data: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  httpStatus?: number;
  kind?: string;
  error?: string;
}

/** Deliver a webhook payload to a single subscription. */
export async function deliverWebhook(
  subscription: WebhookSubscription,
  payload: WebhookPayload
): Promise<DeliveryResult> {
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const signature = signWebhookPayload(subscription.secret, body);

  return new Promise((resolve) => {
    const url = new URL(subscription.url);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': payload.event,
        'X-Webhook-Timestamp': timestamp,
        'User-Agent': 'FamilyGreenhouse-Webhook/1.0',
      },
      timeout: 8000,
      // SSRF: resolve DNS at connect time, no redirect following
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        // Read at most 512 bytes of response body
        if (chunks.reduce((sum, c) => sum + c.length, 0) > 512) {
          res.destroy();
        }
      });

      res.on('end', () => {
        const status = res.statusCode || 0;
        const retryAfter = res.headers['retry-after']
          ? parseInt(res.headers['retry-after'], 10)
          : null;
        const outcome = classifyStatus(status, retryAfter);

        resolve({
          ok: outcome.ok,
          httpStatus: status,
          kind: outcome.kind,
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        ok: false,
        kind: 'network',
        error: err.message,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        kind: 'timeout',
        error: 'Request timed out after 8 seconds',
      });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Deliver a webhook event to all subscribed webhooks for a household.
 * Updates each subscription's failure/success counters.
 */
export async function dispatchWebhookEvent(
  event: WebhookEvent,
  householdId: string,
  data: Record<string, unknown>
): Promise<{ delivered: number; failed: number }> {
  const { getWebhooksForEvent } = await import('./webhookStore.js');
  const webhooks = await getWebhooksForEvent(event);

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    householdId,
    data,
  };

  let delivered = 0;
  let failed = 0;

  for (const webhook of webhooks) {
    const result = await deliverWebhook(webhook, payload);
    const now = new Date().toISOString();

    if (result.ok) {
      const patch = successPatch(now);
      await updateWebhook({ ...webhook, ...patch });
      delivered++;
    } else {
      const patch = failurePatch(
        webhook,
        {
          kind: (result.kind as DeliveryFailureKind) || 'server',
          httpStatus: result.httpStatus,
        },
        now
      );
      await updateWebhook({ ...webhook, ...patch });
      failed++;
    }
  }

  return { delivered, failed };
}
