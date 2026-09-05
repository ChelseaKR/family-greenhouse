import { describe, expect, it } from 'vitest';
import { historyToDisplayMessages } from './chatHistory';

describe('chat history', () => {
  it('restores persisted Sprout citations on reload', () => {
    const messages = historyToDisplayMessages([
      {
        timestamp: '2026-07-12T00:00:00Z',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Use bright indirect light.' },
          {
            type: 'citation',
            title: 'Monstera care',
            url: 'https://example.test/monstera',
            source: 'monstera.md',
            fetch_date: '2026-05-01',
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        id: 'h-0',
        role: 'assistant',
        text: 'Use bright indirect light.',
        proposals: undefined,
        citations: [
          {
            title: 'Monstera care',
            url: 'https://example.test/monstera',
            source: 'monstera.md',
            fetch_date: '2026-05-01',
          },
        ],
      },
    ]);
  });

  /**
   * #579: the backend built `disclosure` and dropped it before it reached
   * anyone. It is persisted as its own block now, so a reloaded transcript has
   * to show the same statement the live turn did — and must not fold it into
   * the answer text, where it would read as something the assistant said.
   */
  it('restores the persisted Sprout disclosure without folding it into the answer', () => {
    const messages = historyToDisplayMessages([
      {
        timestamp: '2026-07-12T00:00:00Z',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Pothos is toxic to cats.' },
          { type: 'disclosure', text: 'General information, not veterinary advice.' },
          {
            type: 'coverage',
            plants: { total: 112, included: 40, unmatched: 62, truncated: 10, cap: 100 },
            tasks: { total: 9, included: 9, unmatched: 0, truncated: 0, cap: 100 },
            partial: true,
          },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Pothos is toxic to cats.');
    expect(messages[0].disclosure).toBe('General information, not veterinary advice.');
    // The coverage block round-trips but renders nothing yet: what a user is
    // TOLD when coverage is partial is still an owner decision (#549).
    expect(messages[0]).not.toHaveProperty('coverage');
  });

  it('leaves the disclosure undefined when the turn carried none', () => {
    const messages = historyToDisplayMessages([
      {
        timestamp: '2026-07-12T00:00:00Z',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Use bright indirect light.' },
          { type: 'disclosure', text: '   ' },
        ],
      },
    ]);

    expect(messages[0].disclosure).toBeUndefined();
  });
});
