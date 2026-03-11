const TWITTER_API_BASE = 'https://api.twitter.com/2';

const TWEET_FIELDS = 'text,author_id,created_at,conversation_id,in_reply_to_user_id,public_metrics';
const EXPANSIONS = 'author_id';
const USER_FIELDS = 'username,name';

export interface Tweet {
  id: string;
  text: string;
  authorId: string;
  authorUsername?: string;
  authorName?: string;
  createdAt?: string;
  conversationId?: string;
  publicMetrics?: {
    replyCount: number;
    retweetCount: number;
    likeCount: number;
  };
}

export interface FetchTweetResult {
  tweet?: Tweet;
  error?: string;
}

export interface FetchThreadResult {
  tweets?: Tweet[];
  error?: string;
}

function getBearerToken(): string | null {
  return process.env.TWITTER_BEARER_TOKEN ?? null;
}

function authHeaders(): Record<string, string> {
  const token = getBearerToken();
  if (!token) throw new Error('TWITTER_BEARER_TOKEN not set');
  return { Authorization: `Bearer ${token}` };
}

function mapTweet(raw: Record<string, unknown>, users: Map<string, { username: string; name: string }>): Tweet {
  const metrics = raw.public_metrics as Record<string, number> | undefined;
  const authorId = raw.author_id as string;
  const user = users.get(authorId);
  return {
    id: raw.id as string,
    text: raw.text as string,
    authorId,
    authorUsername: user?.username,
    authorName: user?.name,
    createdAt: raw.created_at as string | undefined,
    conversationId: raw.conversation_id as string | undefined,
    publicMetrics: metrics
      ? { replyCount: metrics.reply_count, retweetCount: metrics.retweet_count, likeCount: metrics.like_count }
      : undefined,
  };
}

/**
 * Fetch a single tweet by ID using the Twitter v2 API.
 * Requires TWITTER_BEARER_TOKEN env var.
 */
export async function fetchTweet(tweetId: string): Promise<FetchTweetResult> {
  const token = getBearerToken();
  if (!token) return { error: 'TWITTER_BEARER_TOKEN not set' };

  try {
    const params = new URLSearchParams({
      'tweet.fields': TWEET_FIELDS,
      expansions: EXPANSIONS,
      'user.fields': USER_FIELDS,
    });

    const res = await fetch(`${TWITTER_API_BASE}/tweets/${tweetId}?${params}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text();
      return { error: `Twitter API error: ${res.status} ${res.statusText} — ${body}` };
    }

    const data = await res.json() as {
      data: Record<string, unknown>;
      includes?: { users?: Array<{ id: string; username: string; name: string }> };
      errors?: Array<{ detail: string }>;
    };

    if (data.errors?.length) {
      return { error: data.errors.map(e => e.detail).join('; ') };
    }

    const users = new Map<string, { username: string; name: string }>(
      (data.includes?.users ?? []).map(u => [u.id, { username: u.username, name: u.name }])
    );

    return { tweet: mapTweet(data.data, users) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Fetch a tweet thread by starting tweet ID.
 * Returns the original tweet + all replies in the same conversation, sorted chronologically.
 * Requires TWITTER_BEARER_TOKEN env var.
 * Note: Twitter v2 search only covers the last 7 days on Basic/Free plans.
 */
export async function fetchThread(tweetId: string): Promise<FetchThreadResult> {
  const token = getBearerToken();
  if (!token) return { error: 'TWITTER_BEARER_TOKEN not set' };

  try {
    // First fetch the root tweet to get conversation_id
    const rootResult = await fetchTweet(tweetId);
    if (rootResult.error) return { error: rootResult.error };
    const root = rootResult.tweet!;
    const conversationId = root.conversationId ?? tweetId;

    // Search for all tweets in the conversation
    const params = new URLSearchParams({
      query: `conversation_id:${conversationId}`,
      'tweet.fields': TWEET_FIELDS,
      expansions: EXPANSIONS,
      'user.fields': USER_FIELDS,
      max_results: '100',
    });

    const res = await fetch(`${TWITTER_API_BASE}/tweets/search/recent?${params}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text();
      // If search fails (e.g. no search access), return just the root tweet
      if (res.status === 403 || res.status === 401) {
        return { tweets: [root], error: `Thread search requires Elevated/Basic Twitter API access. Returning root tweet only. API error: ${res.status}` };
      }
      return { error: `Twitter search API error: ${res.status} ${res.statusText} — ${body}` };
    }

    const data = await res.json() as {
      data?: Array<Record<string, unknown>>;
      includes?: { users?: Array<{ id: string; username: string; name: string }> };
      errors?: Array<{ detail: string }>;
    };

    const users = new Map<string, { username: string; name: string }>(
      (data.includes?.users ?? []).map(u => [u.id, { username: u.username, name: u.name }])
    );

    const replies = (data.data ?? []).map(t => mapTweet(t, users));

    // Combine root + replies, sort by createdAt ascending
    const all = [root, ...replies].sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    // Deduplicate by id
    const seen = new Set<string>();
    const deduped = all.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });

    return { tweets: deduped };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
