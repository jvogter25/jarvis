import axios from 'axios';

export interface RawPost {
  source: 'reddit' | 'hn';
  title: string;
  body: string;
  url: string;
  score: number;
}

export async function scrapeReddit(): Promise<RawPost[]> {
  const subreddits = ['Entrepreneur', 'SideProject', 'smallbusiness', 'startups'];
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
