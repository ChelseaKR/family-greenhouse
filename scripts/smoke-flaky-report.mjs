#!/usr/bin/env node
/**
 * Report post-deploy smoke tests that passed only on their retry (#703).
 *
 * `frontend/tests/e2e/playwright.smoke.config.ts` retries once in CI and
 * deliberately does NOT set `failOnFlakyTests`: a red `smoke-tests` job rolls
 * production back, and a smoke that failed once against the new deployment
 * and then passed is not, on its own, a reason to revert a release that takes
 * real payments. But Playwright exits 0 on a flaky result, so until this
 * script existed that case was indistinguishable from a clean pass.
 *
 * This keeps the deploy and makes the retry impossible to miss. It reads the
 * JSON report the smoke config writes and:
 *
 *   - writes each retried test to the job's step summary;
 *   - emits a `::warning::` annotation per retried test;
 *   - sets the step output `flaky` to the count, or to `unknown` when the
 *     report is missing or does not have the shape this reads — never to 0,
 *     because a report nobody could read is not evidence that nothing retried;
 *   - ALWAYS exits 0. It runs inside `smoke-tests`, and anything that failed
 *     that job would roll production back. The verdict belongs to `notify`,
 *     which reads the output and nothing in `rollback` does.
 *
 * Only test titles and file:line locations are printed. Error messages stay
 * in the uploaded Playwright report: this repository is public, and a smoke
 * failure against production can carry a URL.
 *
 * Usage: node scripts/smoke-flaky-report.mjs <path/to/results.json>
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const UNKNOWN = 'unknown';

function walk(suite, into) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      into.push({ spec, test });
    }
  }
  for (const child of suite.suites ?? []) walk(child, into);
  return into;
}

/**
 * @param {unknown} report parsed Playwright JSON report
 * @returns {{ state: 'read', flaky: Array<{title: string, file: string, line: number, project: string, attempts: number}> }
 *         | { state: 'unreadable', reason: string }}
 */
export function summarize(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.suites)) {
    return { state: 'unreadable', reason: 'the report has no `suites` array' };
  }
  const declared = report.stats?.flaky;
  if (!Number.isInteger(declared) || declared < 0) {
    return { state: 'unreadable', reason: 'the report has no integer `stats.flaky`' };
  }
  const entries = report.suites.flatMap((suite) => walk(suite, []));
  const flaky = entries
    .filter(({ test }) => test.status === 'flaky')
    .map(({ spec, test }) => ({
      title: String(spec.title ?? ''),
      file: String(spec.file ?? ''),
      line: Number(spec.line ?? 0),
      project: String(test.projectName ?? ''),
      attempts: Array.isArray(test.results) ? test.results.length : 0,
    }));
  // The two counts come from different parts of the report. If they disagree,
  // this walk is not reading the shape Playwright wrote, and a count taken
  // from it would be a guess presented as a measurement.
  if (flaky.length !== declared) {
    return {
      state: 'unreadable',
      reason: `stats.flaky is ${declared} but ${flaky.length} flaky test(s) were found in suites`,
    };
  }
  return { state: 'read', flaky };
}

export function outputValue(summary) {
  return summary.state === 'read' ? String(summary.flaky.length) : UNKNOWN;
}

export function renderSummary(summary) {
  const heading = '### Post-deploy smoke: tests that passed only on their retry (#703)';
  if (summary.state !== 'read') {
    return [
      heading,
      '',
      `**Unknown.** ${summary.reason}. Whether any smoke test needed its retry could not be read, ` +
        'so this is not reported as zero.',
      '',
    ].join('\n');
  }
  if (summary.flaky.length === 0) {
    return [heading, '', 'None: every smoke test passed on its first attempt.', ''].join('\n');
  }
  return [
    heading,
    '',
    `**${summary.flaky.length}** smoke test(s) failed against this deployment and then passed on a retry. ` +
      'The deployment was kept (a retried pass does not roll production back), but the first attempt ' +
      'failed for a reason worth reading: the error is in the uploaded Playwright report.',
    '',
    '| test | location | project | attempts |',
    '| --- | --- | --- | ---: |',
    ...summary.flaky.map(
      (t) =>
        `| ${t.title.replaceAll('|', '\\|')} | \`${t.file}:${t.line}\` | ${t.project || '-'} | ${t.attempts} |`
    ),
    '',
  ].join('\n');
}

// GitHub workflow-command escaping: data escapes % CR LF; properties also : and ,.
const escapeData = (s) =>
  String(s).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = (s) => escapeData(s).replaceAll(':', '%3A').replaceAll(',', '%2C');

export function annotations(summary) {
  if (summary.state !== 'read') {
    return [
      `::warning title=${escapeProperty('Smoke retry count unknown (#703)')}::${escapeData(summary.reason)}`,
    ];
  }
  return summary.flaky.map(
    (t) =>
      `::warning file=${escapeProperty(`frontend/tests/e2e/${t.file}`)},line=${t.line},` +
      `title=${escapeProperty('Smoke test passed only on its retry (#703)')}::` +
      escapeData(`${t.title} failed against this deployment and passed on attempt ${t.attempts}.`)
  );
}

function load(path) {
  if (!path) return { state: 'unreadable', reason: 'no report path was given' };
  if (!existsSync(path)) {
    return {
      state: 'unreadable',
      reason: `no report at ${path} (the smoke run may not have reached its reporters)`,
    };
  }
  try {
    return summarize(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return {
      state: 'unreadable',
      reason: `the report at ${path} is not valid JSON (${error.message})`,
    };
  }
}

/** Always returns 0. See the header for why. */
export function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  try {
    const summary = load(argv[0]);
    for (const line of annotations(summary)) log(line);
    const value = outputValue(summary);
    log(`smoke tests that passed only on their retry: ${value}`);
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(env.GITHUB_STEP_SUMMARY, `${renderSummary(summary)}\n`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `flaky=${value}\n`);
  } catch (error) {
    log(
      `::warning title=${escapeProperty('Smoke retry report failed (#703)')}::${escapeData(error.message)}`
    );
    try {
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `flaky=${UNKNOWN}\n`);
    } catch {
      // Nothing left to report through; `notify` treats a missing output as unknown too.
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
