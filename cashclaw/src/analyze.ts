import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type SkillType =
  | 'seo_audit'
  | 'content_writing'
  | 'code_review'
  | 'competitor_research'
  | 'landing_page_copy';

export interface TaskAnalysis {
  accepted: boolean;
  skill: SkillType | null;
  priceEth: number;
  quoteMessage: string;
  declineReason?: string;
  /** Extracted target (URL for SEO, topic for content, etc.) */
  target: string;
}

const SKILL_DESCRIPTIONS: Record<SkillType, string> = {
  seo_audit: 'Technical SEO audit of a website — crawl a URL and produce a structured markdown report covering meta tags, headings, page speed signals, mobile readiness, and keyword suggestions.',
  content_writing: 'Long-form blog post or article (1500–3000 words) on a given topic, optimized for SEO and engagement.',
  code_review: 'Structured code review — analyze a code snippet or GitHub repo link and provide actionable feedback on quality, security, performance, and best practices.',
  competitor_research: 'Competitor teardown report — research a company or product and produce a structured analysis covering positioning, pricing, features, strengths, and weaknesses.',
  landing_page_copy: 'Conversion-focused landing page copy — headline, subheadline, benefits, social proof section, and CTA for a given product or service.',
};

const SYSTEM_PROMPT = `You are CashClaw, an autonomous AI agent that accepts paid freelance tasks on the Moltlaunch marketplace.

You offer exactly 5 services:
1. SEO Audit — crawl a URL, produce technical markdown report
2. Content Writing — long-form blog post on a topic
3. Code Review — analyze code and give structured feedback
4. Competitor Research — research and tear down a competitor
5. Landing Page Copy — conversion-focused copy for a product/service

Pricing range: 0.005–0.01 ETH per task. Price based on complexity:
- Simple/short tasks: 0.005 ETH
- Standard tasks: 0.007 ETH
- Complex/lengthy tasks: 0.01 ETH

Your response MUST be valid JSON only (no markdown, no explanation outside JSON).`;

const ANALYSIS_PROMPT = (requestText: string) => `Analyze this task request and determine if it matches one of your 5 services:

REQUEST:
${requestText}

Respond with JSON:
{
  "accepted": true/false,
  "skill": "seo_audit" | "content_writing" | "code_review" | "competitor_research" | "landing_page_copy" | null,
  "priceEth": 0.005-0.01 (number, only if accepted),
  "target": "the specific URL, topic, or subject extracted from the request",
  "quoteMessage": "friendly 2-3 sentence acceptance message explaining what you'll deliver and when",
  "declineReason": "short polite decline reason (only if accepted=false)"
}`;

export async function analyzeTask(requestText: string): Promise<TaskAnalysis> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: ANALYSIS_PROMPT(requestText) },
      ],
      temperature: 0.3,
      max_tokens: 400,
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? '{}';
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned) as TaskAnalysis;

    // Validate priceEth within bounds
    if (parsed.accepted && parsed.priceEth) {
      parsed.priceEth = Math.max(0.005, Math.min(0.01, parsed.priceEth));
    }

    return parsed;
  } catch (err) {
    console.error('[analyze] GPT-4o analysis failed:', (err as Error).message);
    return {
      accepted: false,
      skill: null,
      priceEth: 0,
      quoteMessage: '',
      declineReason: 'Internal analysis error — please try again.',
      target: '',
    };
  }
}
