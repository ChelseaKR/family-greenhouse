#!/usr/bin/env node
/**
 * A blog post's modified date must be the date of the words it has now.
 *
 * Three things read `updated` from `src/features/blog/posts/index.ts`: the
 * sitemap's `<lastmod>`, the Article `dateModified` and
 * `article:modified_time`. Before 2026-11-17 the field did not exist, and all
 * 14 posts gave their publish date as their modified date after months of
 * edits. These tests hold the committed files to each other, so the next edit
 * to a post fails here until its date moves:
 *
 *   - the manifest against the ledger (`blog-posts-lastmod.json`);
 *   - the committed sitemap against the manifest;
 *   - the generator's refusal to record a changed post under its old date.
 *
 * No `dist/` and no git history: `npm run test:edge` runs in CI jobs that
 * never build and on shallow clones.
 *
 * Run: `npm run test:edge`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  currentPosts,
  ledgerFailures,
  manifestPosts,
  nextLedger,
  postContentDigest,
  readBlogLedger,
} from './build-blog-posts-lastmod.mjs';
import { publicRoutes, readBlogLastmods } from './public-routes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITEMAP = join(HERE, '..', 'public', 'sitemap.xml');

const MANIFEST = `
import First from './first';
import Second from './second';

export const POSTS = [
  {
    slug: 'first-post',
    title: 'First',
    description: 'One.',
    date: '2026-05-05',
    updated: '2026-10-24',
    readingMinutes: 5,
    Component: First,
  },
  {
    slug: 'second-post',
    title: 'Second',
    description: 'Two.',
    date: '2026-06-01',
    readingMinutes: 4,
    Component: Second,
  },
];
`;

function fixturePosts(manifest = MANIFEST, files = { first: '<p>one</p>', second: '<p>two</p>' }) {
  return manifestPosts(manifest).map((post) => ({
    ...post,
    content: postContentDigest(post, files[post.file]),
  }));
}

test('the committed manifest matches the committed ledger', () => {
  const posts = currentPosts();
  assert.ok(posts.length >= 14, 'the manifest was not read');
  assert.deepEqual(ledgerFailures(posts, readBlogLedger()), []);
});

test('no post is dated before it was published or after today', () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const post of currentPosts()) {
    assert.ok(post.lastmod >= post.date, `${post.slug} is modified before it is published`);
    assert.ok(post.lastmod <= today, `${post.slug} is modified in the future (${post.lastmod})`);
  }
});

test('the committed sitemap gives each post the manifest’s modified date', () => {
  const xml = readFileSync(SITEMAP, 'utf8');
  for (const post of currentPosts()) {
    const url = new RegExp(
      `<loc>https://familygreenhouse\\.net/blog/${post.slug}</loc>\\s*<lastmod>([^<]+)</lastmod>`
    ).exec(xml);
    assert.ok(url, `/blog/${post.slug} is not in sitemap.xml with a lastmod`);
    assert.equal(url[1], post.lastmod, `/blog/${post.slug}`);
  }
});

test('the overwatering post is no longer dated to the day it was published', () => {
  // The case that prompted this: merged into, live 2026-11-17, dated 2026-07-29.
  const route = publicRoutes().find(
    (r) => r.path === '/blog/signs-of-overwatering-and-how-to-fix-it'
  );
  assert.ok(route.lastmod >= '2026-11-17', `lastmod is ${route.lastmod}`);
});

test('/blog is dated to its most recently changed post', () => {
  const newest = [...readBlogLastmods().values()].sort().at(-1);
  assert.equal(publicRoutes().find((r) => r.path === '/blog').lastmod, newest);
});

test('a post with no `updated` keeps its publish date, not its neighbour’s', () => {
  const lastmods = readBlogLastmods(MANIFEST);
  assert.equal(lastmods.get('first-post'), '2026-10-24');
  assert.equal(lastmods.get('second-post'), '2026-06-01');
  // The undated post first and the dated one after it: a lazy match from one
  // `slug:` to the next `updated:` would give the first post the second's date.
  const undatedFirst = `
    { slug: 'plain', date: '2026-06-01', readingMinutes: 4, Component: Plain },
    { slug: 'edited', date: '2026-05-05', updated: '2026-10-24', Component: Edited },
  `;
  assert.deepEqual(
    [...readBlogLastmods(undatedFirst)],
    [
      ['plain', '2026-06-01'],
      ['edited', '2026-10-24'],
    ]
  );
});

test('changing a post’s text without moving its date fails the check', () => {
  const { ledger } = nextLedger({ posts: {} }, fixturePosts());
  assert.deepEqual(ledgerFailures(fixturePosts(), ledger), []);

  const edited = fixturePosts(MANIFEST, { first: '<p>one, edited</p>', second: '<p>two</p>' });
  const failures = ledgerFailures(edited, ledger);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^first-post: the post has changed since 2026-10-24/);
});

test('changing a post’s title in the manifest counts as changing the post', () => {
  const { ledger } = nextLedger({ posts: {} }, fixturePosts());
  const retitled = fixturePosts(MANIFEST.replace("title: 'Second'", "title: 'Second, retitled'"));
  assert.match(ledgerFailures(retitled, ledger)[0], /^second-post: the post has changed/);
});

test('moving the date alone, or reformatting, is not a change of content', () => {
  const before = fixturePosts();
  const redated = fixturePosts(MANIFEST.replace("updated: '2026-10-24'", "updated: '2026-11-17'"));
  assert.equal(redated[0].content, before[0].content);
  // Prettier re-wrapping a line changes its whitespace and nothing a reader sees.
  const wrapped = { first: '<p>one line, wrapped</p>', second: '<p>two</p>' };
  const rewrapped = { first: '<p>one line,\n      wrapped</p>', second: '<p>two</p>' };
  assert.equal(
    fixturePosts(MANIFEST, rewrapped)[0].content,
    fixturePosts(MANIFEST, wrapped)[0].content
  );
});

test('the generator refuses a changed post under its old date, and takes a new one', () => {
  const { ledger } = nextLedger({ posts: {} }, fixturePosts());
  const files = { first: '<p>one, edited</p>', second: '<p>two</p>' };

  const stale = nextLedger(ledger, fixturePosts(MANIFEST, files));
  assert.deepEqual(stale.refused, ['first-post']);

  const redated = MANIFEST.replace("updated: '2026-10-24'", "updated: '2026-11-17'");
  const fresh = nextLedger(ledger, fixturePosts(redated, files));
  assert.deepEqual(fresh.refused, []);
  assert.equal(fresh.ledger.posts['first-post'].lastmod, '2026-11-17');
  assert.deepEqual(ledgerFailures(fixturePosts(redated, files), fresh.ledger), []);

  // The explicit statement that readers see no difference is the only other way.
  const waived = nextLedger(ledger, fixturePosts(MANIFEST, files), new Set(['first-post']));
  assert.deepEqual(waived.refused, []);
  assert.equal(waived.ledger.posts['first-post'].lastmod, '2026-10-24');
});

test('a post missing from the ledger, or left in it after removal, is reported', () => {
  const { ledger } = nextLedger({ posts: {} }, fixturePosts());
  const onlyFirst = fixturePosts().slice(0, 1);
  assert.match(ledgerFailures(onlyFirst, ledger)[0], /^second-post: in the ledger but not in/);
  assert.match(ledgerFailures(fixturePosts(), { posts: {} })[0], /^first-post: not in the ledger/);
});
