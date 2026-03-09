import { Client, TextChannel } from 'discord.js';
import { getRecentMessages, getSystemPrompt, saveSystemPrompt } from '../memory/supabase.js';
import { think } from '../brain.js';
import { CHANNELS } from '../discord/channels.js';

export async function runOvernightTraining(discord: Client) {
  console.log('Overnight training: starting...');

  const history = await getRecentMessages(CHANNELS.JARVIS, 100);
  const currentPrompt = await getSystemPrompt();

  if (history.length < 10) {
    console.log('Not enough conversation data yet, skipping training');
    return;
  }

  const conversation = history.map(m => `${m.role}: ${m.content}`).join('\n');

  const analysisPrompt = `You are a prompt engineer. Review this conversation between Jarvis (AI co-CEO) and Jake, then rewrite Jarvis's system prompt to be more effective.

Current system prompt:
${currentPrompt}

Recent conversations:
${conversation.slice(0, 8000)}

Analyze: What was routed correctly? What produced bad outputs? What confused Jarvis?
Then rewrite the system prompt to address these issues. Keep it under 500 words.

Respond with JSON only, no markdown:
{"analysis": "what you found", "new_prompt": "the improved system prompt"}`;

  try {
    const text = await think('You are a prompt engineering assistant.', [], analysisPrompt);
    const parsed = JSON.parse(text);
    await saveSystemPrompt(parsed.new_prompt);

    const logChannel = discord.channels.cache.get(CHANNELS.OVERNIGHT_LOG) as TextChannel | undefined;
    if (logChannel) {
      await logChannel.send(`**Overnight Training Complete**\n\n**Analysis:** ${parsed.analysis}\n\n**New prompt version saved.**`);
    }
  } catch (err) {
    console.error('Overnight training failed:', err);
  }

  console.log('Overnight training: complete');
}
