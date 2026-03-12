import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchWithJina(url: string): Promise<string> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: 'text/plain' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Jina fetch failed: ${res.status}`);
  const text = await res.text();
  return text.slice(0, 8000);
}

export async function runSeoAudit(url: string): Promise<string> {
  console.log(`[seo-audit] Crawling ${url} via Jina.ai`);

  let pageContent = '';
  let crawlError = '';
  try {
    pageContent = await fetchWithJina(url);
  } catch (err) {
    crawlError = (err as Error).message;
  }

  const prompt = crawlError
    ? `You are an expert SEO consultant. The client requested an SEO audit for: ${url}\nCrawl failed: ${crawlError}\nProvide a general SEO audit report based on the URL structure and common best practices.`
    : `You are an expert SEO consultant. Perform a thorough technical SEO audit of this page.

URL: ${url}

PAGE CONTENT (via Jina.ai reader):
${pageContent}

Produce a structured markdown SEO audit report covering:
1. **Meta Tags Analysis** — title tag, meta description, OG tags presence/quality
2. **Heading Structure** — H1/H2/H3 usage, keyword presence
3. **Content Quality** — word count, readability, keyword density
4. **Technical Signals** — URL structure, internal linking signals from content
5. **Mobile & Performance** — notes from content structure
6. **Top 5 Keyword Opportunities** — based on content theme
7. **Priority Action Items** — ranked list of improvements

Be specific, actionable, and professional.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 2000,
  });

  const report = completion.choices[0]?.message?.content?.trim() ?? 'No report generated.';

  return `# SEO Audit Report\n**URL:** ${url}\n**Date:** ${new Date().toISOString().split('T')[0]}\n\n${report}`;
}
