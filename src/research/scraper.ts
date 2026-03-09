import axios from 'axios';

export interface RawPost {
  source: 'reddit' | 'hn' | 'web';
  title: string;
  body: string;
  url: string;
  score: number;
}

export async function scrapeReddit(): Promise<RawPost[]> {
  const subreddits = [
    // Core
    'Entrepreneur', 'SideProject', 'smallbusiness', 'startups',
    // Jake's market — local service businesses & contractors
    'hvacr', 'Plumbing', 'Construction', 'HomeImprovement', 'electricians', 'handyman',
    // B2B SaaS buyers
    'agency', 'freelance', 'msp',
    // Opportunity signals
    'indiehackers', 'SaaS', 'microsaas',
  ];
  const posts: RawPost[] = [];

  for (const sub of subreddits) {
    try {
      const res = await axios.get(`https://www.reddit.com/r/${sub}/hot.json?limit=25`, {
        headers: { 'User-Agent': 'Jarvis/1.0 research-bot' },
      });

      for (const child of res.data.data.children) {
        const post = child.data;
        posts.push({
          source: 'reddit',
          title: post.title,
          body: post.selftext ?? '',
          url: `https://reddit.com${post.permalink}`,
          score: post.score,
        });
      }
    } catch (err) {
      console.error(`Reddit scrape failed for r/${sub}:`, err);
    }
  }

  return posts;
}

export async function scrapeHN(): Promise<RawPost[]> {
  try {
    const res = await axios.get(
      'https://hn.algolia.com/api/v1/search?query=ask+hn+how+do+you&tags=ask_hn&hitsPerPage=30'
    );

    return res.data.hits.map((hit: {
      title?: string;
      story_text?: string;
      url?: string;
      points?: number;
      objectID?: string;
    }) => ({
      source: 'hn' as const,
      title: hit.title ?? '',
      body: hit.story_text ?? '',
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      score: hit.points ?? 0,
    }));
  } catch (err) {
    console.error('HN scrape failed:', err);
    return [];
  }
}

export async function scrapeBraveSearch(): Promise<RawPost[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];

  const queries = [
    'small business owner struggling with software',
    'wish there was a tool that could automate',
    'contractor business problem no good solution',
    'looking for software that does for small business',
  ];

  const posts: RawPost[] = [];

  for (const query of queries) {
    try {
      const res = await axios.get(
        `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: '5' })}`,
        { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } }
      );
      for (const r of (res.data.web?.results ?? [])) {
        posts.push({
          source: 'web',
          title: r.title ?? '',
          body: r.description ?? '',
          url: r.url ?? '',
          score: 0,
        });
      }
    } catch (err) {
      console.error(`Brave search failed for "${query}":`, err);
    }
  }

  return posts;
}

export async function scrapeDevTo(): Promise<RawPost[]> {
  try {
    const res = await axios.get(
      'https://dev.to/api/articles?tag=business&per_page=15&top=7',
      { headers: { 'User-Agent': 'Jarvis/1.0 research-bot' } }
    );
    return res.data.map((a: { title: string; description?: string; url: string; positive_reactions_count: number }) => ({
      source: 'web' as const,
      title: a.title,
      body: a.description ?? '',
      url: a.url,
      score: a.positive_reactions_count,
    }));
  } catch (err) {
    console.error('Dev.to scrape failed:', err);
    return [];
  }
}
