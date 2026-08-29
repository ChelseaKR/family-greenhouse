import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  disallowedPrefixes,
  fallbackShell,
  isDisallowed,
  renderRoute,
} from '../../../scripts/prerender.mjs';

const SHELL = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <title>Family Greenhouse — Grow together</title>',
  '    <meta name="description" content="Shell default." />',
  '    <meta property="og:type" content="website" />',
  '    <meta property="og:title" content="Shell title" />',
  '    <meta property="og:description" content="Shell description" />',
  '    <meta name="twitter:title" content="Shell title" />',
  '    <meta name="twitter:description" content="Shell description" />',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '  </body>',
  '</html>',
].join('\n');

const ROUTE = {
  path: '/pet-safe',
  canonical: 'https://familygreenhouse.net/pet-safe',
  title: 'Is This Plant Safe for Pets? — Cat & Dog Toxicity Checker',
  description: 'A checker for cats & dogs.',
  heading: 'Is this plant safe for pets?',
  ogType: 'website' as const,
  jsonLd: { '@type': 'WebPage', name: '</script> injection attempt' },
};

describe('prerender', () => {
  it('replaces the shell head with the route’s own, and adds canonical + og:url', () => {
    const html = renderRoute(SHELL, ROUTE);
    expect(html).toContain(
      '<title>Is This Plant Safe for Pets? — Cat &amp; Dog Toxicity Checker</title>'
    );
    expect(html).toContain('<link rel="canonical" href="https://familygreenhouse.net/pet-safe" />');
    expect(html).toContain(
      '<meta property="og:url" content="https://familygreenhouse.net/pet-safe" />'
    );
    expect(html).not.toContain('Shell default.');
    expect(html).not.toContain('Shell title');
  });

  it('emits exactly one h1, carrying the route’s own heading', () => {
    const html = renderRoute(SHELL, ROUTE);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('<h1>Is this plant safe for pets?</h1>');
  });

  it('escapes markup so a title or JSON-LD payload cannot break out of its tag', () => {
    const html = renderRoute(SHELL, ROUTE);
    expect(html).toContain('Cat &amp; Dog');
    // `</script>` anywhere in a script body ends the element, escaped or not.
    expect(html).toContain('\\u003c/script>');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('fails loudly instead of shipping an unsubstituted shell', () => {
    expect(() => renderRoute(SHELL.replace('<title>', '<titl>'), ROUTE)).toThrow(/<title>/);
    expect(() => renderRoute(SHELL.replace('<div id="root"></div>', ''), ROUTE)).toThrow(
      /<div id="root">/
    );
  });

  it('marks the SPA fallback noindex and leaves it canonical-free', () => {
    const fallback = fallbackShell(SHELL);
    expect(fallback).toContain('<meta name="robots" content="noindex" />');
    expect(fallback).not.toContain('rel="canonical"');
    expect(fallback).toContain('<div id="root"></div>');
  });

  it('reads the Disallow rules the shipped robots.txt actually publishes', () => {
    const robots = readFileSync(resolve(import.meta.dirname, '../../../public/robots.txt'), 'utf8');
    const prefixes = disallowedPrefixes(robots);

    expect(prefixes).toContain('/dashboard');
    expect(prefixes).toContain('/api/');
    expect(prefixes).toContain('/app.html');
    expect(isDisallowed('/dashboard', prefixes)).toBe(true);
    expect(isDisallowed('/join/abc', prefixes)).toBe(true);
    expect(isDisallowed('/care/pothos', prefixes)).toBe(false);
    expect(isDisallowed('/', prefixes)).toBe(false);
  });

  it('ignores Disallow rules that belong to another user-agent group', () => {
    const prefixes = disallowedPrefixes(
      ['User-agent: *', 'Disallow: /api/', '', 'User-agent: BadBot', 'Disallow: /'].join('\n')
    );
    expect(prefixes).toEqual(['/api/']);
  });
});
