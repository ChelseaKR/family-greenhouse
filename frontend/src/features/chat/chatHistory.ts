import {
  parseProposalBlock,
  type ChatMessage,
  type ProposedReminderTask,
} from '@/services/chatService';

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Reminder proposals attached to this assistant turn (only on assistant
   *  messages, and only when the bot called `propose_reminder_task`). */
  proposals?: ProposedReminderTask[];
}

/**
 * Rebuild the display transcript from persisted conversation history.
 *
 * Proposals live in user-role tool_result blocks (between the assistant's
 * tool_use turn and its final text answer); they're re-attached to the NEXT
 * plain assistant message so reloaded cards sit where they did live. Cards
 * from history are always safe to render — "Create task" goes through the
 * normal POST /tasks, so a stale card just creates the task now.
 *
 * Lives outside ChatPage.tsx because App.tsx lazy-imports page modules as
 * component-only records.
 */
export function historyToDisplayMessages(history: ChatMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let pendingProposals: ProposedReminderTask[] = [];

  history.forEach((m, i) => {
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
      .trim();

    if (m.role === 'user') {
      for (const block of m.content) {
        const proposal = parseProposalBlock(block);
        if (proposal) pendingProposals.push(proposal);
      }
      // tool_result turns are user-role but invisible; only real text shows.
      if (text && !m.content.some((b) => b.type === 'tool_result')) {
        out.push({ id: `h-${i}`, role: 'user', text });
      }
      return;
    }

    // Skip intermediate assistant turns (the ones that called tools); their
    // preamble text is folded away just like in the live sync flow.
    const isFinal = !m.content.some((b) => b.type === 'tool_use');
    if (isFinal && text) {
      out.push({
        id: `h-${i}`,
        role: 'assistant',
        text,
        proposals: pendingProposals.length > 0 ? pendingProposals : undefined,
      });
      pendingProposals = [];
    }
  });

  if (pendingProposals.length > 0) {
    // Conversation ended on a tool turn (cap hit, error) — still surface the
    // cards rather than dropping them.
    out.push({ id: 'h-tail', role: 'assistant', text: '', proposals: pendingProposals });
  }
  return out;
}
