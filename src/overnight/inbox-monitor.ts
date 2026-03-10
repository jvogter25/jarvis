import { Client, TextChannel } from 'discord.js';
import { readInbox, readThread } from '../tools/gmail.js';
import { think } from '../brain.js';
import { queryKnowledge } from '../tools/knowledge.js';
import { CHANNELS } from '../discord/channels.js';

const NOISE_PATTERNS = [
  /no.?reply/i,
  /noreply/i,
  /newsletter/i,
  /unsubscribe/i,
  /notifications?@/i,
  /mailer.daemon/i,
  /postmaster/i,
  /bounce/i,
  /donotreply/i,
];

function isNoiseSender(from: string): boolean {
  return NOISE_PATTERNS.some(p => p.test(from));
}

export async function runInboxMonitor(discord: Client): Promise<void> {
  console.log('[inbox-monitor] Running...');

  let threads;
  try {
    threads = await readInbox(20);
  } catch (err) {
    console.error('[inbox-monitor] Failed to read inbox:', err);
    return;
  }

  if (threads.length === 0) {
    console.log('[inbox-monitor] No unread threads.');
    return;
  }

  const replyThreads = threads.filter(t => t.isReply && !isNoiseSender(t.from));

  if (replyThreads.length === 0) {
    console.log('[inbox-monitor] No reply threads requiring attention.');
    return;
  }

  console.log(`[inbox-monitor] ${replyThreads.length} reply thread(s) to evaluate`);

  const channel = discord.channels.cache.get(CHANNELS.JARVIS) as TextChannel | undefined;
  if (!channel) {
    console.error('[inbox-monitor] JARVIS channel not found');
    return;
  }

  let styleGuide = '';
  try {
    styleGuide = await queryKnowledge('email_style', 'replying to an email conversation');
  } catch {
    console.warn('[inbox-monitor] Could not load email style guide — proceeding without it');
  }

  for (const thread of replyThreads) {
    try {
      const threadText = await readThread(thread.threadId);

      const scoreResult = await think(
        'You are evaluating whether an email thread requires a response. Be conservative — only flag threads that genuinely need a reply (business conversations, active discussions, direct questions). Newsletters, marketing, and passive updates do not need replies.',
        [],
        `Thread:\n${threadText.slice(0, 3000)}\n\nDoes this thread need a response from Jake? Return JSON only:\n{"needs_response": true/false, "reason": "one sentence explanation"}`,
        { model: 'haiku', noTools: true }
      );

      let needsResponse = false;
      let reason = '';
      try {
        const scored = JSON.parse(scoreResult.text);
        needsResponse = scored.needs_response === true;
        reason = scored.reason ?? '';
      } catch {
        console.warn(`[inbox-monitor] Score parse failed for thread ${thread.threadId}`);
        continue;
      }

      if (!needsResponse) {
        console.log(`[inbox-monitor] Skipping "${thread.subject}" — ${reason}`);
        continue;
      }

      const draftResult = await think(
        `You are Jarvis drafting an email reply on Jake's behalf. Write in Jake's voice — direct, friendly, no corporate fluff. Use the style guide provided.${styleGuide ? '\n\nStyle guide:\n' + styleGuide : ''}`,
        [],
        `Thread to reply to:\n${threadText.slice(0, 4000)}\n\nDraft a reply from Jake. Return only the email body — no subject line, no "To:", just the body text.`,
        { model: 'sonnet', noTools: true }
      );

      const draftBody = draftResult.text.trim();

      const msg =
        `📧 **Reply needed** — "${thread.subject}"\n` +
        `From: ${thread.from}\n\n` +
        `**Drafted reply:**\n\n${draftBody}\n\n` +
        `Say **"send it"** to send this reply to ${thread.from}, or tell me what to change.\n` +
        `*(Thread ID: ${thread.threadId})*`;

      if (msg.length <= 2000) {
        await channel.send(msg);
      } else {
        const header = `📧 **Reply needed** — "${thread.subject}"\nFrom: ${thread.from}\n\n**Drafted reply:**`;
        await channel.send(header);
        await channel.send(draftBody.slice(0, 1800));
        await channel.send(`Say **"send it"** to send to ${thread.from}, or tell me what to change.\n*(Thread ID: ${thread.threadId})*`);
      }

      console.log(`[inbox-monitor] Surfaced reply thread: "${thread.subject}"`);
    } catch (err) {
      console.error(`[inbox-monitor] Error processing thread ${thread.threadId}:`, err);
    }
  }

  console.log('[inbox-monitor] Done.');
}
