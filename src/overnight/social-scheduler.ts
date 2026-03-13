import Anthropic from '@anthropic-ai/sdk';
import { searchWeb } from '../tools/search.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface SocialDraft {
  id: string;
  agent: 'vantage' | 'sentinel';
  platform: 'twitter' | 'reddit';
  text: string;
  subreddit?: string;
  sourceHeadline?: string;
  replyToUrl?: string;
  createdAt: string;
}

const AGENT_CONFIGS = {
  vantage: {
    searchQueries: [
      'DeFi tokenomics news today',
      'crypto protocol launch 2025',
      'Web3 governance proposal today',
    ],
    voiceInstructions: `You are Vantage, a sharp Web3 strategy analyst. Your tone is direct, knowledgeable, and slightly opinionated — like a well-read founder who actually understands tokenomics. You don't hype. You don't use jargon for its own sake. You write like someone who has a real take. End with a soft CTA like "If you want this level of analysis on your own protocol, Vantage is on Moltlaunch." Keep tweets under 280 characters including the CTA. For Reddit posts, 150-300 words.`,
    twitterHashtags: '#DeFi #Web3 #tokenomics',
    redditSubs: ['ethfinance', 'defi', 'CryptoCurrency'],
  },
  sentinel: {
    searchQueries: [
      'SEC crypto enforcement 2025',
      'Web3 regulatory news today',
      'DeFi compliance legal 2025',
    ],
    voiceInstructions: `You are Sentinel, a Web3 compliance and growth intelligence agent. Your tone is measured, credible, and precise — like a lawyer who actually understands crypto. You translate regulatory noise into clear implications for builders. End with a soft CTA like "If you need a deeper regulatory intelligence report for your protocol, Sentinel is on Moltlaunch." Keep tweets under 280 characters including the CTA. For Reddit posts, 150-300 words.`,
    twitterHashtags: '#Web3 #crypto #regulation',
    redditSubs: ['ethfinance', 'CryptoCurrency', 'web3'],
  },
};

async function fetchNewsForAgent(agent: 'vantage' | 'sentinel'): Promise<string[]> {
  const config = AGENT_CONFIGS[agent];
  const headlines: string[] = [];

  for (const query of config.searchQueries.slice(0, 2)) {
    const result = await searchWeb(query, 3);
    for (const r of result.results) {
      headlines.push(`${r.title} — ${r.description?.slice(0, 120) ?? ''}`);
    }
  }

  return headlines.slice(0, 5);
}

async function draftTweet(agent: 'vantage' | 'sentinel', headline: string): Promise<string> {
  const config = AGENT_CONFIGS[agent];
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `${config.voiceInstructions}

News item to react to:
${headline}

Write ONE tweet in your voice. Include relevant hashtags: ${config.twitterHashtags}. Do not use quotation marks around it. Return only the tweet text.`,
    }],
  });
  return (response.content[0] as { type: string; text: string }).text.trim();
}

async function draftRedditReply(agent: 'vantage' | 'sentinel', threadTitle: string, threadContent: string): Promise<string> {
  const config = AGENT_CONFIGS[agent];
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `${config.voiceInstructions}

Reddit thread:
Title: ${threadTitle}
Content: ${threadContent?.slice(0, 500) ?? ''}

Write a helpful, substantive reply that adds real value to this discussion. Include your soft CTA at the end. Return only the reply text.`,
    }],
  });
  return (response.content[0] as { type: string; text: string }).text.trim();
}

/**
 * Run the daily social post drafting cycle.
 * Returns an array of drafts to be queued for approval.
 */
export async function runSocialScheduler(): Promise<SocialDraft[]> {
  const drafts: SocialDraft[] = [];
  const agents: Array<'vantage' | 'sentinel'> = ['vantage', 'sentinel'];

  for (const agent of agents) {
    const headlines = await fetchNewsForAgent(agent);
    if (headlines.length === 0) continue;

    const topHeadline = headlines[0];
    try {
      const tweetText = await draftTweet(agent, topHeadline);
      drafts.push({
        id: `${agent}-twitter-${Date.now()}`,
        agent,
        platform: 'twitter',
        text: tweetText,
        sourceHeadline: topHeadline,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[social-scheduler] Tweet draft failed for ${agent}:`, err);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  return drafts;
}

/**
 * Scan relevant subreddits for threads where agents can add value.
 * Returns drafts for threads that score as relevant.
 */
export async function runRedditMonitor(): Promise<SocialDraft[]> {
  const drafts: SocialDraft[] = [];
  const agents: Array<'vantage' | 'sentinel'> = ['vantage', 'sentinel'];

  for (const agent of agents) {
    const config = AGENT_CONFIGS[agent];

    for (const sub of config.redditSubs.slice(0, 2)) {
      const query = agent === 'vantage'
        ? `site:reddit.com/r/${sub} tokenomics OR "protocol analysis" OR "token design"`
        : `site:reddit.com/r/${sub} SEC OR regulation OR compliance OR "legal risk"`;

      const { results } = await searchWeb(query, 3);

      for (const result of results.slice(0, 1)) {
        if (!result.url.includes('/comments/')) continue;

        try {
          const reply = await draftRedditReply(agent, result.title, result.description ?? '');
          drafts.push({
            id: `${agent}-reddit-${Date.now()}-${sub}`,
            agent,
            platform: 'reddit',
            text: reply,
            subreddit: sub,
            sourceHeadline: result.title,
            replyToUrl: result.url,
            createdAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error(`[social-scheduler] Reddit draft failed for ${agent}/${sub}:`, err);
        }

        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  return drafts;
}

export const TWITTER_FOLLOW_LIST = [
  // Moltlaunch
  'moltlaunch',
  // Exchanges
  'coinbase', 'binance', 'krakenfx', 'gemini', 'okx', 'bybit_official',
  // L1s
  'bitcoin', 'ethereum', 'solana', 'avalancheavax', 'cosmos', 'nearprotocol', 'aptos', 'sui_network',
  // L2s / scaling
  'arbitrum', 'optimismFND', 'base', '0xpolygon', 'zksync', 'starknet',
  // DeFi protocols
  'uniswap', 'aave', 'MakerDAO', 'compoundfinance', 'curvefi', 'chainlink', 'lido_fi', 'eigenlayer', 'GMX_IO',
  // News & research
  'coindesk', 'cointelegraph', 'thedefiant', 'messaricrypto', 'blockworks_', 'banklesshq', 'delphi_digital', 'nansen_ai', 'tokenterminal', 'glassnode',
  // Key figures
  'vitalikbuterin', 'haydenzadams', 'stanikulechov', 'naval',
  // Regulatory
  'sec_gov', 'coincenter',
];

export const REDDIT_SUB_LIST = [
  'Bitcoin', 'ethereum', 'CryptoCurrency', 'ethfinance', 'defi',
  'web3', 'solana', 'uniswap', 'Chainlink', '0xPolygon',
];

/**
 * One-time setup: follow Twitter accounts and subscribe to Reddit subs for an agent.
 */
export async function runSocialSetup(agent: 'vantage' | 'sentinel'): Promise<{
  twitter: { followed: number; skipped: number; failed: string[] };
  reddit: { subscribed: number; skipped: number; failed: string[] };
}> {
  const { followTwitterAccounts, subscribeRedditSubs } = await import('../tools/social-post.js');

  console.log(`[social-setup] Running setup for ${agent}...`);
  const twitter = await followTwitterAccounts(agent, TWITTER_FOLLOW_LIST);
  console.log(`[social-setup] Twitter done for ${agent}: followed=${twitter.followed} skipped=${twitter.skipped} failed=${twitter.failed.length}`);

  const reddit = await subscribeRedditSubs(agent, REDDIT_SUB_LIST);
  console.log(`[social-setup] Reddit done for ${agent}: subscribed=${reddit.subscribed} skipped=${reddit.skipped} failed=${reddit.failed.length}`);

  return { twitter, reddit };
}
