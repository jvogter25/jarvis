import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: 'text/plain' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return (await res.text()).slice(0, 6000);
}

async function searchBrave(query: string): Promise<string> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return '(no Brave API key — skipping web search)';

  const params = new URLSearchParams({ q: query, count: '5' });
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return `(Brave search error: ${res.status})`;

  const data = await res.json() as {
    web?: { results?: Array<{ title: string; url: string; description?: string }> };
  };
  const results = data.web?.results ?? [];
  return results.map(r => `- **${r.title}**: ${r.description ?? ''}\n  ${r.url}`).join('\n');
}

export async function runCompetitorResearch(target: string): Promise<string> {
  console.log(`[competitor-research] Researching: ${target}`);

  // Try to fetch the competitor's homepage
  let siteContent = '';
  const homeUrl = target.startsWith('http') ? target : `https://${target}`;
  try {
    siteContent = await fetchPage(homeUrl);
  } catch {
    siteContent = '(could not fetch site content)';
  }

  // Search for pricing, reviews, and news
  const searchQuery = `${target} pricing review competitors features`;
  const searchResults = await searchBrave(searchQuery).catch(() => '(search unavailable)');

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a strategic analyst specializing in competitive intelligence.
You produce thorough, structured competitor teardowns that help businesses understand their competitive landscape.`,
      },
      {
        role: 'user',
        content: `Produce a comprehensive competitor research report on: **${target}**

HOMEPAGE CONTENT:
${siteContent}

WEB SEARCH RESULTS:
${searchResults}

Create a structured markdown teardown covering:

## 1. Company Overview
What they do, target market, founding story (if known), key metrics

## 2. Product/Service Analysis
Core features, UX quality, unique differentiators, limitations

## 3. Pricing & Business Model
Pricing tiers, freemium vs paid, monetization strategy

## 4. Positioning & Messaging
Value proposition, tone of voice, who they're targeting

## 5. Strengths
Top 3–5 things they do well

## 6. Weaknesses & Gaps
Top 3–5 vulnerabilities or underserved areas

## 7. How to Beat Them
Specific strategic recommendations to compete effectively

## 8. Key Takeaways
3-bullet executive summary

Be specific, analytical, and actionable.`,
      },
    ],
    temperature: 0.4,
    max_tokens: 2500,
  });

  const report = completion.choices[0]?.message?.content?.trim() ?? 'No report generated.';

  return `# Competitor Research Report\n**Subject:** ${target}\n**Date:** ${new Date().toISOString().split('T')[0]}\n**Analyst:** CashClaw AI Agent\n\n${report}`;
}
