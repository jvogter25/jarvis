import { Client, TextChannel } from 'discord.js';
import { getProjects } from '../memory/supabase.js';
import { think } from '../brain.js';
import { CHANNELS } from '../discord/channels.js';

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
  const liveProjects = await getProjects('live');
  if (liveProjects.length === 0) return;

  const channel = discord.channels.cache.get(CHANNELS.ENGINEERING) as TextChannel | undefined;
  if (!channel) return;

  const summaries: string[] = [];

  for (const project of liveProjects) {
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

    try {
      const analysis = await think(
        'You are a product analyst for a bootstrapped SaaS.',
        [],
        analysisPrompt,
        { model: 'haiku', noTools: true }
      );

      summaries.push([
        `**${project.name}** — ${project.production_url ?? 'no URL'}`,
        analyticsText,
        `Analysis: ${analysis.text}`,
      ].join('\n'));
    } catch {
      summaries.push(`**${project.name}** — analytics unavailable`);
    }
  }

  const header = `**Weekly Product Pulse — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}**\n\n`;
  const body = summaries.join('\n\n---\n\n');
  const full = header + body + '\n\nReply "fix [project]" to queue a fix, or "archive [project]" to retire it.';

  // Split if over 2000 chars
  if (full.length <= 1900) {
    await channel.send(full);
  } else {
    await channel.send(header.trim());
    for (const summary of summaries) {
      const msg = summary.length > 1900 ? summary.slice(0, 1900) + '…' : summary;
      await channel.send(msg);
    }
  }
}
