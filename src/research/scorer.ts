import { think } from '../brain.js';
import { RawPost } from './scraper.js';

export interface ScoredOpportunity {
  source: string;
  title: string;
  summary: string;
  score: number;
  raw: RawPost;
}

const SCORING_SYSTEM_PROMPT = `You are a B2B SaaS opportunity evaluator. Given a post, score it 0-100 based on:
- Pain clarity: Is there a clear, recurring business pain? (0-40 pts)
- Payment signal: Do people say they'd pay, or mention budget/current spend? (0-40 pts)
- Market gap: No dominant solution under $100/mo? (0-20 pts)

Respond with JSON only, no markdown fences:
{"score": 0, "summary": "one sentence describing the opportunity"}

If score < 40, still return valid JSON with that low score.`;

export async function scorePost(post: RawPost): Promise<ScoredOpportunity | null> {
  const content = `Title: ${post.title}\n\nBody: ${post.body.slice(0, 1000)}`;

  try {
    const text = (await think(SCORING_SYSTEM_PROMPT, [], content)).text;
    const parsed = JSON.parse(text);
    if (parsed.score < 40) return null;

    return {
      source: post.source,
      title: post.title,
      summary: parsed.summary,
      score: parsed.score,
      raw: post,
    };
  } catch {
    return null;
  }
}
