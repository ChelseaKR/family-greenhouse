import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDate,
  formatRelativeDate,
  isOverdue,
  isToday,
  addDays,
  toISODateString,
} from '@/utils/date';

describe('date utils', () => {
  beforeEach(() => {
    // Mock current date to 2024-04-15
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-04-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('formatDate', () => {
    it('returns "Never" for null/undefined', () => {
      expect(formatDate(null)).toBe('Never');
      expect(formatDate(undefined)).toBe('Never');
    });

    it('formats date correctly', () => {
      const result = formatDate('2024-04-15T12:00:00Z');
      expect(result).toContain('Apr');
      expect(result).toContain('15');
      expect(result).toContain('2024');
    });
  });

  describe('formatRelativeDate', () => {
    it('returns "Today" for today', () => {
      expect(formatRelativeDate('2024-04-15T12:00:00Z')).toBe('Today');
    });

    it('returns "Tomorrow" for tomorrow', () => {
      expect(formatRelativeDate('2024-04-16T12:00:00Z')).toBe('Tomorrow');
    });

    it('returns "Yesterday" for yesterday', () => {
      expect(formatRelativeDate('2024-04-14T12:00:00Z')).toBe('Yesterday');
    });

    it('returns days ago for past dates', () => {
      expect(formatRelativeDate('2024-04-12T12:00:00Z')).toBe('3 days ago');
    });
  });

  describe('isOverdue', () => {
    it('returns true for past dates', () => {
      expect(isOverdue('2024-04-14T12:00:00Z')).toBe(true);
    });

    it('returns false for today', () => {
      expect(isOverdue('2024-04-15T12:00:00Z')).toBe(false);
    });

    it('returns false for future dates', () => {
      expect(isOverdue('2024-04-16T12:00:00Z')).toBe(false);
    });
  });

  describe('isToday', () => {
    it('returns true for today', () => {
      expect(isToday('2024-04-15T12:00:00Z')).toBe(true);
    });

    it('returns false for other dates', () => {
      expect(isToday('2024-04-14T12:00:00Z')).toBe(false);
      expect(isToday('2024-04-16T12:00:00Z')).toBe(false);
    });
  });

  describe('addDays', () => {
    it('adds days correctly', () => {
      const date = new Date(2024, 3, 15);
      const result = addDays(date, 5);
      expect(result.getDate()).toBe(20);
    });

    it('handles negative days', () => {
      const date = new Date(2024, 3, 15);
      const result = addDays(date, -5);
      expect(result.getDate()).toBe(10);
    });

    it('rolls over month boundaries', () => {
      const date = new Date(2024, 3, 28);
      const result = addDays(date, 5);
      expect(result.getMonth()).toBe(4);
      expect(result.getDate()).toBe(3);
    });
  });

  describe('toISODateString', () => {
    it('returns date in YYYY-MM-DD format', () => {
      const date = new Date('2024-04-15T12:00:00Z');
      expect(toISODateString(date)).toBe('2024-04-15');
    });
  });
});
