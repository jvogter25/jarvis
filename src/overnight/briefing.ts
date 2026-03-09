import { Client, TextChannel } from 'discord.js';
import { getRecentMessages, getUnpostedOpportunities } from '../memory/supabase.js';
import { think } from '../brain.js';
import { CHANNELS } from '../discord/channels.js';
import { generateOvernightSummary } from './mode.js';

export async function postMorningBriefing(discord: Client) {
  console.log('Morning briefing: generating...');

  const history = await getRecentMessages(CHANNELS.JARVIS, 50);
  const opportunities = await getUnpostedOpportunities();

  const context = `
Recent conversations (last 50):
${history.map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 3000)}

Top unreviewed opportunities:
${opportunities.slice(0, 3).map(o => `- [${o.score}/100] ${o.title}: ${o.summary}`).join('\n') || 'None yet'}
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
