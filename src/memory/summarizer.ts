import { think } from '../brain.js';
import {
  getMessageCount,
  getMessagesForSummary,
  getChannelSummary,
  upsertChannelSummary,
  deleteOldMessages,
  SUMMARY_THRESHOLD,
  RECENCY_WINDOW,
} from './supabase.js';

export async function maybeCondenseChannel(channelId: string): Promise<void> {
  try {
    const count = await getMessageCount(channelId);
    if (count < SUMMARY_THRESHOLD) return;

    const oldMessages = await getMessagesForSummary(channelId, RECENCY_WINDOW);
    if (oldMessages.length === 0) return;

    const existingSummary = await getChannelSummary(channelId);

    const historyText = oldMessages
      .map(m => `${m.role === 'user' ? 'Jake' : 'Jarvis'}: ${m.content}`)
      .join('\n');

    const prompt = existingSummary
      ? `Previous summary:\n${existingSummary}\n\nNew conversation to add:\n${historyText}\n\nUpdate the summary to incorporate the new conversation. Keep it under 400 words. Preserve key decisions, facts, tool results, and context Jake would need in future conversations.`
      : `Summarize this conversation history in under 400 words. Preserve key decisions, facts, tool results, and context Jake would need in future conversations:\n\n${historyText}`;

    const result = await think(
      'You are a conversation summarizer. Produce a concise summary preserving important context.',
      [],
      prompt,
      { model: 'haiku', noTools: true }
    );

    await upsertChannelSummary(channelId, result.text.trim(), count);
    await deleteOldMessages(channelId, RECENCY_WINDOW);

    console.log(`[summarizer] Condensed ${count} messages for channel ${channelId}`);
  } catch (err) {
    console.error('[summarizer] Failed to condense channel:', err);
  }
}
