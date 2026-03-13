import { think } from '../brain.js';
import { RawPost } from './scraper.js';

export interface ScoredOpportunity {
  source: string;
  title: string;
  summary: string;
  score: number;
  leverageNote: string;
  deepDive?: string;
  raw: RawPost;
}

const SCORING_SYSTEM_PROMPT = `You are an opportunity evaluator for a solo founder with a full-time job who wants to build and operate B2B SaaS products in under 2 hours/week each.

Score each post 0-100 across these dimensions:
- Pain clarity (0-25): Is there a clear, recurring, specific business pain expressed?
- Payment signal (0-25): Does someone mention paying, budgets, or willingness to pay?
- Market gap (0-15): Is there no obvious dominant solution under $100/mo?
- Leverage potential (0-20): Can this be built on top of a white-label platform or API service (GHL, Shopify, Notion, Airtable, Stripe, Zapier, etc.) rather than built from scratch? Higher = more leverage.
- Competitor weakness (0-10): Are existing solutions consistently poorly reviewed, too expensive, or too complex?
- Trend momentum (0-5): Is this pain growing or newly emerging vs. a dying market?

Respond with JSON only, no markdown:
{"score": 0, "summary": "one sentence on the opportunity", "leverage_note": "what platform or service could handle the heavy lifting, or 'build from scratch required'"}

Score < 45 = not worth pursuing. Still return valid JSON.`;

const DEEP_DIVE_PROMPT = `You are evaluating a high-potential B2B SaaS opportunity for a solo founder with limited time.

Provide a detailed analysis covering:
1. Exact target customer and their workflow
2. What white-label platform or API service best fits (GHL, Shopify, Airtable, etc.) — or if none, what the build scope looks like
3. Estimated monthly operating cost (platform fees + infra)
4. Realistic weekly hours to operate once live
5. 3 potential pricing tiers
6. Biggest risk or unknown

Keep it under 200 words. Respond in plain text, no headers.`;

export async function scorePost(post: RawPost): Promise<ScoredOpportunity | null> {
  const content = `Title: ${post.title}\n\nBody: ${post.body.slice(0, 1200)}`;

  try {
    const raw = (await think(SCORING_SYSTEM_PROMPT, [], content, { model: 'haiku', noTools: true })).text;
    const cleaned = raw.replace(/^```(?:json)?\n/m, '').replace(/\n```$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.score < 45) return null;

    const result: ScoredOpportunity = {
      source: post.source,
      title: post.title,
      summary: parsed.summary,
      score: parsed.score,
      leverageNote: parsed.leverage_note ?? '',
      raw: post,
    };

    // Second-pass deep dive for high-confidence opportunities
    if (parsed.score >= 70) {
      try {
        const deepDiveContent = `${content}\n\nInitial score: ${parsed.score}/100\nSummary: ${parsed.summary}`;
        result.deepDive = (await think(DEEP_DIVE_PROMPT, [], deepDiveContent, { model: 'sonnet', noTools: true })).text;
      } catch {
        // deep dive is best-effort
      }
    }

    return result;
  } catch (err) {
    console.error(`scorePost failed for "${post.title.slice(0, 60)}": ${(err as Error).message}`);
    return null;
  }
}
