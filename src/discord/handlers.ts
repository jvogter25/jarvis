import { Message as DiscordMessage, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { getRecentMessages, saveMessage, getSystemPrompt } from '../memory/supabase.js';
import { think } from '../brain.js';
import { routeToAgent } from '../agents/router.js';
import { CHANNELS, splitMessage } from './channels.js';
import { executeSelfModify, INSTALL_PLANS } from '../tools/self-modify.js';
import { extractCssFromUrl, updateDesignTokens, saveComponent, saveInspiration, scanDesignLibrary } from '../tools/design.js';
import { promoteToProduction } from '../tools/builder.js';
import { updateProject } from '../memory/supabase.js';

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

const pendingStagingApproval = new Map<string, {
  slug: string;
  stagingUrl: string;
  vercelProjectId: string;
}>();

const SHIP_PHRASES = ['ship it', 'ship', 'deploy', 'go live', 'approve', 'push it', 'launch it'];
function isShipApproval(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return SHIP_PHRASES.includes(lower) || lower.startsWith('ship ');
}

const YES_WORDS = new Set(['yes', 'yeah', 'yep', 'sure', 'do it', 'go ahead', 'install it', 'ok', 'okay', 'absolutely', 'y']);
const NO_WORDS = new Set(['no', 'nope', 'nah', 'cancel', 'nevermind', 'never mind', 'skip', 'n']);

function isAffirmative(text: string): boolean {
  return YES_WORDS.has(text.toLowerCase().trim());
}

function isNegative(text: string): boolean {
  return NO_WORDS.has(text.toLowerCase().trim());
}

export async function handleDesignMessage(msg: DiscordMessage) {
  if (msg.author.bot) return;
  if (!isSendable(msg.channel)) return;

  await msg.channel.sendTyping();
  const stopTyping = keepTyping(msg.channel);

  try {
    const content = msg.content.trim();

    // Image attachment → save as inspiration
    if (msg.attachments.size > 0) {
      const attachment = msg.attachments.first()!;
      if (attachment.contentType?.startsWith('image/')) {
        const res = await fetch(attachment.url);
        const buffer = await res.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const ext = attachment.contentType.split('/')[1] ?? 'png';
        const fileName = `${Date.now()}-${attachment.name ?? 'inspiration'}.${ext}`;
        await saveInspiration(fileName, base64);
        stopTyping();
        await msg.channel.send(`Saved to inspiration library as \`${fileName}\`. I'll use this as visual context when building.`);
        return;
      } else {
        stopTyping();
        await msg.channel.send(`I can only save image attachments here. Drop a screenshot or design image, paste a code block to save a component, or drop a URL to extract styles.`);
        return;
      }
    }

    // Code block → save as component
    const codeBlockMatch = content.match(/```(?:tsx?|jsx?|html?)?\n([\s\S]+?)```/);
    if (codeBlockMatch) {
      const surrounding = content.replace(codeBlockMatch[0], '').trim();
      const componentName = surrounding || `component-${Date.now()}`;
      await saveComponent(componentName, codeBlockMatch[1]);
      stopTyping();
      await msg.channel.send(`Saved component as \`${componentName.replace(/\s+/g, '-').toLowerCase()}.tsx\`. I'll suggest it for relevant builds.`);
      return;
    }

    // URL → extract CSS
    const urlMatch = content.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const url = urlMatch[0];
      await msg.channel.send(`Extracting design tokens from ${url}...`);
      const extracted = await extractCssFromUrl(url);
      const hasData = Object.values(extracted).some(v => v && Object.keys(v).length > 0);
      if (!hasData) {
        stopTyping();
        await msg.channel.send(`Couldn't extract CSS variables from that URL — it may use non-standard styles. Any notes on what you liked about it?`);
        return;
      }
      await updateDesignTokens(extracted, url);
      const summary = Object.entries(extracted)
        .filter(([, v]) => v && Object.keys(v).length > 0)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n');
      stopTyping();
      await msg.channel.send(`Design tokens updated from ${url}:\n\`\`\`json\n${summary}\n\`\`\``);
      return;
    }

    // Fallback: show library status
    const library = await scanDesignLibrary();
    stopTyping();
    await msg.channel.send(
      `Design library: ${library.components.length} component(s) saved.\n${library.tokenSummary}\n\n` +
      `Drop a URL to extract styles, paste a code block (with a component name above it) to save a component, or upload a screenshot for inspiration.`
    );
  } catch (err) {
    stopTyping();
    console.error('Error handling design message:', err);
    await msg.channel.send('⚠️ Something went wrong with the design library.');
  }
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
      const toolId = pending.capability.toLowerCase().replace(/\s+/g, '_');
      const plan = INSTALL_PLANS[toolId];
      if (plan) {
        await msg.channel.send(`On it — installing **${pending.capability}** now...`);
        const result = await executeSelfModify(plan);
        await msg.channel.send(result.message);
      } else {
        await msg.channel.send(
          `I don't have an auto-install recipe for **${pending.capability}** yet. Ask in Claude Code: "Add ${pending.capability} to Jarvis" and it'll be wired up.`
        );
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingInstallRequest.delete(msg.channelId);
      await msg.channel.send(`No problem — skipping the ${pending.capability} install. What else can I help with?`);
      return;
    }
    // Not a yes/no — clear pending and fall through to normal handling
    pendingInstallRequest.delete(msg.channelId);
  }

  // Check if we're waiting for staging approval
  const pendingStaging = pendingStagingApproval.get(msg.channelId);
  if (pendingStaging) {
    if (isShipApproval(msg.content)) {
      pendingStagingApproval.delete(msg.channelId);
      await msg.channel.send(`Promoting **${pendingStaging.slug}** to production...`);
      try {
        const productionUrl = await promoteToProduction(pendingStaging.slug);
        await updateProject(pendingStaging.slug, { status: 'live', production_url: productionUrl });
        await msg.channel.send(`🚀 **${pendingStaging.slug}** is live: ${productionUrl}`);
      } catch (err) {
        await msg.channel.send(`⚠️ Deploy failed: ${(err as Error).message}`);
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingStagingApproval.delete(msg.channelId);
      await msg.channel.send(`Keeping **${pendingStaging.slug}** in staging. Let me know when you want to ship it or want changes.`);
      return;
    }
    pendingStagingApproval.delete(msg.channelId);
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
      if (toolResult.stagingBuild) {
        const build = toolResult.stagingBuild;
        pendingStagingApproval.set(msg.channelId, build);
        await msg.channel.send(
          `Staging ready for **${build.slug}**: ${build.stagingUrl}\n\nSay **"ship it"** to deploy to production, or tell me what to change.`
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
