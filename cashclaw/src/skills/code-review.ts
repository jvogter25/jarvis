import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchGithubContent(url: string): Promise<string> {
  // Convert github.com URLs to raw content or use Jina reader
  const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: 'text/plain' },
    signal: AbortSignal.timeout(30000),
  });
  if (!jinaRes.ok) throw new Error(`Failed to fetch: ${jinaRes.status}`);
  return (await jinaRes.text()).slice(0, 8000);
}

export async function runCodeReview(target: string): Promise<string> {
  console.log(`[code-review] Reviewing: ${target}`);

  let codeContext = target;
  let contextNote = '(provided directly in request)';

  // If target looks like a URL, fetch the content
  if (target.startsWith('http')) {
    try {
      codeContext = await fetchGithubContent(target);
      contextNote = `(fetched from ${target})`;
    } catch (err) {
      contextNote = `(fetch failed: ${(err as Error).message} — reviewing URL structure only)`;
    }
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a senior software engineer performing thorough code reviews.
Your reviews are constructive, specific, and prioritized. You identify security issues, performance bottlenecks,
code quality problems, and suggest concrete improvements with examples.`,
      },
      {
        role: 'user',
        content: `Perform a comprehensive code review of the following code ${contextNote}:

\`\`\`
${codeContext}
\`\`\`

Produce a structured markdown code review covering:

## 1. Summary
Brief overview of what the code does and overall quality assessment (1-10 rating)

## 2. Security Issues
List any security vulnerabilities with severity (Critical/High/Medium/Low) and remediation

## 3. Performance
Performance bottlenecks and optimization opportunities

## 4. Code Quality
- Readability and naming conventions
- Code duplication / DRY violations
- Error handling
- Type safety (if applicable)

## 5. Architecture & Design
Structure, separation of concerns, design pattern usage

## 6. Testing
Coverage gaps and testability issues

## 7. Prioritized Action Items
Top 5 improvements ranked by impact, with code examples for the most critical ones

Be specific, cite line numbers or code snippets when possible, and provide actionable recommendations.`,
      },
    ],
    temperature: 0.3,
    max_tokens: 2500,
  });

  const review = completion.choices[0]?.message?.content?.trim() ?? 'No review generated.';

  return `# Code Review Report\n**Subject:** ${target}\n**Date:** ${new Date().toISOString().split('T')[0]}\n**Reviewer:** CashClaw AI Agent\n\n${review}`;
}
