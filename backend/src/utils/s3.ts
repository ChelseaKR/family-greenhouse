import { S3Client } from '@aws-sdk/client-s3';
import { requireEnv } from './env.js';

export const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
});

export const IMAGES_BUCKET = requireEnv('IMAGES_BUCKET');

/**
 * The stored REFERENCE for an image key: `${ASSETS_BASE_URL}/plants/...` when
 * ASSETS_BASE_URL is set (production: the site origin), otherwise (local dev)
 * the raw S3 URL form. Same rule the member upload flow in
 * handlers/plants/handler.ts applies at presign time.
 *
 * It names the object and serves nothing: the images bucket is private and
 * CloudFront has no path to it. A photo is shown only through a signed URL
 * minted per response (services/photoAccess.ts, ADR 0033).
 */
export function publicImageUrl(key: string): string {
  const base = process.env.ASSETS_BASE_URL?.replace(/\/+$/, '');
  if (base) return `${base}/${key}`;
  return `https://${IMAGES_BUCKET}.s3.amazonaws.com/${key}`;
}
