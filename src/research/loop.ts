import { Client, TextChannel } from 'discord.js';
import { scrapeReddit, scrapeHN, scrapeBraveSearch, scrapeDevTo } from './scraper.js';
import { scorePost, ScoredOpportunity } from './scorer.js';
import { saveOpportunity, getUnpostedOpportunities, markOpportunityPosted, hasOpportunityByTitle } from '../memory/supabase.js';
import { CHANNELS } from '../discord/channels.js';

export async function runResearchLoop(discord: Client) {
  console.log('Research loop: starting scrape...');

  const [redditPosts, hnPosts, bravePosts, devtoPosts] = await Promise.all([
    scrapeReddit(), scrapeHN(), scrapeBraveSearch(), scrapeDevTo()
  ]);
  const allPosts = [...redditPosts, ...hnPosts, ...bravePosts, ...devtoPosts];

  console.log(`Research loop: scoring ${allPosts.length} posts...`);

  const scored: ScoredOpportunity[] = [];
  for (const post of allPosts) {
    if (await hasOpportunityByTitle(post.title)) continue; // already seen
    const result = await scorePost(post);
    if (result) scored.push(result);
  }

  console.log(`Research loop: ${scored.length} opportunities found`);

  for (const opp of scored) {
    await saveOpportunity(opp);
  }

  const unposted = await getUnpostedOpportunities();
  const channel = discord.channels.cache.get(CHANNELS.RESEARCH) as TextChannel | undefined;

  if (!channel) {
    console.error('Research channel not found in cache');
    return;
  }

  for (const opp of unposted) {
    const msg = `**[${opp.score}/100] ${opp.title}**\n${opp.summary}\nSource: ${opp.source}`;
    await channel.send(msg);
    await markOpportunityPosted(opp.id);
  }
}
