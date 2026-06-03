import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';
import { requireEnv } from './env.js';

// Wrap the low-level DynamoDB client with X-Ray so every Query / GetItem /
// PutItem / UpdateItem shows up as its own subsegment in the trace. The
// DocumentClient is a thin marshalling wrapper around this same client,
// so instrumenting once at the bottom captures every call site.
const client = AWSXRay.captureAWSv3Client(
  new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1',
  })
);

export const dynamodb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

export const TABLE_NAME = requireEnv('TABLE_NAME');
