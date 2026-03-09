import { Message as DiscordMessage, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { getRecentMessages, saveMessage, getSystemPrompt } from '../memory/supabase.js';
import { think } from '../brain.js';
import { routeToAgent } from '../agents/router.js';
import { CHANNELS, splitMessage } from './channels.js';

type SendableChannel = TextChannel | DMChannel | NewsChannel;

function isSendable(channel: DiscordMessage['channel']): channel is SendableChannel {
  return 'send' in channel && 'sendTyping' in channel;
}

export async function handleMessage(msg: DiscordMessage) {
  if (msg.author.bot) return;
  if (msg.channelId !== CHANNELS.JARVIS) return;
  if (!isSendable(msg.channel)) return;

  await msg.channel.sendTyping();

  try {
    const history = await getRecentMessages(msg.channelId);
    await saveMessage(msg.channelId, 'user', msg.content);

    const agentResponse = await routeToAgent(msg.content);

    let reply: string;
    if (agentResponse) {
      reply = agentResponse;
    } else {
      const systemPrompt = await getSystemPrompt();
      reply = await think(systemPrompt, history, msg.content);
    }

    await saveMessage(msg.channelId, 'assistant', reply);

    for (const chunk of splitMessage(reply)) {
      await msg.channel.send(chunk);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Error handling message:', err);
    await msg.channel.send(`⚠️ Error: ${errMsg}`);
  }
}
