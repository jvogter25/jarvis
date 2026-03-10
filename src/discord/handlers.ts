import { Message as DiscordMessage, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { getRecentMessages, saveMessage, getSystemPrompt, updateProject, getProjectConfigByChannelId, ProjectConfig } from '../memory/supabase.js';
import { think } from '../brain.js';
import { routeToAgent } from '../agents/router.js';
import { CHANNELS, splitMessage } from './channels.js';
import { executeSelfModifyPlan, SelfModifyPlan } from '../tools/self-modify.js';
import { activateOvernightMode, deactivateOvernightMode, detectOvernightTrigger } from '../overnight/mode.js';
import { extractCssFromUrl, updateDesignTokens, saveComponent, saveInspiration, scanDesignLibrary } from '../tools/design.js';
import { promoteToProduction } from '../tools/builder.js';
import { notifySlackEngineering } from '../tools/slack.js';
import { processTrainingMaterial } from '../tools/knowledge.js';

type SendableChannel = TextChannel | DMChannel | NewsChannel;

function isSendable(channel: DiscordMessage['channel']): channel is SendableChannel {
  return 'send' in channel && 'sendTyping' in channel;
}

/** Keep sending typing indicator every 8s until done */
function keepTyping(channel: SendableChannel): () => void {
  const interval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);
  return () => clearInterval(interval);
}

const pendingStagingApproval = new Map<string, {
  slug: string;
  stagingUrl: string;
  vercelProjectId: string;
}>();

const pendingPRApproval = new Map<string, {
  plan: SelfModifyPlan;
}>();

interface PendingPreviewEntry {
  slug: string;
  previewUrl: string;
  sandboxId: string;
  files: Array<{ path: string; content: string }>;
  plan: {
    projectName: string;
    slug: string;
    description: string;
    buildType: 'landing_page' | 'full_app';
    targetAudience: string;
    components?: string[];
  };
}

const pendingPreviewApproval = new Map<string, PendingPreviewEntry>();

const pendingEmailApproval = new Map<string, {
  to: string;
  subject: string;
  body: string;
}>();

function isShipApproval(text: string, slug?: string): boolean {
  const lower = text.toLowerCase().trim();
  const exactPhrases = ['ship it', 'go live', 'approve', 'push it', 'launch it'];
  if (exactPhrases.includes(lower)) return true;
  if (slug && lower === `ship ${slug}`) return true;
  return false;
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

export async function handleTrainingMessage(msg: DiscordMessage) {
  if (msg.author.bot) return;
  if (!isSendable(msg.channel)) return;

  await msg.channel.sendTyping();
  const stopTyping = keepTyping(msg.channel);

  try {
    const content = msg.content.trim();

    // Parse domain from message: "sales: [content]", "marketing: [url]", etc.
    const DOMAINS = ['sales', 'marketing', 'design', 'engineering', 'general', 'product', 'growth'];
    const domainMatch = content.match(new RegExp(`^(${DOMAINS.join('|')})[:\\s]+(.+)`, 'is'));

    if (!domainMatch) {
      stopTyping();
      await msg.channel.send(
        `Tag the domain first — e.g. \`sales: [url or text]\`, \`marketing: [url]\`, \`design: [text]\`\n\nDomains: ${DOMAINS.join(', ')}`
      );
      return;
    }

    const domain = domainMatch[1].toLowerCase();
    const rawContent = domainMatch[2].trim();

    // Check if it's a URL
    const urlMatch = rawContent.match(/https?:\/\/[^\s]+/);
    const sourceUrl = urlMatch ? urlMatch[0] : undefined;

    await msg.channel.send(`Reading and extracting insights from this ${domain} material...`);

    const result = await processTrainingMaterial(domain, rawContent, sourceUrl);

    stopTyping();
    await msg.channel.send(result);
  } catch (err) {
    stopTyping();
    console.error('Error handling training message:', err);
    await msg.channel.send('⚠️ Failed to process training material. Check the logs.');
  }
}

export function getPendingState() {
  return {
    stagingApprovals: Object.fromEntries(pendingStagingApproval),
    prApprovals: Object.fromEntries(pendingPRApproval),
    previewApprovals: Object.fromEntries(pendingPreviewApproval),
    emailApprovals: Object.fromEntries(pendingEmailApproval),
  };
}

export function restorePendingState(state: ReturnType<typeof getPendingState>): void {
  for (const [k, v] of Object.entries(state.stagingApprovals ?? {})) pendingStagingApproval.set(k, v as any);
  for (const [k, v] of Object.entries(state.prApprovals ?? {})) pendingPRApproval.set(k, v as any);
  for (const [k, v] of Object.entries(state.previewApprovals ?? {})) pendingPreviewApproval.set(k, v as PendingPreviewEntry);
  for (const [k, v] of Object.entries(state.emailApprovals ?? {})) pendingEmailApproval.set(k, v as any);
}

export async function handleMessage(msg: DiscordMessage) {
  if (msg.author.bot) return;
  const { getIsShuttingDown } = await import('../index.js');
  if (getIsShuttingDown()) {
    await msg.reply('Restarting — please resend in a moment.');
    return;
  }
  let isGlobalJarvis = msg.channelId === CHANNELS.JARVIS;
  let projectChannelConfig: ProjectConfig | null = null;

  if (!isGlobalJarvis) {
    projectChannelConfig = await getProjectConfigByChannelId(msg.channelId);
    if (!projectChannelConfig) return;
  }

  if (!isSendable(msg.channel)) return;

  console.log(`Message received: "${msg.content.slice(0, 60)}"`);

  // Check if we're waiting for self-modify approval (from self_modify_request tool)
  const pendingModify = pendingPRApproval.get(msg.channelId);
  if (pendingModify) {
    const approveModify = isShipApproval(msg.content) || isAffirmative(msg.content);
    if (approveModify) {
      pendingPRApproval.delete(msg.channelId);
      await msg.channel.send('Executing the change...');
      try {
        const result = await executeSelfModifyPlan(pendingModify.plan);
        await msg.channel.send(result.message);
        if (result.success && result.prUrl) {
          await notifySlackEngineering(`🔧 Self-modify PR opened: ${result.prUrl}`);
        }
      } catch (err) {
        await msg.channel.send(`⚠️ Failed: ${(err as Error).message}`);
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingPRApproval.delete(msg.channelId);
      await msg.channel.send('Cancelled. Let me know if you want to revisit this.');
      return;
    }
    // Conversational — fall through with pending preserved
  }

  // Check if we're waiting for E2B preview approval (ship it → full Vercel deploy)
  const pendingPreview = pendingPreviewApproval.get(msg.channelId);
  if (pendingPreview) {
    if (isShipApproval(msg.content)) {
      pendingPreviewApproval.delete(msg.channelId);
      await msg.channel.send(`Deploying **${pendingPreview.slug}** to Vercel...`);
      try {
        const { buildProject } = await import('../tools/builder.js');
        const result = await buildProject(pendingPreview.plan, pendingPreview.files, true);
        await updateProject(pendingPreview.slug, { status: 'staging' });
        await msg.channel.send(`Staging ready: ${result.stagingUrl}\n\nSay **"ship it"** again to promote to production.`);
        pendingStagingApproval.set(msg.channelId, {
          slug: result.slug,
          stagingUrl: result.stagingUrl,
          vercelProjectId: result.vercelProjectId,
        });
        await notifySlackEngineering(`🔧 Staging ready: *${result.slug}*\n${result.stagingUrl}`);
      } catch (err) {
        await msg.channel.send(`⚠️ Deploy failed: ${(err as Error).message}`);
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingPreviewApproval.delete(msg.channelId);
      await msg.channel.send(`Preview cancelled. Let me know when you want to rebuild or try a different approach.`);
      return;
    }
    // Conversational — fall through with pending preserved
  }

  // Check if we're waiting for email send approval
  const pendingEmail = pendingEmailApproval.get(msg.channelId);
  if (pendingEmail) {
    if (msg.content.toLowerCase().trim() === 'send it' || isShipApproval(msg.content)) {
      pendingEmailApproval.delete(msg.channelId);
      await msg.channel.send(`Sending email to **${pendingEmail.to}**...`);
      try {
        const { sendEmail } = await import('../tools/gmail.js');
        await sendEmail(pendingEmail.to, pendingEmail.subject, pendingEmail.body);
        await msg.channel.send(`Email sent to **${pendingEmail.to}**.`);
      } catch (err) {
        await msg.channel.send(`Failed to send: ${(err as Error).message}`);
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingEmailApproval.delete(msg.channelId);
      await msg.channel.send(`Email cancelled. Let me know if you want to revise it.`);
      return;
    }
    // Conversational reply — fall through with pending preserved so Jake can edit the draft
  }

  // Check if we're waiting for staging approval
  const pendingStaging = pendingStagingApproval.get(msg.channelId);
  if (pendingStaging) {
    if (isShipApproval(msg.content, pendingStaging.slug)) {
      pendingStagingApproval.delete(msg.channelId);
      await msg.channel.send(`Promoting **${pendingStaging.slug}** to production...`);
      try {
        const productionUrl = await promoteToProduction(pendingStaging.slug);
        await updateProject(pendingStaging.slug, { status: 'live', production_url: productionUrl });
        await msg.channel.send(`🚀 **${pendingStaging.slug}** is live: ${productionUrl}`);
        await notifySlackEngineering(`🚀 *${pendingStaging.slug}* shipped to production: ${productionUrl}`);
      } catch (err) {
        await msg.channel.send(`⚠️ Deploy failed: ${(err as Error).message}`);
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingStagingApproval.delete(msg.channelId);
      await msg.channel.send(`Keeping **${pendingStaging.slug}** in staging. Let me know when you want to ship it or want changes.`);
      return;
    }
    // Conversational message — fall through with staging state preserved
  }

  // Overnight mode deactivation
  const lower = msg.content.toLowerCase().trim();
  if (lower === 'deactivate overnight mode' || lower === 'cancel overnight' || lower === 'disable overnight') {
    deactivateOvernightMode();
    await msg.channel.send('Overnight mode deactivated. Builds can now go to production again.');
    return;
  }

  // Overnight mode trigger detection
  const overnightInstructions = detectOvernightTrigger(msg.content);
  if (overnightInstructions) {
    activateOvernightMode(msg.channelId, overnightInstructions);
    await msg.channel.send(
      `Overnight mode activated.\n\nI'll work on: "${overnightInstructions}"\n\n` +
      `**Rules:** All builds deploy to staging only — nothing goes live without your approval. ` +
      `You'll see a summary in your morning brief.`
    );
    return;
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
    const systemPrompt = projectChannelConfig?.system_prompt ?? await getSystemPrompt();
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
      if (toolResult.stagingBuild) {
        const build = toolResult.stagingBuild;
        pendingStagingApproval.set(msg.channelId, build);
        const stagingMsg = `Staging ready for **${build.slug}**: ${build.stagingUrl}\n\nSay **"ship it"** to deploy to production, or tell me what to change.`;
        await msg.channel.send(stagingMsg);
        await notifySlackEngineering(`🔧 Staging ready: *${build.slug}*\n${build.stagingUrl}\nApprove in Discord to ship.`);
      }
      if (toolResult.selfModifyProposal) {
        pendingPRApproval.set(msg.channelId, { plan: toolResult.selfModifyProposal.plan });
        await msg.channel.send(toolResult.selfModifyProposal.message);
      }
      if (toolResult.previewResult) {
        pendingPreviewApproval.set(msg.channelId, toolResult.previewResult);
      }
      if (toolResult.emailDraftResult) {
        const draft = toolResult.emailDraftResult;
        pendingEmailApproval.set(msg.channelId, draft);
        const draftMsg =
          `📧 Draft ready — send to **${draft.to}**?\n\n` +
          `**Subject:** ${draft.subject}\n\n` +
          `${draft.body}\n\n` +
          `Say **"send it"** to send, or tell me what to change.`;
        await msg.channel.send(draftMsg);
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
