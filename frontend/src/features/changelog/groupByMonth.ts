import { formatContentDate } from '@/utils/contentDate';

/**
 * Group dated entries under their month heading, in input order.
 *
 * Its own module rather than a helper inside `ChangelogPage.tsx` because it
 * needs a direct test: the page ships no entry on the 1st of a month, so a
 * naive `new Date(date).toLocaleDateString()` here — which files a 1st under
 * the previous month anywhere west of UTC — is invisible through the rendered
 * page and only a synthetic first-of-month entry can catch it. (Exporting a
 * function from a component file also trips `react-refresh/only-export-
 * components`, which the lint gate treats as a failure.)
 */
export function groupByMonth<T extends { date: string }>(entries: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const e of entries) {
    const month = formatContentDate(e.date, 'month');
    const list = out.get(month) ?? [];
    list.push(e);
    out.set(month, list);
  }
  return out;
}
