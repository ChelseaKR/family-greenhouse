import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluate, parseBaseline, publishedReleaseTags, report } from './check-release-record.mjs';

const NOW = new Date('2026-09-06T00:00:00Z');

function tag(name, daysAgo) {
  return { name, date: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString() };
}

function run({ tags, releasedTags = [], baseline = [], graceDays = 7 }) {
  return evaluate({ tags, released: new Set(releasedTags), baseline, now: NOW, graceDays });
}

test('a tag older than the grace period with no release is overdue', () => {
  const result = run({ tags: [tag('v0.30.0', 30)] });
  assert.deepEqual(result.overdue, ['v0.30.0']);
  assert.equal(result.ok, false);
});

test('a tag inside the grace period is not overdue yet', () => {
  const result = run({ tags: [tag('v0.30.0', 3)] });
  assert.deepEqual(result.overdue, []);
  assert.deepEqual(result.unrecorded, ['v0.30.0']);
  assert.equal(result.ok, true);
});

test('the grace period boundary is inclusive', () => {
  assert.deepEqual(run({ tags: [tag('v0.30.0', 7)] }).overdue, ['v0.30.0']);
  assert.deepEqual(run({ tags: [tag('v0.30.0', 6)] }).overdue, []);
});

test('a baseline entry accounts for a tag without forgiving the next one', () => {
  const result = run({
    tags: [tag('v0.29.0', 60), tag('v0.30.0', 30)],
    baseline: ['v0.29.0'],
  });
  assert.deepEqual(result.overdue, ['v0.30.0']);
  assert.deepEqual(result.unrecorded, ['v0.29.0', 'v0.30.0']);
  assert.equal(result.ok, false);
});

test('a released tag is recorded and never overdue', () => {
  const result = run({ tags: [tag('v0.30.0', 90)], releasedTags: ['v0.30.0'] });
  assert.deepEqual(result.unrecorded, []);
  assert.equal(result.releasedCount, 1);
  assert.equal(result.ok, true);
});

test('a baseline entry naming a tag that does not exist fails', () => {
  // The both-directions half. A register that has stopped matching reality is
  // scaffolding, and a gap can hide behind scaffolding.
  const result = run({ tags: [tag('v0.30.0', 30)], baseline: ['v0.30.0', 'v9.9.9'] });
  assert.deepEqual(result.phantom, ['v9.9.9']);
  assert.equal(result.ok, false);
});

test('a baseline entry that has since been released is reported, not failed', () => {
  const result = run({
    tags: [tag('v0.30.0', 30)],
    releasedTags: ['v0.30.0'],
    baseline: ['v0.30.0'],
  });
  assert.deepEqual(result.resolved, ['v0.30.0']);
  assert.equal(result.ok, true);
  assert.match(report(result, { graceDays: 7 }), /Delete these lines/);
});

test('a draft release does not count as a record', () => {
  const released = publishedReleaseTags([
    { tag_name: 'v0.30.0', draft: true },
    { tag_name: 'v0.31.0', draft: false },
  ]);
  assert.deepEqual([...released], ['v0.31.0']);
});

test('the baseline drops comments and blank lines', () => {
  assert.deepEqual(parseBaseline('# why\n\nv0.8.0\n  v0.9.0  \n\n# more\n'), ['v0.8.0', 'v0.9.0']);
});

test('the report names what the owner has to do', () => {
  const text = report(run({ tags: [tag('v0.30.0', 30)] }), { graceDays: 7 });
  assert.match(text, /v0\.30\.0/);
  assert.match(text, /RELEASE-AND-VERSIONING-STANDARD/);
});

test('an empty repository is not a pass by accident', () => {
  // Guards the shape of the emptiness, not the verdict: with no tags there is
  // nothing to record, but the counts must say so rather than reading as 46/46.
  const result = run({ tags: [] });
  assert.equal(result.tagCount, 0);
  assert.equal(result.releasedCount, 0);
  assert.deepEqual(result.unrecorded, []);
});
