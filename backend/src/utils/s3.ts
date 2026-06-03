import { S3Client } from '@aws-sdk/client-s3';
import { requireEnv } from './env.js';

export const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
});

export const IMAGES_BUCKET = requireEnv('IMAGES_BUCKET');
