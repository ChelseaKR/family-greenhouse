/**
 * Leaf-health check: a narrow, deliberately-scoped vision call to Claude on
 * Bedrock. The model is asked ONE thing — "what does this leaf visibly look
 * like?" (yellowing, browning edges, wilting, spots, visible pests) — and is
 * required to answer in strict JSON. This is the roadmap's "cosmetic-grade
 * only, never diagnostic" first slice of CV health detection.
 *
 * Mirrors services/chat/bedrock.ts: same InvokeModel transport, same model
 * env (BEDROCK_CHAT_MODEL_ID), same Anthropic Messages payload shape — but a
 * separate client wrapper so the chat subsystem stays untouched. Vision rides
 * the exact same InvokeModel API; the image is an Anthropic image content
 * block ({ type: 'image', source: { type: 'base64', media_type, data } }).
 *
 * Demo mode: when Bedrock isn't reachable for ACCESS reasons (no credentials,
 * AccessDenied, model-access not granted) we return a canned 'monitor'
 * assessment flagged `demo: true`, mirroring identify's not-configured
 * fallback. We can't gate on the env var alone — Terraform intentionally
 * passes BEDROCK_CHAT_MODEL_ID="" to mean "use code default" while the
 * Lambda role DOES have Bedrock access, so env-emptiness is not a signal.
 * Genuine runtime failures (timeout, throttle, malformed output) still throw
 * so the handler can surface a 502.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import AWSXRay from 'aws-xray-sdk-core';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
// Same model + default as the chat wrapper (see bedrock.ts for the `||` and
// inference-profile rationale). Haiku is plenty for "describe this leaf".
const MODEL_ID = process.env.BEDROCK_CHAT_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const client = AWSXRay.captureAWSv3Client(new BedrockRuntimeClient({ region: REGION }));

/** Same 5s bound as the other external calls (plant.id, perenual, weather). */
const TIMEOUT_MS = 5000;

/** Hard cap on the model's reply — the JSON answer is a few hundred tokens. */
const MAX_OUTPUT_TOKENS = 700;

export type LeafHealthOverall = 'healthy' | 'monitor' | 'concern';
export type LeafHealthConfidence = 'low' | 'medium' | 'high';

export interface LeafHealthObservation {
  sign: string;
  confidence: LeafHealthConfidence;
  note: string;
}

export interface LeafHealthAssessment {
  overall: LeafHealthOverall;
  observations: LeafHealthObservation[];
  suggestion: string;
  disclaimer: string;
  /** True when Bedrock wasn't reachable and this is the canned fallback. */
  demo?: boolean;
}

/**
 * Thrown when the model responded but its output couldn't be parsed into the
 * strict schema. Handlers match on `name` (not instanceof) so test automocks
 * keep working — same convention as PlanLimitError.
 */
export class LeafHealthParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeafHealthParseError';
  }
}

/** Strict response contract the model must emit. Anything else is a 502. */
const assessmentSchema = z.object({
  overall: z.enum(['healthy', 'monitor', 'concern']),
  observations: z
    .array(
      z.object({
        sign: z.string().min(1).max(120),
        confidence: z.enum(['low', 'medium', 'high']),
        note: z.string().min(1).max(500),
      })
    )
    .max(10),
  suggestion: z.string().min(1).max(1000),
  disclaimer: z.string().min(1).max(500),
});

const SYSTEM_PROMPT = [
  'You are a plant-leaf condition checker for a family plant-care app.',
  'Assess ONLY what is visible on the leaf/leaves in the photo: yellowing,',
  'browning edges, wilting, spots or lesions, and visible pests. Do NOT',
  'diagnose diseases, do not guess at root causes you cannot see, and do not',
  'comment on anything other than visible leaf condition.',
  '',
  'Respond with ONLY a single JSON object — no prose, no markdown fences —',
  'exactly matching this shape:',
  '{',
  '  "overall": "healthy" | "monitor" | "concern",',
  '  "observations": [{ "sign": string, "confidence": "low" | "medium" | "high", "note": string }],',
  '  "suggestion": string,',
  '  "disclaimer": string',
  '}',
  '',
  '"observations" lists each visible sign (empty array when the leaf looks',
  'fine). "suggestion" is one short, practical next step a home plant owner',
  'can take. "disclaimer" must state this is a cosmetic visual check from a',
  'single photo, not a plant-health diagnosis. If the image does not clearly',
  'show a leaf, use overall "monitor" with an observation explaining that.',
].join('\n');

/** Allowlisted media types for the Anthropic image block. */
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Split an incoming image string (data URL or bare base64) into the
 * media_type + data the Anthropic image source block requires. Bare base64
 * defaults to JPEG — that's what phone cameras and our downscaler emit when
 * WebP isn't available.
 */
export function parseImageInput(image: string): { mediaType: string; data: string } {
  const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(image);
  if (m && MEDIA_TYPES.has(m[1].toLowerCase())) {
    return { mediaType: m[1].toLowerCase(), data: m[2] };
  }
  return { mediaType: 'image/jpeg', data: m ? m[2] : image };
}

const DEMO_ASSESSMENT: LeafHealthAssessment = {
  demo: true,
  overall: 'monitor',
  observations: [
    {
      sign: 'demo mode',
      confidence: 'low',
      note: 'Image analysis is not configured on this server, so this is a canned example result.',
    },
  ],
  suggestion:
    'Keep an eye on the leaf over the next week and compare against a new photo. (Demo response — no analysis was performed.)',
  disclaimer: 'This is a cosmetic visual check from a single photo, not a plant-health diagnosis.',
};

/**
 * Error names/codes the AWS SDK raises when the problem is "this deployment
 * cannot use Bedrock" rather than "this request failed". These get the demo
 * fallback; everything else propagates.
 */
const ACCESS_ERROR_NAMES = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'CredentialsProviderError',
  'ExpiredTokenException',
  'InvalidSignatureException',
]);

function isAccessError(err: unknown): boolean {
  return err instanceof Error && ACCESS_ERROR_NAMES.has(err.name);
}

/** Pull the first {...} span out of the model's text and strict-parse it. */
function extractAssessment(text: string): LeafHealthAssessment {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new LeafHealthParseError('model response contained no JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new LeafHealthParseError('model response was not valid JSON');
  }
  const result = assessmentSchema.safeParse(parsed);
  if (!result.success) {
    throw new LeafHealthParseError('model JSON did not match the assessment schema');
  }
  return result.data;
}

/**
 * Assess visible leaf condition from a base64 image (data URL or bare).
 *
 * Throws LeafHealthParseError when the model answered but unparseably (the
 * handler maps that to an exposed 502 "could not analyze"), and rethrows
 * transport errors (timeout, throttle) for the generic 502 path. Access
 * errors return the canned demo assessment instead — see module docs.
 */
export async function assessLeafHealth(image: string): Promise<LeafHealthAssessment> {
  const { mediaType, data } = parseImageInput(image);

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data },
          },
          {
            type: 'text',
            text: 'Assess the visible condition of the leaf in this photo. Reply with the JSON object only.',
          },
        ],
      },
    ],
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  // Bound the round-trip so a hung Bedrock connection can't hold the Lambda
  // for the full function timeout — same AbortController pattern as
  // plantIdentification.ts / weather.ts.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let result: InvokeModelCommandOutput;
  try {
    result = await client.send(command, { abortSignal: ctrl.signal });
  } catch (err) {
    if (isAccessError(err)) {
      logger.warn(
        { err: (err as Error).name, modelId: MODEL_ID },
        'leaf_health_bedrock_unavailable_demo_fallback'
      );
      return DEMO_ASSESSMENT;
    }
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Bedrock timed out after ${TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const decoded = JSON.parse(new TextDecoder().decode(result.body)) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { type?: string; message?: string };
  };

  const text = decoded.content?.find((b) => b.type === 'text')?.text;
  if (!text) {
    // Same HTTP-200-error-envelope quirk handled in bedrock.ts.
    logger.error({ decoded, modelId: MODEL_ID }, 'leaf_health_unexpected_shape');
    throw new Error(decoded.error?.message ?? 'Bedrock returned no text content');
  }

  const assessment = extractAssessment(text);

  logger.info(
    {
      modelId: MODEL_ID,
      inputTokens: decoded.usage?.input_tokens,
      outputTokens: decoded.usage?.output_tokens,
      overall: assessment.overall,
      observations: assessment.observations.length,
    },
    'leaf_health_assessed'
  );

  return assessment;
}
