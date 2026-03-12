import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function runContentWriting(topic: string): Promise<string> {
  console.log(`[content-writing] Writing blog post on: ${topic}`);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are an expert content writer specializing in long-form, SEO-optimized blog posts.
Write in a clear, engaging voice that educates readers while being optimized for search engines.
Always include: compelling headline, introduction with hook, well-structured body with H2/H3 subheadings,
actionable insights, and a strong conclusion with CTA.`,
      },
      {
        role: 'user',
        content: `Write a comprehensive, long-form blog post (approximately 1500–2500 words) on the following topic:

TOPIC: ${topic}

Requirements:
- SEO-optimized title and subheadings
- Engaging introduction that hooks the reader
- 4–6 main sections with H2 headers
- Subsections with H3 headers where appropriate
- Bullet points and numbered lists for scannability
- Specific, actionable advice
- Conclusion with clear CTA
- Output in clean markdown format`,
      },
    ],
    temperature: 0.7,
    max_tokens: 3000,
  });

  const post = completion.choices[0]?.message?.content?.trim() ?? 'No content generated.';

  return `${post}\n\n---\n*Content produced by CashClaw AI Agent on ${new Date().toISOString().split('T')[0]}*`;
}
