import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createLogger, withRequest, currentTraceId } from '../../../src/utils/logger.js';

/**
 * Structured-logging contract (OBS-09/10/12).
 *
 * These tests run the *real* logger configuration (via `createLogger`
 * with an in-memory destination — the singleton uses the same factory)
 * and pin the three promises the observability docs make about our
 * CloudWatch lines:
 *
 *  - OBS-09: every emitted record is exactly one newline-terminated line
 *    of JSON — the NDJSON shape `jq`/CloudWatch Insights parse. Where a
 *    real `jq` binary exists (ubuntu runners and stock macOS both ship
 *    one) the lines are additionally piped through it.
 *  - OBS-10: required fields — `service`, `env`, a *label* `level` (not
 *    pino's numeric default), `msg`, plus the request-scoped context
 *    (`requestId`, `userId`, `householdId`, `traceId`) bound by
 *    `withRequest`. Timestamps are delegated to CloudWatch by design.
 *  - OBS-12 (unit half): `currentTraceId()` extracts the X-Ray root id
 *    from `_X_AMZN_TRACE_ID`; the middleware wiring is covered in
 *    tests/unit/middleware/logging.test.ts.
 */

function captureLogger() {
  const lines: string[] = [];
  const log = createLogger({ write: (chunk: string) => void lines.push(chunk) });
  // The factory honors NODE_ENV=test's silent default; raise the level so
  // the capture actually sees output without faking a non-test env.
  log.level = 'info';
  return { log, lines };
}

const jqAvailable = (() => {
  try {
    execFileSync('jq', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('structured log output (OBS-09)', () => {
  it('emits one newline-terminated JSON line per record', () => {
    const { log, lines } = captureLogger();
    log.info('plain message');
    log.info({ requestId: 'req-1' }, 'with fields');
    log.error({ err: new Error('boom') }, 'error record');

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      // Exactly one line — no embedded newlines that would break
      // line-oriented consumers (jq -c, CloudWatch Insights, grep).
      expect(line.slice(0, -1)).not.toContain('\n');
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it.skipIf(!jqAvailable)('every line parses under a real jq binary', () => {
    const { log, lines } = captureLogger();
    log.info({ requestId: 'req-jq', nested: { a: 1 } }, 'jq check');
    log.warn('second line');

    // `jq -e .` exits non-zero on invalid JSON — execFileSync throws,
    // failing the test.
    const out = execFileSync('jq', ['-e', '.msg'], { input: lines.join(''), stdio: 'pipe' })
      .toString()
      .trim()
      .split('\n');
    expect(out).toEqual(['"jq check"', '"second line"']);
  });

  it('serializes Error objects into inspectable JSON, not "[object Object]"', () => {
    const { log, lines } = captureLogger();
    log.error({ err: new Error('kaput') }, 'handler_error');
    const record = JSON.parse(lines[0]);
    expect(record.err.message).toBe('kaput');
    expect(record.err.stack).toContain('kaput');
  });
});

describe('required fields (OBS-10)', () => {
  it('every record carries service, env, a label level, and msg', () => {
    const { log, lines } = captureLogger();
    log.info('request');
    const record = JSON.parse(lines[0]);
    expect(record.service).toBe('family-greenhouse');
    expect(record.env).toBeTruthy();
    // formatters.level maps pino's numeric level to the human label —
    // CloudWatch Insights filters on `level = "error"`, not 50.
    expect(record.level).toBe('info');
    expect(record.msg).toBe('request');
  });

  it('withRequest binds requestId/userId/householdId/traceId onto every child record', () => {
    const { log, lines } = captureLogger();
    const child = withRequest(
      { requestId: 'req-9', userId: 'user-3', householdId: 'hh-7', traceId: '1-abc-def' },
      log
    );
    child.info('response');
    child.error('handler_error');

    for (const line of lines) {
      const record = JSON.parse(line);
      expect(record.requestId).toBe('req-9');
      expect(record.userId).toBe('user-3');
      expect(record.householdId).toBe('hh-7');
      expect(record.traceId).toBe('1-abc-def');
    }
  });

  it('withRequest defaults to the shared singleton logger', () => {
    // No destination to capture here — just pin that the default-base
    // path returns a child that inherits the singleton's level config.
    const child = withRequest({ requestId: 'req-solo' });
    expect(child.bindings().requestId).toBe('req-solo');
  });
});

describe('currentTraceId (OBS-12)', () => {
  it('returns undefined outside Lambda (env var unset)', () => {
    vi.stubEnv('_X_AMZN_TRACE_ID', '');
    expect(currentTraceId()).toBeUndefined();
  });

  it('extracts the Root id from the X-Ray header format', () => {
    vi.stubEnv(
      '_X_AMZN_TRACE_ID',
      'Root=1-6817f3a2-abcdef012345;Parent=53995c3f42cd8ad8;Sampled=1'
    );
    expect(currentTraceId()).toBe('1-6817f3a2-abcdef012345');
  });

  it('handles a bare Root segment without Parent/Sampled', () => {
    vi.stubEnv('_X_AMZN_TRACE_ID', 'Root=1-zzz');
    expect(currentTraceId()).toBe('1-zzz');
  });

  it('returns undefined when no Root segment is present', () => {
    vi.stubEnv('_X_AMZN_TRACE_ID', 'Parent=53995c3f42cd8ad8;Sampled=0');
    expect(currentTraceId()).toBeUndefined();
  });
});
