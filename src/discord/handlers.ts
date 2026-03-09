import { Message as DiscordMessage, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { getRecentMessages, saveMessage, getSystemPrompt } from '../memory/supabase.js';
import { think } from '../brain.js';
import { routeToAgent } from '../agents/router.js';
import { CHANNELS, splitMessage } from './channels.js';
import { serveHtml } from '../sandbox/client.js';

type SendableChannel = TextChannel | DMChannel | NewsChannel;

function isSendable(channel: DiscordMessage['channel']): channel is SendableChannel {
  return 'send' in channel && 'sendTyping' in channel;
}

/** Extract first HTML block from a response if present */
function extractHtml(text: string): string | null {
  const match = text.match(/```html\n([\s\S]*?)```/) || text.match(/<!DOCTYPE html[\s\S]*<\/html>/i);
  if (match) return match[1] ?? match[0];
  return null;
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

    // If the reply contains HTML, auto-deploy it to a sandbox
    const html = extractHtml(reply);
    if (html && process.env.E2B_API_KEY) {
      await msg.channel.send('🚀 Deploying to sandbox...');
      try {
        const { url } = await serveHtml(html);
        await msg.channel.send(`✅ Live preview: ${url}`);
      } catch (sandboxErr) {
        console.error('Sandbox deploy failed:', sandboxErr);
        await msg.channel.send('⚠️ Sandbox deploy failed — HTML is above, run it locally.');
      }
    }
  } catch (err) {
    console.error('Error handling message:', err);
    await msg.channel.send('⚠️ Something went wrong. Check the logs.');
  }
}
