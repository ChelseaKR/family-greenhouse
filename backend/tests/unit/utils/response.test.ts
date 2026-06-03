import { describe, it, expect } from 'vitest';
import {
  successResponse,
  createdResponse,
  noContentResponse,
} from '../../../src/utils/response.js';

describe('response helpers', () => {
  it('successResponse defaults to 200 and JSON body', () => {
    const res = successResponse({ ok: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('successResponse honors custom status', () => {
    const res = successResponse({}, 202);
    expect(res.statusCode).toBe(202);
  });

  // errorResponse was removed 2026-06-01 — handlers throw via createHttpError
  // instead, and the http-error-handler middleware formats the body.

  it('createdResponse returns 201', () => {
    const res = createdResponse({ id: 'x' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ id: 'x' });
  });

  it('noContentResponse returns 204 with empty body', () => {
    const res = noContentResponse();
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });
});
