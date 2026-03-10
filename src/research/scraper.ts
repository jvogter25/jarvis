import axios from 'axios';

export interface RawPost {
  source: 'reddit' | 'hn' | 'web';
  title: string;
  body: string;
  url: string;
  score: number;
}

// Reddit OAuth token cache — valid for 1 hour
let redditToken: string | null = null;
let redditTokenExpiry = 0;

async function getRedditToken(): Promise<string | null> {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (redditToken && Date.now() < redditTokenExpiry) return redditToken;

  try {
    const res = await axios.post(
      'https://www.reddit.com/api/v1/access_token',
      'grant_type=client_credentials',
      {
        auth: { username: clientId, password: clientSecret },
        headers: {
          'User-Agent': 'Jarvis/1.0 research-bot',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    redditToken = res.data.access_token;
    redditTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000; // refresh 1min early
    return redditToken;
  } catch (err) {
    console.error(`Reddit OAuth failed: ${(err as Error).message}`);
    return null;
  }
}

export async function scrapeReddit(): Promise<RawPost[]> {
  const token = await getRedditToken();
  if (!token) {
    console.error('Reddit scrape skipped: REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set');
    return [];
  }

  const subreddits = [
    // Core entrepreneurship
    'Entrepreneur', 'SideProject', 'smallbusiness', 'startups',
    // B2B SaaS buyers
    'agency', 'freelance', 'msp', 'SaaS', 'microsaas',
    // Opportunity signals
    'indiehackers', 'nocode', 'Automate',
    // Vertical markets with high software pain
    'realestateinvesting', 'Accounting', 'legaladvice', 'marketing',
    'ecommerce', 'FulfillmentByAmazon', 'restaurateur', 'Dentistry',
    // Contractor / local service (keep some — still valid verticals)
    'Construction', 'HomeImprovement', 'handyman',
  ];
  const posts: RawPost[] = [];

  for (const sub of subreddits) {
    try {
      const res = await axios.get(`https://oauth.reddit.com/r/${sub}/hot?limit=20`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Jarvis/1.0 research-bot',
        },
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
      const status = (err as any)?.response?.status;
      console.error(`Reddit scrape failed for r/${sub}: ${status ? `HTTP ${status}` : (err as Error).message}`);
    }
  }

  return posts;
}

export async function scrapeHN(): Promise<RawPost[]> {
  const queries = [
    'ask+hn+how+do+you',
    'ask+hn+is+there+a+tool',
    'ask+hn+software+frustration',
  ];
  const posts: RawPost[] = [];

  for (const q of queries) {
    try {
      const res = await axios.get(
        `https://hn.algolia.com/api/v1/search?query=${q}&tags=ask_hn&hitsPerPage=20`
      );
      for (const hit of res.data.hits) {
        posts.push({
          source: 'hn' as const,
          title: hit.title ?? '',
          body: hit.story_text ?? '',
          url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
          score: hit.points ?? 0,
        });
      }
    } catch (err) {
      console.error(`HN scrape failed for query ${q}: ${(err as Error).message}`);
    }
  }

  return posts;
}

export async function scrapeProductHunt(): Promise<RawPost[]> {
  // PH doesn't have a free API — use Jina reader on their "newest" web page
  try {
    const res = await fetch('https://r.jina.ai/https://www.producthunt.com/products', {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const text = await res.text();

    // Extract product lines from the markdown output
    const lines = text.split('\n').filter(l => l.trim().length > 20);
    return lines.slice(0, 40).map(line => ({
      source: 'web' as const,
      title: line.trim().slice(0, 120),
      body: '',
      url: 'https://www.producthunt.com',
      score: 0,
    }));
  } catch (err) {
    console.error(`Product Hunt scrape failed: ${(err as Error).message}`);
    return [];
  }
}

export async function scrapeIndieHackers(): Promise<RawPost[]> {
  try {
    const res = await fetch('https://r.jina.ai/https://www.indiehackers.com/posts', {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const text = await res.text();

    const lines = text.split('\n').filter(l => l.trim().length > 30 && !l.startsWith('#'));
    return lines.slice(0, 30).map(line => ({
      source: 'web' as const,
      title: line.trim().slice(0, 120),
      body: '',
      url: 'https://www.indiehackers.com',
      score: 0,
    }));
  } catch (err) {
    console.error(`IndieHackers scrape failed: ${(err as Error).message}`);
    return [];
  }
}

export async function scrapeBraveSearch(): Promise<RawPost[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];

  const queries = [
    // Broad SaaS pain signals
    'B2B software frustration "wish there was" site:reddit.com OR site:news.ycombinator.com',
    'small business owner "no good software" OR "no tool that"',
    'entrepreneurs "paying too much for" software automation',
    'startup "manual process" OR "we built a spreadsheet" instead software',
    // White-label opportunity signals
    '"white label" software opportunity small business recurring revenue',
    'GoHighLevel alternative niche industry vertical',
    'Notion template OR Airtable template business "selling for"',
    // Vertical pain
    'G2 review "worst feature" OR "missing" B2B SaaS 2025',
    'Capterra review "too expensive" OR "poor customer service" small business software',
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
      console.error(`Brave search failed for "${query}": ${(err as Error).message}`);
    }
  }

  return posts;
}

export async function scrapeG2Reviews(): Promise<RawPost[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];

  // Search for G2/Capterra complaint patterns in categories with known pain
  const queries = [
    'site:g2.com "what do you dislike" small business CRM 2024 2025',
    'site:capterra.com "cons" field service management software',
    'site:g2.com "wish it could" OR "missing feature" agency project management',
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
      console.error(`G2 search failed: ${(err as Error).message}`);
    }
  }

  return posts;
}
