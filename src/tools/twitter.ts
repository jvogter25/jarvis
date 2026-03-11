export interface Tweet {
  id: string;
  text: string;
  authorId: string;
  authorName?: string;
  authorUsername?: string;
  createdAt?: string;
  conversationId?: string;
  referencedTweets?: Array<{ type: string; id: string }>;
}

export interface TwitterThreadResult {
  tweet: Tweet;
  thread: Tweet[];
  error?: string;
}

function extractTweetId(input: string): string {
  // Accept raw tweet ID or URL like https://twitter.com/user/status/123 or https://x.com/user/status/123
  const urlMatch = input.match(/\/status\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  throw new Error(`Cannot extract tweet ID from: ${input}`);
}

async function apiFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.twitter.com/2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twitter API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

interface TweetApiResponse {
  data?: {
    id: string;
    text: string;
    author_id: string;
    created_at?: string;
    conversation_id?: string;
    referenced_tweets?: Array<{ type: string; id: string }>;
  };
  includes?: {
    users?: Array<{ id: string; name: string; username: string }>;
  };
}

interface SearchApiResponse {
  data?: Array<{
    id: string;
    text: string;
    author_id: string;
    created_at?: string;
    conversation_id?: string;
    referenced_tweets?: Array<{ type: string; id: string }>;
  }>;
  includes?: {
    users?: Array<{ id: string; name: string; username: string }>;
  };
  meta?: { newest_id?: string; oldest_id?: string; result_count?: number; next_token?: string };
}

function mapTweet(
  raw: NonNullable<TweetApiResponse['data']> | NonNullable<SearchApiResponse['data']>[number],
  users?: Array<{ id: string; name: string; username: string }>
): Tweet {
  const author = users?.find(u => u.id === raw.author_id);
  return {
    id: raw.id,
    text: raw.text,
    authorId: raw.author_id,
    authorName: author?.name,
    authorUsername: author?.username,
    createdAt: raw.created_at,
    conversationId: raw.conversation_id,
    referencedTweets: raw.referenced_tweets,
  };
}

/**
 * Fetch a single tweet and its thread (conversation) replies.
 * Requires TWITTER_BEARER_TOKEN env var.
 */
export async function fetchTwitterThread(tweetIdOrUrl: string): Promise<TwitterThreadResult> {
  const token = process.env.TWITTER_BEARER_TOKEN;
  if (!token) {
    return { tweet: { id: '', text: '', authorId: '' }, thread: [], error: 'TWITTER_BEARER_TOKEN not set' };
  }

  let tweetId: string;
  try {
    tweetId = extractTweetId(tweetIdOrUrl);
  } catch (err) {
    return { tweet: { id: '', text: '', authorId: '' }, thread: [], error: (err as Error).message };
  }

  try {
    // Fetch the root tweet
    const tweetFields = 'tweet.fields=text,author_id,created_at,conversation_id,referenced_tweets';
    const userFields = 'expansions=author_id&user.fields=name,username';
    const rootResp = await apiFetch<TweetApiResponse>(
      `/tweets/${tweetId}?${tweetFields}&${userFields}`,
      token
    );

    if (!rootResp.data) {
      return { tweet: { id: tweetId, text: '', authorId: '' }, thread: [], error: 'Tweet not found' };
    }

    const rootTweet = mapTweet(rootResp.data, rootResp.includes?.users);
    const conversationId = rootResp.data.conversation_id ?? tweetId;

    // Search for replies in the conversation (up to 100)
    const searchResp = await apiFetch<SearchApiResponse>(
      `/tweets/search/recent?query=conversation_id:${conversationId}&${tweetFields}&${userFields}&max_results=100&sort_order=recency`,
      token
    );

    const replyTweets = (searchResp.data ?? [])
      .filter(t => t.id !== tweetId)
      .map(t => mapTweet(t, searchResp.includes?.users))
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));

    return { tweet: rootTweet, thread: replyTweets };
  } catch (err) {
    return { tweet: { id: tweetId!, text: '', authorId: '' }, thread: [], error: (err as Error).message };
  }
}

/**
 * Format a TwitterThreadResult as readable text for Jarvis.
 */
export function formatThread(result: TwitterThreadResult): string {
  if (result.error) return `Twitter error: ${result.error}`;

  const { tweet, thread } = result;
  const authorLine = tweet.authorName
    ? `@${tweet.authorUsername} (${tweet.authorName})`
    : `author_id:${tweet.authorId}`;

  const lines: string[] = [
    `**Tweet ${tweet.id}** by ${authorLine}${tweet.createdAt ? ` · ${tweet.createdAt}` : ''}`,
    tweet.text,
  ];

  if (thread.length > 0) {
    lines.push('', `**Thread replies (${thread.length}):**`);
    for (const reply of thread) {
      const replyAuthor = reply.authorUsername ? `@${reply.authorUsername}` : `author_id:${reply.authorId}`;
      lines.push(`\n${replyAuthor}: ${reply.text}`);
    }
  } else {
    lines.push('', '*(no replies found in conversation)*');
  }

  return lines.join('\n');
}
