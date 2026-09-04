import { S3Client } from '@aws-sdk/client-s3';
import { requireEnv } from './env.js';

export const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
});

export const IMAGES_BUCKET = requireEnv('IMAGES_BUCKET');

/**
 * Public base URL for a stored image key. When ASSETS_BASE_URL is set
 * (production: the site origin, served via the CloudFront /plants/*
 * behavior) we mint `${ASSETS_BASE_URL}/plants/...`; otherwise (local dev)
 * the raw S3 URL form. Same rule the member upload flow in
 * handlers/plants/handler.ts applies at presign time.
 */
export function publicImageUrl(key: string): string {
  const base = process.env.ASSETS_BASE_URL?.replace(/\/+$/, '');
  if (base) return `${base}/${key}`;
  return `https://${IMAGES_BUCKET}.s3.amazonaws.com/${key}`;
}
