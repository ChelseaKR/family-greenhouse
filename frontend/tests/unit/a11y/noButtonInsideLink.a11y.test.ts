import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A link must not wrap a button.
 *
 * `<Link to="/tasks"><Button>View all</Button></Link>` renders `<a><button>`.
 * That is two controls for one action: the keyboard stops on "View all" twice,
 * and a screen reader reads a link and then a button with the same name. The
 * HTML content model forbids interactive content inside `<a>`, and axe does not
 * report it (its nested-interactive rule does not cover the link role), so the
 * eleven places that did this passed every automated check.
 *
 * A link that should look like a button takes `buttonStyles()` as its class.
 */
const SRC = join(__dirname, '../../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

// An opening <Link>, <NavLink> or <a> whose first child is a <Button> or <button>.
// The attributes are read as a run of either one plain character or one whole
// `{...}` expression (which may hold `>` and one nested `{...}`, as a template
// literal does). The two choices never start with the same character, so the
// pattern cannot backtrack between them.
const LINK_WRAPPING_BUTTON =
  /<(?:Link|NavLink|a)\b(?:[^<>{}]|\{(?:[^{}]|\{[^{}]*\})*\})*>\s*<(?:Button|button)\b/g;

describe('links never wrap buttons', () => {
  it('finds no <Link>/<a> whose child is a <Button>', () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(LINK_WRAPPING_BUTTON)].map((match) => {
        const line = text.slice(0, match.index).split('\n').length;
        return `${relative(SRC, file)}:${line}`;
      });
    });
    expect(offenders).toEqual([]);
  });

  it('recognises the pattern it guards against', () => {
    const sample = '<Link to="/tasks">\n  <Button size="sm">View all</Button>\n</Link>';
    expect(sample.match(LINK_WRAPPING_BUTTON)).not.toBeNull();
    const withExpression =
      '<Link to={`/plants/${id}`} className="block">\n<Button>Open</Button></Link>';
    expect(withExpression.match(LINK_WRAPPING_BUTTON)).not.toBeNull();
    const withArrow = '<a href="/x" onClick={() => go(1)}><button>Go</button></a>';
    expect(withArrow.match(LINK_WRAPPING_BUTTON)).not.toBeNull();
    const fine = '<Link to="/tasks" className={buttonStyles()}>View all</Link>';
    expect(fine.match(LINK_WRAPPING_BUTTON)).toBeNull();
    // A long run of braces must be rejected quickly, not by trying every split.
    const started = Date.now();
    expect(`<a ${'{{}}'.repeat(5000)}`.match(LINK_WRAPPING_BUTTON)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
