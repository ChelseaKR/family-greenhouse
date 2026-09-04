import i18n from '@/i18n';

/**
 * "Maria", "Maria and Tom", "Maria, Tom, and Sam" — joined the way the active
 * locale reads a list. Falls back to a comma join where `Intl.ListFormat` is
 * missing. An empty list is an empty string, never a placeholder.
 */
export function formatNameList(names: string[], locale = i18n.language || 'en'): string {
  if (names.length === 0) return '';
  if (typeof Intl.ListFormat === 'function') {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
  }
  return names.join(', ');
}
