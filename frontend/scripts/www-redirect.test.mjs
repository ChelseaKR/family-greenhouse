#!/usr/bin/env node
/**
 * Tests for the `www.` redirect distribution (issue #797): its CloudFront
 * function, and the Terraform shape that makes it ONE hop.
 *
 * The function is trivial; the hop count is not, and it is decided in HCL. On
 * the main distribution `viewer_protocol_policy = "redirect-to-https"` answers
 * a plain-HTTP request before any function runs, which is how http://www took
 * two 301s to reach the apex. The Terraform assertions below pin the three
 * facts the fix depends on — `www.` has its own distribution, that
 * distribution is `allow-all`, and the main one no longer claims `www.` — so a
 * well-meant "make it consistent" edit cannot quietly bring the second hop
 * back. Nothing else can catch that before production: `terraform validate`
 * accepts every one of those regressions.
 *
 * Run: `npm run test:edge`.
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { FRONTEND_ROOT } from './public-routes.mjs';

const MODULE = join(FRONTEND_ROOT, '..', 'infrastructure', 'modules', 'frontend');
const SOURCE = join(MODULE, 'functions', 'www-redirect.js');
const PLACEHOLDER = '__APEX_DOMAIN__';
const APEX = 'familygreenhouse.net';

const source = readFileSync(SOURCE, 'utf8');
const mainTf = readFileSync(join(MODULE, 'main.tf'), 'utf8').replaceAll(/^\s*#.*$/gmu, '');

/** Load the function the way Terraform ships it: placeholder replaced by the apex. */
const sandbox = {};
runInNewContext(source.replaceAll(PLACEHOLDER, APEX), sandbox, { filename: 'www-redirect.js' });
const { handler } = sandbox;

const redirect = (uri, querystring = {}, host = `www.${APEX}`) =>
  handler({ request: { uri, headers: { host: { value: host } }, querystring } });

/** The body of one `resource "TYPE" "NAME" { ... }` block, or '' if absent. */
function tfResource(type, name) {
  const header = `resource "${type}" "${name}" {`;
  const start = mainTf.indexOf(header);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start + header.length - 1; i < mainTf.length; i += 1) {
    if (mainTf[i] === '{') depth += 1;
    else if (mainTf[i] === '}') {
      depth -= 1;
      if (depth === 0) return mainTf.slice(start, i + 1);
    }
  }
  return '';
}

test('every request is one permanent redirect to https on the apex, path kept', () => {
  for (const uri of ['/', '/care/zz-plant', '/pricing', '/assets/index-abc.js', '/.well-known/x']) {
    const res = redirect(uri);
    assert.equal(res.statusCode, 301, uri);
    assert.equal(res.headers.location.value, `https://${APEX}${uri}`, uri);
  }
});

test('the querystring survives, repeated and valueless keys included', () => {
  const res = redirect('/pricing', {
    ref: { value: 'abc' },
    flag: { value: '' },
    tag: { value: 'a', multiValue: [{ value: 'a' }, { value: 'b' }] },
  });
  assert.equal(res.headers.location.value, `https://${APEX}/pricing?ref=abc&flag&tag=a&tag=b`);
});

test('no querystring object at all still redirects rather than throwing', () => {
  const res = handler({ request: { uri: '/care' } });
  assert.equal(res.headers.location.value, `https://${APEX}/care`);
});

// The apex comes from Terraform, not from the Host header. A Host-derived
// target would send a request that reached the distribution by its
// *.cloudfront.net name to a mangled host, or loop on a Host with no `www.`.
test('the target is the substituted apex whatever Host the request carries', () => {
  for (const host of ['d111111abcdef8.cloudfront.net', APEX, 'WWW.FAMILYGREENHOUSE.NET']) {
    assert.equal(redirect('/x', {}, host).headers.location.value, `https://${APEX}/x`, host);
  }
});

test('the committed function carries the placeholder Terraform substitutes', () => {
  assert.ok(source.includes(`'${PLACEHOLDER}'`), 'www-redirect.js lost its apex placeholder');
  assert.ok(!source.includes(APEX), 'www-redirect.js hardcodes the apex instead of taking it');
  const fn = tfResource('aws_cloudfront_function', 'www_redirect');
  assert.match(
    fn,
    /replace\(file\("\$\{path\.module\}\/functions\/www-redirect\.js"\),\s*"__APEX_DOMAIN__",\s*var\.domain_name\)/u
  );
});

test('the function stays inside CloudFront’s 10 KB source limit', () => {
  assert.ok(statSync(SOURCE).size < 10 * 1024);
});

// --- The Terraform shape. Each of these, reverted, is the second hop back. ---

test('www. has a distribution of its own, and it is allow-all', () => {
  const www = tfResource('aws_cloudfront_distribution', 'www_redirect');
  assert.ok(www, 'aws_cloudfront_distribution.www_redirect is gone');
  assert.match(www, /aliases\s*=\s*\["www\.\$\{var\.domain_name\}"\]/u);
  // `redirect-to-https` here would answer http://www before the function ran.
  assert.match(www, /viewer_protocol_policy\s*=\s*"allow-all"/u);
  assert.doesNotMatch(www, /viewer_protocol_policy\s*=\s*"(?!allow-all")/u);
  assert.match(
    www,
    /event_type\s*=\s*"viewer-request"\s*function_arn\s*=\s*aws_cloudfront_function\.www_redirect\[0\]\.arn/u
  );
});

test('the main distribution no longer claims www.', () => {
  const main = tfResource('aws_cloudfront_distribution', 'frontend');
  assert.match(main, /aliases\s*=\s*var\.domain_name == "" \? \[\] : \[var\.domain_name\]/u);
  assert.doesNotMatch(main, /aliases\s*=\s*local\.frontend_aliases/u);
});

// An alias can belong to one distribution at a time. Without the ordering,
// Terraform creates the new distribution in parallel with removing `www.` from
// the old one, and the apply fails on CNAMEAlreadyExists mid-release.
test('the www distribution is created only after the main one lets go of www.', () => {
  const www = tfResource('aws_cloudfront_distribution', 'www_redirect');
  assert.match(www, /depends_on\s*=\s*\[aws_cloudfront_distribution\.frontend\]/u);
});

test('DNS for www. points at the redirect distribution', () => {
  const record = tfResource('aws_route53_record', 'www');
  assert.match(record, /name\s*=\s*aws_cloudfront_distribution\.www_redirect\[0\]\.domain_name/u);
  assert.match(
    record,
    /zone_id\s*=\s*aws_cloudfront_distribution\.www_redirect\[0\]\.hosted_zone_id/u
  );
});
