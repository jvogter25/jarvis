import { Client, TextChannel } from 'discord.js';
import { searchWeb } from '../tools/search.js';
import { think } from '../brain.js';
import { CHANNELS } from '../discord/channels.js';

const DISCOVERY_QUERIES = [
  '"new MCP server" Claude 2026',
  '"Model Context Protocol" new integration release',
  'new AI agent tool npm package 2026',
  'Claude MCP tool announcement site:twitter.com',
  'new developer API launch 2026 SaaS integration',
];

interface DiscoveredTool {
  name: string;
  url: string;
  whyUseful: string;
  securityNotes: string;
  installComplexity: 'simple' | 'moderate' | 'complex';
  installCommand: string;
}

export async function runToolDiscovery(discord: Client) {
  console.log('Tool discovery: starting...');

  const channel = discord.channels.cache.get(CHANNELS.ENGINEERING) as TextChannel | undefined;
  if (!channel) {
    console.log('Tool discovery: #engineering channel not found, skipping');
    return;
  }

  // Search all queries in parallel
  const searchPromises = DISCOVERY_QUERIES.map(q => searchWeb(q, 5));
  const searchResults = await Promise.all(searchPromises);

  const allResults: Array<{ title: string; url: string; description: string }> = [];
  for (const result of searchResults) {
    if (!result.error) allResults.push(...result.results);
  }

  if (allResults.length === 0) {
    console.log('Tool discovery: no search results');
    return;
  }

  // Deduplicate by URL
  const unique = allResults.filter((r, i, arr) => arr.findIndex(x => x.url === r.url) === i);
  console.log(`Tool discovery: ${unique.length} unique results, sending to Opus for evaluation`);

  const evalPrompt = `You are evaluating newly discovered tools and MCPs that Jarvis (an AI orchestrator running on Railway) could integrate.

Jarvis's mission: find, build, and operate B2B SaaS products. Current capabilities: web search, browser automation, GitHub API, Vercel deploy, Slack notifications, E2B code sandbox, Discord bot.

Evaluate these ${Math.min(unique.length, 20)} search results and select the 3-5 most useful and safe tools for Jarvis to add:

${unique.slice(0, 20).map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.description}`).join('\n\n')}

For each tool you select, return:
- name: short tool name (e.g. "Resend", "Exa", "Loops")
- url: source URL
- whyUseful: 1-2 sentences on what Jarvis could specifically DO with this (be concrete)
- securityNotes: what API access it requires, what data it can read/send
- installComplexity: "simple" (1 new file + API key), "moderate" (2-3 files), or "complex" (core file changes)
- installCommand: exact phrase Jake would say in Discord to install it, e.g. "install resend" or "add exa search"

Only include tools that are:
1. Actually useful for Jarvis's B2B SaaS mission
2. Available as npm packages or well-documented REST APIs
3. Safe (no broad data access, clear API key scope)

Return JSON only, no markdown:
{"tools": [...]}
If nothing is worth recommending this week, return {"tools": []}`;

  try {
    const evalResult = await think(
      'You are a senior engineer evaluating AI tools for safe production integration.',
      [],
      evalPrompt,
      { model: 'opus', noTools: true }
    );

    const { tools } = JSON.parse(evalResult.text) as { tools: DiscoveredTool[] };

    if (tools.length === 0) {
      console.log('Tool discovery: nothing useful found this week');
      return;
    }

    const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const lines: string[] = [`**Weekly Tool Digest — ${date}**`, ''];

    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      lines.push(
        `**${i + 1}. ${t.name}**`,
        `Why: ${t.whyUseful}`,
        `Security: ${t.securityNotes}`,
        `Complexity: ${t.installComplexity}`,
        `→ Say \`${t.installCommand}\` in #jarvis to add it.`,
        ''
      );
    }

    await channel.send(lines.join('\n'));
    console.log(`Tool discovery: posted ${tools.length} tools to #engineering`);
  } catch (err) {
    console.error('Tool discovery failed:', err);
  }
}
