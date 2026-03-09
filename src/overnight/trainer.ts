import { Client, TextChannel } from 'discord.js';
import { getRecentMessages, getSystemPrompt, saveSystemPrompt, getRecentKnowledge, getAllProjectConfigs, updateProjectConfig, getProjectConfig } from '../memory/supabase.js';
import { think } from '../brain.js';
import { CHANNELS } from '../discord/channels.js';

async function syncProjectPrompt(slug: string, globalPrompt: string): Promise<void> {
  const project = await getProjectConfig(slug);
  if (!project) return;

  // Preserve the project-specific context block appended at creation
  const contextMatch = project.system_prompt.match(/---\nPROJECT CONTEXT:[\s\S]+$/);
  const projectContext = contextMatch ? '\n\n' + contextMatch[0] : '';

  await updateProjectConfig(slug, {
    system_prompt: globalPrompt + projectContext,
    last_synced_at: new Date().toISOString(),
  });
  console.log(`[trainer] Synced project prompt: ${slug}`);
}

export async function runOvernightTraining(discord: Client) {
  console.log('Overnight training: starting...');

  const history = await getRecentMessages(CHANNELS.JARVIS, 100);
  const currentPrompt = await getSystemPrompt();

  if (history.length < 10) {
    console.log('Not enough conversation data yet, skipping training');
    return;
  }

  const conversation = history.map(m => `${m.role}: ${m.content}`).join('\n');

  const PROTECTED_CORE = `PROTECTED CORE MISSION (never remove or weaken these):
- Jarvis is an ORCHESTRATOR — never does work directly. Spawns subagents for every task. Thinks, plans, and coordinates. Subagents execute.
- Jarvis's mission is finding, building, and operating B2B SaaS opportunities — not any specific product
- LEVERAGE OVER BUILD: always check for white-label/platform solutions before recommending a full build
- Prioritize opportunities Jake can operate in under 2 hours/week
- Never mention or reference South Bay Digital as a current focus — that is a past project
- Never promote to production without explicit Jake approval — this is a hard gate
- Post-launch management: monitor analytics, propose improvements, execute when Jake approves`;

  const analysisPrompt = `You are a prompt engineer. Review this conversation between Jarvis (AI co-CEO) and Jake, then rewrite Jarvis's system prompt to be more effective.

${PROTECTED_CORE}

Current system prompt:
${currentPrompt}

Recent conversations:
${conversation.slice(0, 8000)}

Analyze: What was routed correctly? What produced bad outputs? What confused Jarvis?
Then rewrite the system prompt to address these issues. Keep it under 600 words.
You MUST preserve the protected core mission above — only improve tone, routing, and task-specific behaviors based on what you see in the conversations.

Respond with JSON only, no markdown:
{"analysis": "what you found", "new_prompt": "the improved system prompt"}`;

  try {
    const text = (await think('You are a prompt engineering assistant.', [], analysisPrompt, { model: 'sonnet', noTools: true })).text;
    const parsed = JSON.parse(text);
    await saveSystemPrompt(parsed.new_prompt);

    // ── Knowledge fold: incorporate recent training material into the prompt ──
    const recentKnowledge = await getRecentKnowledge(15);
    if (recentKnowledge.length > 0) {
      const knowledgeSummary = recentKnowledge
        .map(k => `[${k.domain}] ${k.title}: ${k.key_insights.slice(0, 2).join('; ')}`)
        .join('\n');

      const knowledgePrompt = `You are updating a system prompt to incorporate recent training material.

Current prompt:
${parsed.new_prompt}

Recent training material (${recentKnowledge.length} entries):
${knowledgeSummary}

Incorporate the key insights naturally into the relevant sections of the prompt. Keep it under 700 words. Return the updated prompt only, no markdown.`;

      try {
        const withKnowledge = (await think(
          'You are a prompt engineer incorporating domain knowledge.',
          [],
          knowledgePrompt,
          { model: 'sonnet', noTools: true }
        )).text;
        await saveSystemPrompt(withKnowledge);
        parsed.new_prompt = withKnowledge;
      } catch (err) {
        console.error('[trainer] Knowledge fold failed (non-fatal):', err);
      }
    }

    // ── Weekly project prompt sync ─────────────────────────────────────────────
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const projects = await getAllProjectConfigs();
    for (const project of projects) {
      if (project.last_synced_at < oneWeekAgo) {
        await syncProjectPrompt(project.slug, parsed.new_prompt);
      }
    }

    const logChannel = discord.channels.cache.get(CHANNELS.OVERNIGHT_LOG) as TextChannel | undefined;
    if (logChannel) {
      await logChannel.send(`**Overnight Training Complete**\n\n**Analysis:** ${parsed.analysis}\n\n**New prompt version saved.**`);
    }
  } catch (err) {
    console.error('Overnight training failed:', err);
  }

  console.log('Overnight training: complete');
}
