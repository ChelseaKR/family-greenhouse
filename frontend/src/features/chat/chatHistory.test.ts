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
});
