import { Client, TextChannel } from 'discord.js';
import { getProjects, getAllProjectConfigs } from '../memory/supabase.js';
import { think } from '../brain.js';
import { CHANNELS } from '../discord/channels.js';
import { emitDashboardEvent } from '../dashboard/events.js';

interface VercelAnalytics {
  pageviews: number;
  uniqueVisitors: number;
  topPages: Array<{ path: string; views: number }>;
}

async function fetchVercelAnalytics(projectId: string): Promise<VercelAnalytics | null> {
  const token = process.env.VERCEL_TOKEN;
  if (!token || !projectId) return null;

  const teamId = process.env.VERCEL_TEAM_ID;
  const teamParam = teamId ? `&teamId=${teamId}` : '';

  // Vercel Analytics API — last 7 days
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const url = `https://api.vercel.com/v1/analytics/summary?projectId=${projectId}&from=${since}${teamParam}`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;

    const data = await res.json() as {
      pageviews?: { value?: number };
      uniqueVisitors?: { value?: number };
      topPaths?: Array<{ path: string; count: number }>;
    };

    return {
      pageviews: data.pageviews?.value ?? 0,
      uniqueVisitors: data.uniqueVisitors?.value ?? 0,
      topPages: (data.topPaths ?? []).slice(0, 5).map(p => ({ path: p.path, views: p.count })),
    };
  } catch {
    return null;
  }
}

export async function runProductPulse(discord: Client): Promise<void> {
  emitDashboardEvent({ type: 'cron_start', room: 'research', agent: 'product-pulse', task: 'Weekly product pulse running...' });
  const liveProjects = await getProjects('live');
  if (liveProjects.length === 0) {
    emitDashboardEvent({ type: 'cron_complete', room: 'research', agent: 'product-pulse', task: 'No live projects to pulse' });
    return;
  }

  const projectConfigs = await getAllProjectConfigs();
  const projectChannelMap = new Map(
    projectConfigs.map(p => [p.slug, p.channels.engineering])
  );

  const dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  for (const project of liveProjects) {
    const projectEngineeringId = projectChannelMap.get(project.slug) ?? CHANNELS.ENGINEERING;
    const projectChannel = discord.channels.cache.get(projectEngineeringId) as TextChannel | undefined;
    if (!projectChannel) continue;

    const analytics = project.vercel_project_id
      ? await fetchVercelAnalytics(project.vercel_project_id)
      : null;

    let analyticsText = 'No analytics data available.';
    if (analytics) {
      analyticsText = [
        `Pageviews (7d): ${analytics.pageviews}`,
        `Unique visitors (7d): ${analytics.uniqueVisitors}`,
        analytics.topPages.length > 0
          ? `Top pages: ${analytics.topPages.map(p => `${p.path} (${p.views})`).join(', ')}`
          : '',
      ].filter(Boolean).join('\n');
    }

    // Ask Claude to analyze and suggest improvements
    const analysisPrompt = `You are analyzing a live SaaS product for a solo founder.

Project: ${project.name}
Description: ${project.description ?? 'N/A'}
URL: ${project.production_url ?? 'N/A'}

Weekly analytics:
${analyticsText}

In 3-4 sentences max:
1. What does the data suggest about where users are dropping off or what's working?
2. One specific improvement to try (copy change, new feature, pricing tweak, SEO fix)?
3. Is this worth the founder's continued attention or should it be deprioritized?

Be direct. No hedging.`;

    emitDashboardEvent({ type: 'cron_start', room: 'research', agent: 'product-pulse', task: `Analyzing ${project.name}...` });
    try {
      const analysis = await think(
        'You are a product analyst for a bootstrapped SaaS.',
        [],
        analysisPrompt,
        { model: 'haiku', noTools: true }
      );

      const summary = [
        `**${project.name}** — ${project.production_url ?? 'no URL'}`,
        analyticsText,
        `Analysis: ${analysis.text}`,
      ].join('\n');

      const header = `**Weekly Product Pulse — ${dateLabel}** · ${project.name}\n\n`;
      const full = header + summary + '\n\nReply "fix [project]" to queue a fix, or "archive [project]" to retire it.';

      if (full.length <= 1900) {
        await projectChannel.send(full);
      } else {
        await projectChannel.send(header.trim());
        const msg = summary.length > 1900 ? summary.slice(0, 1900) + '…' : summary;
        await projectChannel.send(msg);
      }
    } catch {
      const fallback = `**${project.name}** — analytics unavailable`;
      await projectChannel.send(fallback).catch(() => undefined);
    }
    emitDashboardEvent({ type: 'cron_complete', room: 'research', agent: 'product-pulse', task: `Pulse complete: ${project.name}` });
  }
}
