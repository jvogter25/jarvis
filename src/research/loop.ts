import { Client, TextChannel } from 'discord.js';
import {
  scrapeReddit, scrapeHN, scrapeBraveSearch,
  scrapeProductHunt, scrapeIndieHackers, scrapeG2Reviews,
} from './scraper.js';
import { scorePost, ScoredOpportunity } from './scorer.js';
import { saveOpportunity, getUnpostedOpportunities, markOpportunityPosted, hasOpportunityByTitle } from '../memory/supabase.js';
import { CHANNELS } from '../discord/channels.js';
import { MANUAL_QUEUE } from './manual-queue.js';

export async function runResearchLoop(discord: Client): Promise<void> {
  console.log('Research loop: starting scrape...');

  const [redditPosts, hnPosts, bravePosts, phPosts, ihPosts, g2Posts] = await Promise.all([
    scrapeReddit(),
    scrapeHN(),
    scrapeBraveSearch(),
    scrapeProductHunt(),
    scrapeIndieHackers(),
    scrapeG2Reviews(),
  ]);

  const allPosts = [...redditPosts, ...hnPosts, ...bravePosts, ...phPosts, ...ihPosts, ...g2Posts, ...MANUAL_QUEUE];
  console.log(`Research loop: scoring ${allPosts.length} posts...`);

  const scored: ScoredOpportunity[] = [];
  for (const post of allPosts) {
    if (await hasOpportunityByTitle(post.title)) continue;
    const result = await scorePost(post);
    if (result) scored.push(result);
  }

  console.log(`Research loop: ${scored.length} opportunities found`);

  for (const opp of scored) {
    await saveOpportunity({
      source: opp.source,
      title: opp.title,
      summary: opp.summary,
      score: opp.score,
      leverage_note: opp.leverageNote,
      deep_dive: opp.deepDive,
      raw: opp.raw,
    });
  }

  const unposted = await getUnpostedOpportunities();
  // Use fetch() not cache.get() — cache.get() returns undefined if the channel
  // was never loaded into cache (common on first run or after restart).
  const channel = await discord.channels.fetch(CHANNELS.RESEARCH).catch(() => null) as TextChannel | null;

  if (!channel) {
    console.error('Research channel not found — check DISCORD_CHANNEL_RESEARCH env var');
    return;
  }

  for (const opp of unposted) {
    const lines = [
      `**[${opp.score}/100] ${opp.title}**`,
      opp.summary,
      opp.leverageNote ? `⚡ Leverage: ${opp.leverageNote}` : '',
      `Source: ${opp.source}`,
    ].filter(Boolean);

    let msg = lines.join('\n');

    if (opp.deepDive) {
      msg += `\n\n**Deep Dive:**\n${opp.deepDive}`;
    }

    // Discord message limit is 2000 chars
    if (msg.length > 1900) msg = msg.slice(0, 1900) + '…';

    await channel.send(msg);
    await markOpportunityPosted(opp.id);
  }
}
