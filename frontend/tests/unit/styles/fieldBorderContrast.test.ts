import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 1.4.11 Non-text Contrast, for the fields that do NOT use `.input`.
 *
 * `inputBorderContrast.test.ts` pins the shared `.input` border at 3:1. A
 * handful of fields set their own border instead, and those were never
 * checked: the chat message box (`primary-200`, 1.5:1), the help search and
 * the coverage select (`dew`, 1.4:1 on paper) and the email-language select
 * (`gray-300`, about 1.5:1). Each is drawn by the app, not the browser (the
 * selects have `appearance: none` in index.css), so the user-agent exception
 * does not apply, and the border is the only edge the field has.
 *
 * This walks every component, finds each text field, select and textarea
 * that sets its own `border-<colour>`, and measures that colour against the
 * two surfaces fields sit on. Checkboxes, radios and file pickers keep the
 * browser's own drawing and are left out on purpose.
 */
const SRC = resolve(__dirname, '../../../src');
const css = readFileSync(join(SRC, 'index.css'), 'utf8');

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** A colour from the @theme block. Tailwind's own greys are oklch and are not
 *  overridden there; the ones a field could reach for are listed, as sRGB. */
function token(name: string): string | undefined {
  const own = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
  if (own) return own[1];
  const tailwind: Record<string, string> = {
    'gray-200': '#e5e7eb',
    'gray-300': '#d1d5dc',
    'gray-400': '#99a1af',
    'gray-500': '#6a7282',
  };
  return tailwind[name];
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** The text of a JSX opening tag, from `<` to its own `>`: braces and quotes
 *  are tracked so the `>` of an arrow function does not end it early. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

interface Field {
  where: string;
  border: string;
}

function fieldsWithTheirOwnBorder(): Field[] {
  const found: Field[] = [];
  for (const file of sources(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<(input|select|textarea)\b/g)) {
      const tag = openingTag(source, match.index);
      if (/type=["'](checkbox|radio|file|hidden|range|color)["']/.test(tag)) continue;
      const classes = /className=(?:"([^"]*)"|\{([\s\S]*?)\}\s*(?:\w+=|\/?>))/.exec(tag);
      const text = classes ? (classes[1] ?? classes[2]) : '';
      // A field on the shared `.input` rule is covered by inputBorderContrast.
      if (/(^|[\s'"`])input(?=[\s'"`]|$)/.test(text)) continue;
      // Only the resting border: `focus:`/`hover:` variants are other states.
      for (const border of text.matchAll(/(?<![\w:-])border-([a-z]+(?:-\d{2,3})?)(?![\w-])/g)) {
        if (/^(0|2|4|8|x|y|t|b|l|r|s|e|none|solid|dashed)$/.test(border[1])) continue;
        const line = source.slice(0, match.index).split('\n').length;
        found.push({ where: `${relative(SRC, file)}:${line}`, border: border[1] });
      }
    }
  }
  return found;
}

describe('fields that set their own border can be seen', () => {
  const fields = fieldsWithTheirOwnBorder();
  const surfaces = { white: '#ffffff', paper: token('paper')! };

  it('finds the fields it is meant to check', () => {
    // A scanner that matched nothing would pass over everything.
    expect(fields.map((f) => f.where.split(':')[0])).toEqual(
      expect.arrayContaining([
        'features/chat/ChatPage.tsx',
        'features/help/HelpPage.tsx',
        'features/analytics/CoverageCard.tsx',
        'features/settings/NotificationSettings.tsx',
      ])
    );
  });

  it.each(Object.entries(surfaces))('every such border is at least 3:1 on %s', (_name, surface) => {
    const failures = fields
      .map(({ where, border }) => {
        const hex = token(border);
        const ratio = hex ? contrast(hex, surface) : 0;
        return { where, border, ratio: Math.round(ratio * 100) / 100 };
      })
      .filter(({ ratio }) => ratio < 3);
    expect(failures).toEqual([]);
  });
});
