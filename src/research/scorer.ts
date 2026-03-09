import { think } from '../brain.js';
import { RawPost } from './scraper.js';

export interface ScoredOpportunity {
  source: string;
  title: string;
  summary: string;
  score: number;
  raw: RawPost;
}

const SCORING_SYSTEM_PROMPT = `You are an opportunity evaluator for a solo founder focused on B2B SaaS for local service businesses (HVAC, plumbing, electrical, construction, home services) and AI automation tools for small business owners.

Score each post 0-100:
- Pain clarity: Clear recurring business pain expressed? (0-35 pts)
- Payment signal: Mentions paying, budget, or willingness to pay? (0-35 pts)
- Market fit: Relevant to local service businesses, contractors, or small B2B SaaS? (0-20 pts)
- Market gap: No obvious dominant solution under $100/mo? (0-10 pts)

Respond with JSON only, no markdown:
{"score": 0, "summary": "one sentence on the opportunity and why it scores this way"}

Score < 40 = not worth pursuing. Still return valid JSON.`;

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
