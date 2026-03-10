import { Client, TextChannel } from 'discord.js';
import { getAllProjectConfigs, getRecentMessages, getUnpostedOpportunities } from '../memory/supabase.js';
import { think } from '../brain.js';
import { CHANNELS } from '../discord/channels.js';
import { generateOvernightSummary } from './mode.js';
import { readInbox } from '../tools/gmail.js';

export async function postMorningBriefing(discord: Client) {
  console.log('Morning briefing: generating...');

  const history = await getRecentMessages(CHANNELS.JARVIS, 50);
  const opportunities = await getUnpostedOpportunities();

  // Fetch inbox data for morning brief (non-fatal if Gmail not configured)
  let inboxSummary = '';
  try {
    const threads = await readInbox(10);
    const replyThreads = threads.filter(t => t.isReply);
    if (replyThreads.length > 0) {
      inboxSummary = `\n\nOvernight email replies (${replyThreads.length}):\n` +
        replyThreads.map(t => `- "${t.subject}" from ${t.from}`).join('\n');
    } else if (threads.length > 0) {
      inboxSummary = `\n\nInbox: ${threads.length} unread (no replies needing action)`;
    }
  } catch {
    // Gmail not configured or API error — skip silently
  }

  const context = `
Recent conversations (last 50):
${history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 3000)}

Top unreviewed opportunities:
${opportunities.slice(0, 3).map(o => `- [${o.score}/100] ${o.title}: ${o.summary}`).join('\n') || 'None yet'}${inboxSummary}
`;

  try {
    const briefing = (await think(
      'You are Jarvis. Write a concise morning briefing for Jake. Include: what happened recently, top 3 priorities for today, any opportunities to review. Be direct, no fluff. Use markdown headers.',
      [],
      context
    )).text;

    let overnightSummary = '';
    try {
      overnightSummary = await generateOvernightSummary();
    } catch (err) {
      console.error('Overnight summary failed (non-fatal):', err);
    }
    const fullBriefing = overnightSummary
      ? `${briefing}\n\n---\n${overnightSummary}`
      : briefing;

    const channel = discord.channels.cache.get(CHANNELS.MORNING_BRIEF) as TextChannel | undefined;
    if (channel) {
      await channel.send(`**Good morning, Jake.**\n\n${fullBriefing}`);
    }
  } catch (err) {
    console.error('Morning briefing failed:', err);
  }

  console.log('Morning briefing: sent');
}

export async function postProjectMorningBriefings(discord: Client) {
  const projects = await getAllProjectConfigs();
  if (projects.length === 0) return;

  console.log(`[briefing] Project morning briefs: ${projects.length} active projects`);

  for (const project of projects) {
    try {
      const morningBriefChannelId = project.channels.morning_brief;
      const channel = discord.channels.cache.get(morningBriefChannelId) as TextChannel | undefined;
      if (!channel) continue;

      // Get recent messages from project's general channel for context
      const history = await getRecentMessages(project.channels.general, 30);

      const context = `Project: ${project.slug}
Recent activity (last 30 messages in #general):
${history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 2000)}`;

      const briefing = (await think(
        `You are Jarvis writing a morning brief for the ${project.slug} project. Be specific to this project only. Include: what was worked on, current status, today's priorities. 3-5 bullet points max. Direct, no fluff.`,
        [],
        context,
        { model: 'haiku', noTools: true }
      )).text;

      await channel.send(`**Good morning — ${project.slug} update**\n\n${briefing}`);
      console.log(`[briefing] Project morning brief posted: ${project.slug}`);
    } catch (err) {
      console.error(`[briefing] Project morning brief failed for ${project.slug}:`, err);
    }
  }
}

export async function postProjectOvernightLogs(discord: Client) {
  const projects = await getAllProjectConfigs();
  if (projects.length === 0) return;

  for (const project of projects) {
    try {
      const overnightChannelId = project.channels.overnight_log;
      const channel = discord.channels.cache.get(overnightChannelId) as TextChannel | undefined;
      if (!channel) continue;

      // Get last 20 messages from engineering channel as proxy for overnight activity
      const recentEngineering = await getRecentMessages(project.channels.engineering, 20);
      if (recentEngineering.length === 0) continue;

      const summary = (await think(
        `Summarize overnight activity for the ${project.slug} project in 2-3 sentences. Focus on what changed, what was shipped, what's pending.`,
        [],
        recentEngineering.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 2000),
        { model: 'haiku', noTools: true }
      )).text;

      await channel.send(`**Overnight log — ${new Date().toLocaleDateString()}**\n\n${summary}`);
    } catch (err) {
      console.error(`[briefing] Overnight log failed for ${project.slug}:`, err);
    }
  }
}
