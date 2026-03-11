export interface TweetData {
  id: string;
  text: string;
  authorId: string;
  authorUsername?: string;
  authorName?: string;
  createdAt?: string;
  conversationId?: string;
  inReplyToUserId?: string;
}

export interface FetchTweetResult {
  tweet: TweetData;
  thread: TweetData[];  // other tweets in the same conversation thread
  error?: string;
}

/**
 * Extract the tweet ID from a Twitter/X URL.
 * Handles formats like:
 *   https://twitter.com/user/status/1234567890
 *   https://x.com/user/status/1234567890
 *   https://mobile.twitter.com/user/status/1234567890
 */
export function extractTweetId(url: string): string | null {
  const match = url.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i);
  return match?.[1] ?? null;
}

const TWEET_FIELDS = 'text,author_id,conversation_id,created_at,in_reply_to_user_id';
const EXPANSIONS = 'author_id';
const USER_FIELDS = 'username,name';

async function twitterGet(path: string, token: string): Promise<Response> {
  return fetch(`https://api.twitter.com/2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
}

/**
 * Fetch a tweet and its thread context by URL.
 * Uses TWITTER_BEARER_TOKEN env var.
 */
export async function fetchTweet(url: string): Promise<FetchTweetResult> {
  const token = process.env.TWITTER_BEARER_TOKEN;
  if (!token) {
    return { tweet: { id: '', text: '', authorId: '' }, thread: [], error: 'TWITTER_BEARER_TOKEN not set' };
  }

  const tweetId = extractTweetId(url);
  if (!tweetId) {
    return { tweet: { id: '', text: '', authorId: '' }, thread: [], error: `Could not extract tweet ID from URL: ${url}` };
  }

  // Fetch the main tweet
  const tweetRes = await twitterGet(
    `/tweets/${tweetId}?tweet.fields=${TWEET_FIELDS}&expansions=${EXPANSIONS}&user.fields=${USER_FIELDS}`,
    token
  );

  if (!tweetRes.ok) {
    const body = await tweetRes.text().catch(() => '');
    return {
      tweet: { id: tweetId, text: '', authorId: '' },
      thread: [],
      error: `Twitter API error ${tweetRes.status}: ${body.slice(0, 200)}`,
    };
  }

  const tweetJson = await tweetRes.json() as {
    data?: {
      id: string;
      text: string;
      author_id: string;
      conversation_id?: string;
      created_at?: string;
      in_reply_to_user_id?: string;
    };
    includes?: {
      users?: Array<{ id: string; username: string; name: string }>;
    };
    errors?: Array<{ detail: string }>;
  };

  if (!tweetJson.data) {
    const errDetail = tweetJson.errors?.[0]?.detail ?? 'Unknown error';
    return { tweet: { id: tweetId, text: '', authorId: '' }, thread: [], error: errDetail };
  }

  const users = tweetJson.includes?.users ?? [];
  const authorUser = users.find(u => u.id === tweetJson.data!.author_id);

  const mainTweet: TweetData = {
    id: tweetJson.data.id,
    text: tweetJson.data.text,
    authorId: tweetJson.data.author_id,
    authorUsername: authorUser?.username,
    authorName: authorUser?.name,
    createdAt: tweetJson.data.created_at,
    conversationId: tweetJson.data.conversation_id,
    inReplyToUserId: tweetJson.data.in_reply_to_user_id,
  };

  // If there's a conversation thread (tweet is part of a thread), fetch it
  const thread: TweetData[] = [];
  const conversationId = tweetJson.data.conversation_id;
  if (conversationId && conversationId !== tweetId) {
    // Fetch the root tweet of the conversation
    const rootRes = await twitterGet(
      `/tweets/${conversationId}?tweet.fields=${TWEET_FIELDS}&expansions=${EXPANSIONS}&user.fields=${USER_FIELDS}`,
      token
    );
    if (rootRes.ok) {
      const rootJson = await rootRes.json() as {
        data?: { id: string; text: string; author_id: string; conversation_id?: string; created_at?: string };
        includes?: { users?: Array<{ id: string; username: string; name: string }> };
      };
      if (rootJson.data) {
        const rootUsers = rootJson.includes?.users ?? [];
        const rootAuthor = rootUsers.find(u => u.id === rootJson.data!.author_id);
        thread.push({
          id: rootJson.data.id,
          text: rootJson.data.text,
          authorId: rootJson.data.author_id,
          authorUsername: rootAuthor?.username,
          authorName: rootAuthor?.name,
          createdAt: rootJson.data.created_at,
          conversationId: rootJson.data.conversation_id,
        });
      }
    }

    // Fetch recent replies in the conversation by the same author (thread replies)
    const authorId = mainTweet.authorId;
    const searchRes = await twitterGet(
      `/tweets/search/recent?query=conversation_id:${conversationId}%20from:${authorId}&tweet.fields=${TWEET_FIELDS}&expansions=${EXPANSIONS}&user.fields=${USER_FIELDS}&max_results=10`,
      token
    );
    if (searchRes.ok) {
      const searchJson = await searchRes.json() as {
        data?: Array<{ id: string; text: string; author_id: string; conversation_id?: string; created_at?: string; in_reply_to_user_id?: string }>;
        includes?: { users?: Array<{ id: string; username: string; name: string }> };
      };
      const searchUsers = searchJson.includes?.users ?? [];
      for (const t of searchJson.data ?? []) {
        if (t.id === tweetId) continue; // skip main tweet
        const user = searchUsers.find(u => u.id === t.author_id);
        thread.push({
          id: t.id,
          text: t.text,
          authorId: t.author_id,
          authorUsername: user?.username,
          authorName: user?.name,
          createdAt: t.created_at,
          conversationId: t.conversation_id,
          inReplyToUserId: t.in_reply_to_user_id,
        });
      }
      // Sort thread by created_at ascending
      thread.sort((a, b) => {
        if (!a.createdAt || !b.createdAt) return 0;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
    }
  }

  return { tweet: mainTweet, thread };
}

/**
 * Format a FetchTweetResult as a readable string for Claude.
 */
export function formatTweetResult(result: FetchTweetResult): string {
  if (result.error) {
    return `Twitter fetch failed: ${result.error}`;
  }

  const { tweet, thread } = result;
  const author = tweet.authorName
    ? `${tweet.authorName} (@${tweet.authorUsername})`
    : `@${tweet.authorUsername ?? tweet.authorId}`;
  const date = tweet.createdAt ? ` · ${new Date(tweet.createdAt).toUTCString()}` : '';

  let out = `**Tweet by ${author}**${date}\n\n${tweet.text}`;

  if (thread.length > 0) {
    out += `\n\n---\n**Thread context (${thread.length} tweet${thread.length > 1 ? 's' : ''}):**\n`;
    for (const t of thread) {
      const tAuthor = t.authorName
        ? `${t.authorName} (@${t.authorUsername})`
        : `@${t.authorUsername ?? t.authorId}`;
      const tDate = t.createdAt ? ` · ${new Date(t.createdAt).toUTCString()}` : '';
      out += `\n**${tAuthor}**${tDate}\n${t.text}\n`;
    }
  }

  return out;
}
