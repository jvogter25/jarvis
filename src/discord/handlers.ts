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

function extractHtml(text: string): string | null {
  const match = text.match(/```html\n([\s\S]*?)```/) || text.match(/<!DOCTYPE html[\s\S]*<\/html>/i);
  if (match) return match[1] ?? match[0];
  return null;
}

/** Keep sending typing indicator every 8s until done */
function keepTyping(channel: SendableChannel): () => void {
  const interval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);
  return () => clearInterval(interval);
}

export async function handleMessage(msg: DiscordMessage) {
  if (msg.author.bot) return;
  if (msg.channelId !== CHANNELS.JARVIS) return;
  if (!isSendable(msg.channel)) return;

  console.log(`Message received: "${msg.content.slice(0, 60)}"`);
  await msg.channel.sendTyping();
  const stopTyping = keepTyping(msg.channel);

  try {
    console.log('Fetching history...');
    const history = await getRecentMessages(msg.channelId);
    await saveMessage(msg.channelId, 'user', msg.content);

    console.log('Routing to agent...');
    const agentResponse = await routeToAgent(msg.content);

    let reply: string;
    if (agentResponse) {
      console.log('Agent responded');
      reply = agentResponse;
    } else {
      console.log('Using brain...');
      const systemPrompt = await getSystemPrompt();
      reply = await think(systemPrompt, history, msg.content);
    }

    stopTyping();
    await saveMessage(msg.channelId, 'assistant', reply);

    for (const chunk of splitMessage(reply)) {
      await msg.channel.send(chunk);
    }

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
    stopTyping();
    console.error('Error handling message:', err);
    await msg.channel.send('⚠️ Something went wrong. Check the logs.');
  }
}
