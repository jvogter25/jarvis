import { Message as DiscordMessage, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { getRecentMessages, saveMessage, getSystemPrompt } from '../memory/supabase.js';
import { think } from '../brain.js';
import { routeToAgent } from '../agents/router.js';
import { CHANNELS, splitMessage } from './channels.js';

type SendableChannel = TextChannel | DMChannel | NewsChannel;

function isSendable(channel: DiscordMessage['channel']): channel is SendableChannel {
  return 'send' in channel && 'sendTyping' in channel;
}

/** Keep sending typing indicator every 8s until done */
function keepTyping(channel: SendableChannel): () => void {
  const interval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);
  return () => clearInterval(interval);
}

// In-memory: track if we're waiting for install approval
// Maps channelId → { capability, reason }
const pendingInstallRequest = new Map<string, { capability: string; reason: string }>();

const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'sure', 'do it', 'go ahead', 'install it', 'ok', 'okay', 'absolutely', 'y']);
const NO_WORDS = new Set(['no', 'nope', 'nah', 'cancel', 'nevermind', 'never mind', 'skip', 'n']);

function isAffirmative(text: string): boolean {
  return YES_WORDS.has(text.toLowerCase().trim());
}

function isNegative(text: string): boolean {
  return NO_WORDS.has(text.toLowerCase().trim());
}

export async function handleMessage(msg: DiscordMessage) {
  if (msg.author.bot) return;
  if (msg.channelId !== CHANNELS.JARVIS) return;
  if (!isSendable(msg.channel)) return;

  console.log(`Message received: "${msg.content.slice(0, 60)}"`);

  // Check if we're waiting for install approval
  const pending = pendingInstallRequest.get(msg.channelId);
  if (pending) {
    if (isAffirmative(msg.content)) {
      pendingInstallRequest.delete(msg.channelId);
      await msg.channel.send(
        `Got it. To add **${pending.capability}** to my capabilities, ask in Claude Code: "Add ${pending.capability} to Jarvis". It takes a few minutes to build and deploy. I'll be ready after.`
      );
      return;
    } else if (isNegative(msg.content)) {
      pendingInstallRequest.delete(msg.channelId);
      await msg.channel.send(`No problem — skipping the ${pending.capability} install. What else can I help with?`);
      return;
    }
    // Not a yes/no — clear pending and fall through to normal handling
    pendingInstallRequest.delete(msg.channelId);
  }

  await msg.channel.sendTyping();
  const stopTyping = keepTyping(msg.channel);

  try {
    console.log('Fetching history...');
    const history = await getRecentMessages(msg.channelId);
    await saveMessage(msg.channelId, 'user', msg.content);

    console.log('Routing to agent...');
    const agentResponse = await routeToAgent(msg.content);

    if (agentResponse) {
      console.log('Agent responded');
      stopTyping();
      await saveMessage(msg.channelId, 'assistant', agentResponse);
      for (const chunk of splitMessage(agentResponse)) {
        await msg.channel.send(chunk);
      }
      return;
    }

    console.log('Using brain...');
    const systemPrompt = await getSystemPrompt();
    const result = await think(systemPrompt, history, msg.content);
    stopTyping();

    await saveMessage(msg.channelId, 'assistant', result.text);

    // Post text response (if any)
    if (result.text.trim()) {
      for (const chunk of splitMessage(result.text)) {
        await msg.channel.send(chunk);
      }
    }

    // Handle tool results
    for (const toolResult of result.toolResults) {
      if (toolResult.deployedUrl) {
        await msg.channel.send(`✅ Live preview: ${toolResult.deployedUrl}`);
      }
      if (toolResult.installRequest) {
        const { capability, reason } = toolResult.installRequest;
        pendingInstallRequest.set(msg.channelId, { capability, reason });
        await msg.channel.send(
          `To do that I need **${capability}** — which I don't have yet.\n\n**Reason:** ${reason}\n\nWant me to get that installed? (yes/no)`
        );
      }
    }

    // Fallback: if no text and no tool results produced output
    if (!result.text.trim() && result.toolResults.length === 0) {
      await msg.channel.send('Done.');
    }

  } catch (err) {
    stopTyping();
    console.error('Error handling message:', err);
    await msg.channel.send('⚠️ Something went wrong. Check the logs.');
  }
}
