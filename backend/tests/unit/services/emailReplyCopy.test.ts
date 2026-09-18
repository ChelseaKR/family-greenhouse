import { describe, expect, it } from 'vitest';
import {
  __testing,
  composeExpiredReply,
  composeHelpReply,
  composeOutcomeReply,
  composeUnverifiedReply,
  formatDue,
} from '../../../src/services/emailReplyCopy.js';

const APP = 'https://familygreenhouse.net/tasks?filter=due';
const SUPPORT = 'support@familygreenhouse.net';

describe('reply copy catalogs', () => {
  it('carry the same keys in both locales', () => {
    const { COPY } = __testing;
    expect(Object.keys(COPY.es).sort()).toEqual(Object.keys(COPY.en).sort());
    expect(Object.keys(COPY.es.helpLead).sort()).toEqual(Object.keys(COPY.en.helpLead).sort());
  });
});

describe('composeOutcomeReply', () => {
  it('names what changed and when each task is next due', () => {
    const reply = composeOutcomeReply({
      locale: 'en',
      timeZone: 'America/Los_Angeles',
      appUrl: APP,
      supportAddress: SUPPORT,
      outcomes: [
        {
          kind: 'completed',
          number: 1,
          plantName: 'Monstera',
          taskLabel: 'water',
          nextDue: '2026-09-24T15:00:00.000Z',
        },
        {
          kind: 'snoozed',
          number: 2,
          plantName: 'Fern',
          taskLabel: 'fertilize',
          days: 3,
          nextDue: '2026-09-20T15:00:00.000Z',
        },
      ],
    });
    expect(reply.subject).toBe('Updated from your reply');
    expect(reply.text).toContain(
      '1. Monstera — water: marked done. Next due Thursday, September 24.'
    );
    expect(reply.text).toContain(
      '2. Fern — fertilize: snoozed 3 days. Now due Sunday, September 20.'
    );
    expect(reply.text).toContain(APP);
    expect(reply.text).toContain(`write to ${SUPPORT}`);
  });

  it('reports an already-settled task as settled, never as a success', () => {
    const reply = composeOutcomeReply({
      locale: 'en',
      timeZone: 'UTC',
      appUrl: APP,
      supportAddress: null,
      outcomes: [
        {
          kind: 'settled',
          number: 1,
          plantName: 'Monstera',
          taskLabel: 'water',
          nextDue: '2026-09-24T15:00:00.000Z',
        },
        { kind: 'gone', number: 2 },
      ],
    });
    expect(reply.subject).toBe('No changes from your reply');
    expect(reply.text).toContain('already taken care of');
    expect(reply.text).toContain('Nothing changed.');
    expect(reply.text).not.toMatch(/marked done|snoozed/);
  });

  it('says so when a name could not be loaded, rather than printing an empty one', () => {
    const reply = composeOutcomeReply({
      locale: 'es',
      timeZone: 'UTC',
      appUrl: APP,
      supportAddress: SUPPORT,
      outcomes: [
        { kind: 'completed', number: 1, plantName: ' ', taskLabel: null, nextDue: 'not-a-date' },
      ],
    });
    expect(reply.subject).toBe('Actualizado desde tu respuesta');
    expect(reply.text).toContain('una planta cuyo nombre no pudimos cargar');
    expect(reply.text).toContain('tarea de cuidado sin nombre');
    expect(reply.text).toContain('en una fecha que no pudimos leer');
  });
});

describe('composeHelpReply', () => {
  it('shows the one-task syntax when the reminder listed one task', () => {
    const reply = composeHelpReply({
      locale: 'en',
      reason: 'unrecognized',
      taskCount: 1,
      supportAddress: SUPPORT,
    });
    expect(reply.text).toContain('Nothing was changed');
    expect(reply.text).toContain('  done\n');
    expect(reply.text).not.toContain('done 1');
    expect(reply.text).toContain('once per reminder');
  });

  it('asks which tasks when the reminder listed several', () => {
    const reply = composeHelpReply({
      locale: 'es',
      reason: 'which_task',
      taskCount: 3,
      supportAddress: SUPPORT,
    });
    expect(reply.text).toContain('tu recordatorio tenía 3 tareas');
    expect(reply.text).toContain('hecho 1, 2');
  });
});

describe('expired and unverified notices', () => {
  it('state that nothing changed and where to act instead', () => {
    const expired = composeExpiredReply({ locale: 'en', validDays: 3, appUrl: APP });
    expect(expired.text).toContain('work for 3 days');
    expect(expired.text).toContain('nothing was changed');
    const unverified = composeUnverifiedReply({ locale: 'es', appUrl: APP });
    expect(unverified.text).toContain('no se cambió nada');
    expect(unverified.text).toContain(APP);
  });
});

describe('formatDue', () => {
  it('renders in the reminder zone and falls back to UTC for a corrupt zone', () => {
    expect(formatDue('2026-09-24T02:00:00.000Z', 'en', 'America/Los_Angeles')).toBe(
      'Wednesday, September 23'
    );
    expect(formatDue('2026-09-24T02:00:00.000Z', 'en', 'Not/AZone')).toBe('Thursday, September 24');
    expect(formatDue('garbage', 'en', 'UTC')).toBeNull();
  });
});
