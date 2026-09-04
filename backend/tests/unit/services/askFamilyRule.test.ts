/**
 * "Ask family to do it" (ADR 0024) — the pure half: note normalisation, the
 * derived "is the ask still open?" predicate, the shared recipient filter,
 * and the two-locale notification copy.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../../src/models/types.js';
import {
  ASK_HELP_NOTE_MAX_LENGTH,
  ASK_HELP_WINDOW_MS,
  askRecipients,
  composeAskNotification,
  isHelpRequestOpen,
  normalizeHelpNote,
} from '../../../src/services/askFamilyRule.js';
import { escalationRecipients } from '../../../src/services/escalationRule.js';

const DUE = '2026-09-10T08:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    householdId: 'hh',
    plantId: 'p1',
    plantName: 'Monstera',
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue: DUE,
    assignedTo: null,
    assignedToName: null,
    assignmentSource: null,
    notes: null,
    createdBy: 'sam',
    createdAt: '',
    ...overrides,
  };
}

describe('normalizeHelpNote', () => {
  it('trims, collapses internal whitespace, and caps at the schema length', () => {
    expect(normalizeHelpNote('  I am   travelling\n until Sunday  ')).toBe(
      'I am travelling until Sunday'
    );
    expect(normalizeHelpNote('x'.repeat(ASK_HELP_NOTE_MAX_LENGTH + 50))).toHaveLength(
      ASK_HELP_NOTE_MAX_LENGTH
    );
  });

  it('answers null — not an empty string — for "no note"', () => {
    // '' would render as an empty quotation in the feed and the email; the
    // renderers branch on null, so blank must not survive as a value.
    expect(normalizeHelpNote('')).toBeNull();
    expect(normalizeHelpNote('   \n\t ')).toBeNull();
    expect(normalizeHelpNote(undefined)).toBeNull();
    expect(normalizeHelpNote(null)).toBeNull();
    expect(normalizeHelpNote(42)).toBeNull();
  });
});

describe('isHelpRequestOpen', () => {
  it('is open only while the ask pins the CURRENT occurrence and nobody holds it', () => {
    expect(isHelpRequestOpen(task({ helpAskedForDue: DUE }))).toBe(true);
    // Claimed since — taking the task back IS the cancel, so no separate route.
    expect(isHelpRequestOpen(task({ helpAskedForDue: DUE, assignedTo: 'priya' }))).toBe(false);
    // Completed since: nextDue advanced, so the ask no longer pins it.
    expect(
      isHelpRequestOpen(task({ helpAskedForDue: DUE, nextDue: '2026-09-17T08:00:00.000Z' }))
    ).toBe(false);
    expect(isHelpRequestOpen(task())).toBe(false);
  });
});

describe('askRecipients', () => {
  const members = [{ userId: 'sam' }, { userId: 'priya' }, { userId: 'lee' }];
  const never = () => false;

  it('IS the auto-handoff recipient filter, not a second copy of it', () => {
    // One state, two doors: if these ever diverge, one door starts waking up
    // someone on holiday. Identity is the guarantee.
    expect(askRecipients).toBe(escalationRecipients);
  });

  it('never tells the asker, anyone away, or anyone inside Do-Not-Disturb', () => {
    expect(askRecipients(members, 'sam', never, never).map((m) => m.userId)).toEqual([
      'priya',
      'lee',
    ]);
    expect(
      askRecipients(members, 'sam', (id) => id === 'priya', never).map((m) => m.userId)
    ).toEqual(['lee']);
    expect(askRecipients(members, 'sam', never, (id) => id === 'lee').map((m) => m.userId)).toEqual(
      ['priya']
    );
  });

  it('returns an EMPTY list when nobody is reachable — a real answer', () => {
    expect(askRecipients(members, 'sam', () => true, never)).toEqual([]);
    expect(askRecipients([{ userId: 'sam' }], 'sam', never, never)).toEqual([]);
  });
});

describe('composeAskNotification', () => {
  const base = { askerName: 'Sam', plantName: 'Monstera', taskType: 'water', note: null };

  it('names the asker, the task and the plant in English', () => {
    const message = composeAskNotification('en', base);
    expect(message.title).toBe('Sam is asking for a hand');
    expect(message.body).toContain('Water for Monstera is up for grabs.');
    expect(message.body).toContain('Claim it if you can.');
  });

  it('quotes the note when there is one, and says nothing when there is not', () => {
    const withNote = composeAskNotification('en', { ...base, note: 'travelling until Sunday' });
    expect(withNote.body).toContain('Sam says: “travelling until Sunday”');
    expect(composeAskNotification('en', base).body).not.toContain('says:');
  });

  it('drops the note from the one-line SMS/push form but keeps what is up for grabs', () => {
    const message = composeAskNotification('en', { ...base, note: 'travelling until Sunday' });
    expect(message.shortBody).toBe('Water for Monstera is up for grabs.');
    expect(message.shortBody).not.toContain('travelling');
  });

  it('writes Spanish for a Spanish recipient, and falls back to English for an unknown locale', () => {
    const es = composeAskNotification('es', { ...base, note: 'de viaje' });
    expect(es.title).toBe('Sam pide ayuda');
    expect(es.body).toContain('Water de Monstera está disponible.');
    expect(es.body).toContain('Sam dice: «de viaje»');
    expect(composeAskNotification('de' as never, base).title).toBe('Sam is asking for a hand');
  });
});

describe('ASK_HELP_WINDOW_MS', () => {
  it('is 24 hours — one ask per task per member per day', () => {
    expect(ASK_HELP_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
