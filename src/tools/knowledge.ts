import { think } from '../brain.js';
import { saveKnowledge, searchKnowledge, KnowledgeEntry } from '../memory/supabase.js';
import { browseUrl } from './browser.js';

/**
 * Extract insights from content and save to knowledge base.
 * Called when Jake posts to #training channel.
 */
export async function processTrainingMaterial(
  domain: string,
  rawContent: string,
  sourceUrl?: string
): Promise<string> {
  // If URL provided, fetch the content
  let content = rawContent;
  let title = sourceUrl ?? 'Untitled';

  if (sourceUrl) {
    const browsed = await browseUrl(sourceUrl, 'Extract the main content, key points, and title');
    if (!browsed.error) {
      content = browsed.content ?? rawContent;
      title = browsed.title ?? sourceUrl;
    }
  }

  // Use haiku to extract key insights
  const extractPrompt = `Extract 3-7 key insights from this ${domain} content that would be useful for a solo founder building B2B SaaS products.

Content:
${content.slice(0, 8000)}

Return JSON only:
{
  "title": "short descriptive title",
  "key_insights": ["insight 1", "insight 2", "insight 3"]
}`;

  let title2 = title;
  let insights: string[] = [];

  try {
    const result = await think(
      'You are extracting actionable insights from business content.',
      [],
      extractPrompt,
      { model: 'haiku', noTools: true }
    );
    const parsed = JSON.parse(result.text);
    title2 = parsed.title ?? title;
    insights = parsed.key_insights ?? [];
  } catch {
    // If extraction fails, store the raw content with no insights
    insights = [];
  }

  await saveKnowledge({
    domain,
    source_url: sourceUrl,
    title: title2,
    content: content.slice(0, 10000),
    key_insights: insights,
  });

  const insightList = insights.length > 0
    ? `\n\nKey insights extracted:\n${insights.map(i => `• ${i}`).join('\n')}`
    : '';

  return `Saved to **${domain}** knowledge base: *${title2}*${insightList}`;
}

/**
 * Search the knowledge base for relevant material.
 * Used by the search_knowledge tool in brain.ts.
 */
export async function queryKnowledge(domain: string, context: string): Promise<string> {
  const entries = await searchKnowledge(domain === 'any' ? 'all' : domain, 8);

  if (entries.length === 0) {
    return `No knowledge base entries found for domain: ${domain}`;
  }

  // Ask Claude to select and summarize the most relevant insights
  const selectPrompt = `You are selecting the most relevant knowledge base entries for a specific task.

Task context: ${context}

Available knowledge (${entries.length} entries):
${entries.map((e, i) => `${i + 1}. [${e.domain}] ${e.title}\nInsights: ${e.key_insights.join('; ')}`).join('\n\n')}

Return the 3-5 most relevant insights as a concise summary (2-3 sentences max). Only include insights directly applicable to the task context.`;

  try {
    const result = await think(
      'You are a knowledge retrieval assistant.',
      [],
      selectPrompt,
      { model: 'haiku', noTools: true }
    );
    return result.text;
  } catch {
    // Fallback: return raw insights
    return entries.slice(0, 3).map((e: KnowledgeEntry) =>
      `**${e.title}** (${e.domain}): ${e.key_insights.slice(0, 2).join('; ')}`
    ).join('\n\n');
  }
}
