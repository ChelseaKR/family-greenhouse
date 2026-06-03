// Locale-aware formatting helpers. Anything that prints a date, number, or
// currency goes through here so a Spanish-speaking user in Mexico sees
// "5/12/2026" and "MX$4.99" while an English-speaking user in the US sees
// "12/5/2026" and "$4.99" — without any per-call locale plumbing.
//
// Locale resolution: read i18next's currently active language. The functions
// accept a `locale` override so tests can pin a specific locale.

import i18n from './index';

function activeLocale(override?: string): string {
  return override || i18n.language || 'en';
}

export function formatDate(
  date: string | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale?: string
): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(activeLocale(locale), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  }).format(d);
}

export function formatTime(date: string | Date, locale?: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(activeLocale(locale), {
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

export function formatCurrency(amountInDollars: number, currency = 'USD', locale?: string): string {
  return new Intl.NumberFormat(activeLocale(locale), {
    style: 'currency',
    currency,
  }).format(amountInDollars);
}

export function formatRelativeDay(date: string | Date, locale?: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
  const rtf = new Intl.RelativeTimeFormat(activeLocale(locale), { numeric: 'auto' });
  return rtf.format(diffDays, 'day');
}
