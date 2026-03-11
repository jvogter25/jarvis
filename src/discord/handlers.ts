import { Message as DiscordMessage, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { emitDashboardEvent } from '../dashboard/events.js';
import { getRecentMessages, saveMessage, getSystemPrompt, getChannelSummary, updateProject, getProjectConfigByChannelId, ProjectConfig } from '../memory/supabase.js';
import { maybeCondenseChannel } from '../memory/summarizer.js';
import { think } from '../brain.js';
import { routeToAgent } from '../agents/router.js';
import { CHANNELS, splitMessage } from './channels.js';
import { executeSelfModifyPlan, requestSelfModify, SelfModifyPlan } from '../tools/self-modify.js';
import { activateOvernightMode, deactivateOvernightMode, detectOvernightTrigger, isOvernightActive, getOvernightInstructions } from '../overnight/mode.js';
import { getInstalledTools } from '../tools/registry.js';
import { loadAgents } from '../agents/manifest.js';
import { isEmergencyLocked, activateEmergencyLock, deactivateEmergencyLock, detectKillPhrase, detectResumePhrase } from '../tools/emergency.js';
import { extractCssFromUrl, updateDesignTokens, saveComponent, saveInspiration, scanDesignLibrary } from '../tools/design.js';
import { promoteToProduction } from '../tools/builder.js';
import { notifySlackEngineering } from '../tools/slack.js';
import { processTrainingMaterial } from '../tools/knowledge.js';
import { handleSetupAgents } from '../commands/setupAgents.js';

type SendableChannel = TextChannel | DMChannel | NewsChannel;

function isSendable(channel: DiscordMessage['channel']): channel is SendableChannel {
  return 'send' in channel && 'sendTyping' in channel;
}

/** Keep sending typing indicator every 8s until done */
function keepTyping(channel: SendableChannel): () => void {
  const interval = setInterval(() => channel.sendTyping().catch(() => {}), 8000);
  return () => clearInterval(interval);
}

async function runSelfModifyInBackground(
  intent: string,
  reportChannel: SendableChannel
): Promise<void> {
  try {
    const notify = (msg: string) => reportChannel.send(msg).then(() => {});
    const result = await requestSelfModify(intent, notify);
    if (!result.success || !result.plan) {
      await reportChannel.send(`Self-modify failed: ${result.message}`);
      return;
    }
    // Key by #jarvis so Jake's "ship it" there is found by handleMessage
    pendingPRApproval.set(CHANNELS.JARVIS, { plan: result.plan });
    // Approval prompt to #jarvis only — #engineering already got progress logs via notify
    const { getDiscordClient } = await import('./client.js');
    const dc = getDiscordClient();
    const jarvisChannel = dc ? await dc.channels.fetch(CHANNELS.JARVIS).catch(() => null) : null;
    if (jarvisChannel && isSendable(jarvisChannel as DiscordMessage['channel'])) {
      await (jarvisChannel as SendableChannel).send(result.message);
    }
  } catch (err) {
    await reportChannel.send(`Self-modify error: ${(err as Error).message}`);
  }
}

const pendingStagingApproval = new Map<string, {
  slug: string;
  stagingUrl: string;
  vercelProjectId: string;
}>();

const pendingPRApproval = new Map<string, {
  plan: SelfModifyPlan;
}>();

// Short-term memory: after a PR is opened, remember it for 15 min so
// follow-up questions ("did you ship it?") don't retrigger Claude Code.
const recentlyShippedPR = new Map<string, { prUrl: string; shippedAt: number }>();
const PR_MEMORY_MS = 15 * 60 * 1000;

// Confirmation gate: before running Claude Code the brain surfaces the intent here.
// Jake says yes/no; only on yes does Claude Code actually fire.
const pendingSelfModifyConfirmation = new Map<string, { intent: string }>();

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

function buildStatusMessage(): string {
  const uptimeSec = Math.floor(process.uptime());
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  const uptimeStr = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  const emergencyLock = isEmergencyLocked() ? '🔴 ACTIVE — baseline mode only' : '🟢 Off';
  const overnight = isOvernightActive()
    ? `🌙 Active — "${getOvernightInstructions()}"`
    : '⬜ Off';

  const installedTools = getInstalledTools();
  const toolList = installedTools.length > 0
    ? installedTools.map(t => `  • ${t.name}`).join('\n')
    : '  (none)';

  let agentCount = 0;
  try { agentCount = loadAgents().length; } catch {}

  const pending = getPendingState();
  const pendingLines: string[] = [];
  const stagingCount = Object.keys(pending.stagingApprovals).length;
  const prCount = Object.keys(pending.prApprovals).length;
  const previewCount = Object.keys(pending.previewApprovals).length;
  const emailCount = Object.keys(pending.emailApprovals).length;
  if (stagingCount) pendingLines.push(`  • ${stagingCount} staging deploy(s) awaiting "ship it"`);
  if (prCount) pendingLines.push(`  • ${prCount} self-modify PR(s) awaiting approval`);
  if (previewCount) pendingLines.push(`  • ${previewCount} preview(s) awaiting "ship it"`);
  if (emailCount) pendingLines.push(`  • ${emailCount} email draft(s) awaiting "send it"`);
  const pendingStr = pendingLines.length > 0 ? pendingLines.join('\n') : '  None';

  return [
    '**Jarvis Status**',
    `**Uptime:** ${uptimeStr}`,
    `**Emergency lock:** ${emergencyLock}`,
    `**Overnight mode:** ${overnight}`,
    `**Agents loaded:** ${agentCount}`,
    `**Installed tools (${installedTools.length}):**\n${toolList}`,
    `**Pending approvals:**\n${pendingStr}`,
  ].join('\n');
}

export async function handleDesignMessage(msg: DiscordMessage) {
  if (msg.author.bot) return;
  if (!isSendable(msg.channel)) return;

  await msg.channel.sendTyping();
  const stopTyping = keepTyping(msg.channel);

  try {
    let content = msg.content.trim();

    // Attachment handling
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
      } else if (
        attachment.contentType?.startsWith('text/') ||
        attachment.name?.match(/\.(txt|md|csv|json|ts|js|py|html|css)$/i)
      ) {
        // Text/code file — fetch content and inject into brain context
        try {
          const res = await fetch(attachment.url);
          const fileText = await res.text();
          content = `[File: ${attachment.name}]\n\`\`\`\n${fileText.slice(0, 12000)}\n\`\`\`\n\n${content}`.trim();
        } catch (err) {
          stopTyping();
          await msg.channel.send(`Couldn't read that file: ${(err as Error).message}`);
          return;
        }
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
  emitDashboardEvent({
    type: 'message_received',
    room: 'office',
    agent: 'discord',
    task: msg.content.slice(0, 120),
  });

  // ── Emergency kill switch ─────────────────────────────────────────────────
  if (detectKillPhrase(msg.content)) {
    const pendingState = { pendingApprovals: getPendingState() };
    const { sandboxesKilled, pendingCleared } = await activateEmergencyLock(pendingState);
    pendingStagingApproval.clear();
    pendingPRApproval.clear();
    pendingPreviewApproval.clear();
    pendingEmailApproval.clear();
    const killedLine = sandboxesKilled > 0 ? `\nKilled: ${sandboxesKilled} active sandbox(es)` : '';
    const clearedLine = pendingCleared.length > 0 ? `\nCleared: ${pendingCleared.join(', ')}` : '';
    await msg.channel.send(
      `🛑 **Emergency stop activated.**${killedLine}${clearedLine}\n\n` +
      `I'm in **baseline mode** — overnight research, training, and inbox monitoring continue as normal.\n` +
      `Nothing else runs until you say **"all clear"**.`
    );
    return;
  }

  // ── Resume from emergency lock ────────────────────────────────────────────
  if (detectResumePhrase(msg.content) && isEmergencyLocked()) {
    await deactivateEmergencyLock();
    await msg.channel.send(
      `✅ **All clear — back to full operations.**\n\n` +
      `Anything in-flight before the stop has been cleared. Tell me what you want to pick back up.`
    );
    return;
  }

  // ── Block non-baseline work when locked ───────────────────────────────────
  if (isEmergencyLocked()) {
    const isOperationalRequest = /\b(?:add|build|install|create|implement|modify|fix|ship|deploy|queue)\b/i.test(msg.content);
    if (isOperationalRequest) {
      await msg.channel.send(`I'm in baseline mode right now. Say **"all clear"** to resume full operations.`);
      return;
    }
  }

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
          recentlyShippedPR.set(CHANNELS.JARVIS, { prUrl: result.prUrl, shippedAt: Date.now() });
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

  // Check if we're waiting for Jake to confirm a brain-proposed code change
  const pendingConfirm = pendingSelfModifyConfirmation.get(msg.channelId);
  if (pendingConfirm) {
    if (isAffirmative(msg.content)) {
      pendingSelfModifyConfirmation.delete(msg.channelId);
      const { getDiscordClient } = await import('./client.js');
      const discord = getDiscordClient();
      const engChannelRaw = discord
        ? await discord.channels.fetch(CHANNELS.ENGINEERING).catch(() => null)
        : null;
      if (engChannelRaw && isSendable(engChannelRaw as DiscordMessage['channel'])) {
        const engChannel = engChannelRaw as SendableChannel;
        await msg.channel.send("On it — progress in #engineering.");
        await saveMessage(msg.channelId, 'user', pendingConfirm.intent);
        runSelfModifyInBackground(pendingConfirm.intent, engChannel).catch(err =>
          console.error('[self-modify-confirm] Failed:', err)
        );
      }
      return;
    } else if (isNegative(msg.content)) {
      pendingSelfModifyConfirmation.delete(msg.channelId);
      await msg.channel.send("Got it — not implementing that. What else can I help with?");
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
        emitDashboardEvent({
          type: 'build_complete',
          room: 'engineering',
          agent: 'builder',
          task: `Shipped ${pendingStaging.slug} → ${productionUrl}`,
          data: { slug: pendingStaging.slug, url: productionUrl },
        });
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

  // Override cron — immediately execute a task, bypassing the queue and schedule.
  // Triggers: "override cron, [task]" | "do this now: [task]" | "priority: [task]" | "drop everything and [task]"
  const overrideMatch = msg.content.match(
    /^(?:override cron[,:\s]+|do this now[:\s]+|priority[:\s]+|drop everything and\s+)(.+)/i
  );
  if (overrideMatch && isGlobalJarvis && !isEmergencyLocked()) {
    const task = overrideMatch[1].trim();
    const { getDiscordClient } = await import('./client.js');
    const discord = getDiscordClient();
    const engChannelRaw = discord
      ? await discord.channels.fetch(CHANNELS.ENGINEERING).catch(() => null)
      : null;
    if (engChannelRaw && isSendable(engChannelRaw as DiscordMessage['channel'])) {
      const engChannel = engChannelRaw as SendableChannel;
      await msg.channel.send(`Overriding schedule — running now. Progress in #engineering.`);
      await saveMessage(msg.channelId, 'user', msg.content);
      runSelfModifyInBackground(task, engChannel).catch(err =>
        console.error('[override-cron] Failed:', err)
      );
      return;
    }
  }

  // !setup-agents [--dry-run]
  if (/^!setup-agents(\s|$)/i.test(msg.content)) {
    const dryRun = /--dry-run/i.test(msg.content);
    await handleSetupAgents(msg, dryRun);
    return;
  }

  // Engineering queue: "add to queue: X" or "queue this: X"
  const queueMatch = msg.content.match(/^(?:add to (?:engineering )?queue|queue this)[:\s]+(.+)/i);
  if (queueMatch) {
    const { addToQueue } = await import('../memory/supabase.js');
    const item = await addToQueue(queueMatch[1].trim());
    await msg.channel.send(`Added to engineering queue. I'll build it tonight.\n> ${item.intent.slice(0, 100)}`);
    return;
  }

  // Status command
  const lower = msg.content.toLowerCase().trim();
  if (lower === 'status' || lower === '/status') {
    await msg.channel.send(buildStatusMessage());
    return;
  }

  // Overnight mode deactivation
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

  // If a PR was recently opened, answer status questions instead of re-running.
  const recentPR = recentlyShippedPR.get(CHANNELS.JARVIS);
  if (recentPR && isGlobalJarvis && Date.now() - recentPR.shippedAt < PR_MEMORY_MS) {
    const isStatusCheck = /\b(?:did you|have you|did it|did that|finalize|ship|land|merge|pr|pull request|done|finished|complete|status)\b/i.test(msg.content);
    if (isStatusCheck) {
      await msg.channel.send(`Already shipped — PR is open: ${recentPR.prUrl}\nMerge it on GitHub and Railway redeploys automatically.`);
      return;
    }
    // Unrelated new request — clear memory so it doesn't block fresh work
    recentlyShippedPR.delete(CHANNELS.JARVIS);
  }

  // Self-modify fast path: detect coding task requests and fire background immediately
  // so Jarvis stays responsive while Claude Code runs (10-15 min).
  const CODING_TASK = /\b(?:add|implement|create|build|make|write)\b.{1,80}\b(?:command|feature|tool|handler|function|plugin|integration|endpoint|route|webhook)\b/i;
  const explicitSelfModify =
    /\b(?:add .* integration|add .* tool|install .* package|change .* behavior|implement .* feature|self.?modify)\b/i.test(msg.content)
    || CODING_TASK.test(msg.content);
  if (explicitSelfModify && isGlobalJarvis && !isEmergencyLocked()) {
    const { getDiscordClient } = await import('./client.js');
    const discord = getDiscordClient();
    const engChannelRaw = discord
      ? await discord.channels.fetch(CHANNELS.ENGINEERING).catch(() => null)
      : null;
    if (engChannelRaw && isSendable(engChannelRaw as DiscordMessage['channel'])) {
      const engChannel = engChannelRaw as SendableChannel;
      await msg.channel.send("On it — I'll post the PR to #engineering when Claude Code finishes (usually 10-15 min).");
      await saveMessage(msg.channelId, 'user', msg.content);
      runSelfModifyInBackground(msg.content, engChannel).catch(err =>
        console.error('[self-modify-bg] Failed:', err)
      );
      return;
    }
    // Fall through to normal brain routing if engineering channel not available
  }

  // Effective content — may be augmented with file attachment text below
  let content = msg.content.trim();

  // Text file attachment: fetch content and prepend to brain input
  if (msg.attachments.size > 0) {
    const attachment = msg.attachments.first()!;
    if (
      attachment.contentType?.startsWith('text/') ||
      attachment.name?.match(/\.(txt|md|csv|json|ts|js|py|html|css)$/i)
    ) {
      try {
        const res = await fetch(attachment.url);
        const fileText = await res.text();
        content = `[File: ${attachment.name}]\n\`\`\`\n${fileText.slice(0, 12000)}\n\`\`\`\n\n${content}`.trim();
      } catch {
        // non-fatal — fall through with original content
      }
    }
  }

  await msg.channel.sendTyping();
  const stopTyping = keepTyping(msg.channel);

  try {
    console.log('Fetching history...');
    const history = await getRecentMessages(msg.channelId);
    await saveMessage(msg.channelId, 'user', content);
    maybeCondenseChannel(msg.channelId).catch(() => {}); // async, don't await

    console.log('Routing to agent...');
    const sendableChannel = msg.channel; // already narrowed by isSendable guard above
    const onStepComplete = async (
      step: { agentId: string; role: string; handoffContext: string },
      _output: string,
      stepIndex: number,
      totalSteps: number
    ) => {
      await sendableChannel.send(`*Step ${stepIndex + 1}/${totalSteps} (${step.role}) complete...*`);
    };
    const agentResponse = await routeToAgent(content, onStepComplete);

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
    const channelSummary = await getChannelSummary(msg.channelId);
    const effectiveSystemPrompt = channelSummary
      ? `${systemPrompt}\n\n---\nCONVERSATION HISTORY SUMMARY (older messages):\n${channelSummary}`
      : systemPrompt;
    // Always post coding progress to #engineering so Jake sees it there, not in #jarvis
    const { getDiscordClient } = await import('./client.js');
    const discordClient = getDiscordClient();
    const engChannelRaw = discordClient
      ? await discordClient.channels.fetch(CHANNELS.ENGINEERING).catch(() => null)
      : null;
    const engChannel = (engChannelRaw && isSendable(engChannelRaw as DiscordMessage['channel']))
      ? engChannelRaw as SendableChannel
      : msg.channel;  // fallback if engineering unavailable
    console.log('[notify] Engineering channel:', CHANNELS.ENGINEERING, '| fallback?', !engChannelRaw);
    const notify = (m: string) => engChannel.send(m).then(() => {});
    const result = await think(effectiveSystemPrompt, history, content, { notify });
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
      if (toolResult.selfModifyIntent) {
        // Brain wants to make a code change — ask Jake first before running Claude Code.
        pendingSelfModifyConfirmation.set(msg.channelId, { intent: toolResult.selfModifyIntent });
        await msg.channel.send(
          `That sounds like a code change request.\n\n> ${toolResult.selfModifyIntent}\n\nShould I implement this? **(yes/no)**`
        );
      }
      if (toolResult.selfModifyProposal) {
        // Always key by #jarvis so Jake's "ship it" there is caught by handleMessage.
        // Post full details to #engineering; send a short redirect to #jarvis.
        pendingPRApproval.set(CHANNELS.JARVIS, { plan: toolResult.selfModifyProposal.plan });
        const { getDiscordClient } = await import('./client.js');
        const discord = getDiscordClient();
        if (discord) {
          const engChannelRaw = await discord.channels.fetch(CHANNELS.ENGINEERING).catch(() => null);
          if (engChannelRaw && isSendable(engChannelRaw as DiscordMessage['channel'])) {
            await (engChannelRaw as SendableChannel).send(toolResult.selfModifyProposal.message);
          }
        }
        await msg.channel.send("Done — check #engineering for details. Say **ship it** here when ready.");
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
