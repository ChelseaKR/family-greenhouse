#!/usr/bin/env node
/**
 * The production-dependency advisory gate — `npm audit --omit=dev
 * --audit-level=high`, with the network flakiness taken out of it.
 *
 * Same verdict as the bare command, by construction: it runs `npm audit
 * --omit=dev --json` and fails when npm reports any `high` or `critical`
 * vulnerability, which is exactly what `--audit-level=high` means. CI's
 * `Security Scan` job still runs the bare form, and the two agree.
 *
 * Why a wrapper: this is the one step of the local gate that makes a network
 * call, and it is called from a pre-push hook. Several checkouts running the
 * gate at once hammer npm's advisory endpoint and get 503s back, and the bare
 * command reports a registry 503 the same way it reports a real CVE — a
 * non-zero exit and a red gate. That is a false failure at exactly the moment
 * someone is trying to push, and it trains people to reach for `--no-verify`.
 *
 * So: retry a transient registry failure a few times with jittered backoff
 * (the jitter matters — correlated retries from parallel checkouts are what
 * produced the 503s in the first place), and distinguish the two outcomes in
 * the output.
 *
 * What this deliberately does NOT do is pass when it could not reach the
 * registry. "Could not check" is not "nothing found" — that is this repo's
 * own named recurring defect, absence rendered as an all-clear. After the
 * retries are exhausted it fails, loudly, saying it never got an answer.
 */
import { spawn } from 'node:child_process';

const ATTEMPTS = 4;
const BASE_DELAY_MS = 1_000;

/** Runs `npm audit --omit=dev --json`, resolving whatever npm printed. */
function audit() {
  return new Promise((settle) => {
    // npm exits non-zero when it finds vulnerabilities, so the exit code is
    // not the signal here — the JSON body is. Capture both anyway; the code
    // is used only to describe a failure that produced no parseable body.
    const child = spawn('npm', ['audit', '--omit=dev', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) =>
      settle({ code: null, stdout: '', stderr: `failed to run npm audit: ${e.message}` })
    );
    child.on('close', (code) =>
      settle({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    );
  });
}

/**
 * @returns {{kind:'verdict',counts:object,report:object}|{kind:'transient',reason:string}}
 */
function classify({ code, stdout, stderr }) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return {
      kind: 'transient',
      reason: `npm audit produced no parseable JSON (exit ${code ?? 'signal'}): ${
        (stderr || stdout).trim().split('\n').slice(0, 4).join(' / ') || '(no output)'
      }`,
    };
  }
  // npm's error envelope: `{ "message", "error": { "code", "summary", "detail" } }`.
  // Note that npm exits 0 for this body — the exit code is NOT the signal in
  // `--json` mode, which is the whole reason this classifies on the body.
  // Trusting the code here would report an unreachable registry as a clean
  // audit. The useful text is usually the top-level `message`; `error.summary`
  // and `error.detail` are frequently empty strings, so `??` is not enough.
  if (report?.error) {
    const detail =
      [report.message, report.error.summary, report.error.detail].find((s) => s?.trim()) ??
      'no detail';
    return {
      kind: 'transient',
      reason: `npm audit error${report.error.code ? ` ${report.error.code}` : ''}: ${detail}`,
    };
  }
  const counts = report?.metadata?.vulnerabilities;
  if (!counts || typeof counts.high !== 'number' || typeof counts.critical !== 'number') {
    // A body with no severity counts is not a clean bill of health; we simply
    // did not get an answer. Never treat this as zero vulnerabilities.
    return {
      kind: 'transient',
      reason: 'npm audit returned JSON with no `metadata.vulnerabilities` severity counts',
    };
  }
  return { kind: 'verdict', counts, report };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const reasons = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const result = classify(await audit());

    if (result.kind === 'verdict') {
      const { high, critical } = result.counts;
      const blocking = high + critical;
      if (blocking > 0) {
        console.error(
          `npm audit: ${critical} critical, ${high} high advisories in production dependencies (--audit-level=high blocks both).\n`
        );
        for (const [name, v] of Object.entries(result.report.vulnerabilities ?? {})) {
          if (v.severity === 'high' || v.severity === 'critical') {
            const via = (v.via ?? [])
              .map((entry) => (typeof entry === 'string' ? entry : entry.title))
              .filter(Boolean);
            console.error(`  ${v.severity.padEnd(8)} ${name}${via.length ? ` — ${via[0]}` : ''}`);
          }
        }
        console.error(
          '\nRun `npm audit --omit=dev` for the full report, `npm audit fix` to try a fix.'
        );
        return 1;
      }
      const { moderate = 0, low = 0, info = 0 } = result.counts;
      console.log(
        `npm audit: no high or critical advisories in production dependencies (${moderate} moderate, ${low} low, ${info} info).`
      );
      return 0;
    }

    reasons.push(`attempt ${attempt}: ${result.reason}`);
    if (attempt < ATTEMPTS) {
      // Jittered exponential backoff. Parallel checkouts retrying in lockstep
      // are what turns one slow response into a run of 503s.
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
      console.warn(
        `npm audit: ${result.reason} — retrying in ${(delay / 1000).toFixed(1)}s (${attempt}/${ATTEMPTS - 1})`
      );
      await sleep(delay);
    }
  }

  console.error(
    `npm audit: could not get an answer from the npm advisory endpoint after ${ATTEMPTS} attempts.\n` +
      'This is NOT a clean audit — the check did not run, so it is failing rather than reporting an all-clear.\n'
  );
  for (const reason of reasons) console.error(`  ${reason}`);
  console.error(
    "\nIf you are offline, the advisory check cannot run; CI's required `Security Scan` job runs it too."
  );
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`npm audit gate crashed: ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
);
