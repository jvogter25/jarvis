import { Client, TextChannel } from 'discord.js';
import { getRecentMessages, getSystemPrompt, saveSystemPrompt, getRecentKnowledge, getAllProjectConfigs, updateProjectConfig, getProjectConfig } from '../memory/supabase.js';
import { think } from '../brain.js';
import { CHANNELS } from '../discord/channels.js';
import { emitDashboardEvent } from '../dashboard/events.js';

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
  emitDashboardEvent({ type: 'training_step', room: 'office', agent: 'trainer', task: 'Overnight training starting...' });

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
- Post-launch management: monitor analytics, propose improvements, execute when Jake approves
- PROJECT WORKSPACES: each project has its own Discord folder with isolated channels and system prompt. Use create_project when Jake says "create project" or approves a research opportunity for building. Stay focused on one project per channel — never cross-pollinate.
- KNOWLEDGE BASE: call search_knowledge before writing copy, planning positioning, or making design/architecture decisions. Jake feeds training material into #training with domain tags.
- PREVIEW BEFORE DEPLOY: use preview_app instead of build_app for new products. E2B preview first, Vercel slot only after Jake approves. Never consume a Vercel slot without approval.
- DEBUGGING DISCIPLINE: When any issue is reported — always read the actual file or log first using read_github_file or browse_web. Never say "auth" or "rate limit" without seeing that exact error in tool output. State the specific file and line number before proposing any fix. Never confabulate what a PR changed — fetch it.
- STATE DISCIPLINE: Never say STAGED without a PR being open (tool-confirmed). Never say LIVE without a deploy succeeding. If you flip state, explicitly say "I was wrong — the correct state is X because [tool output]." Jake's pushback is not a reason to change stated facts — tool output is.
- SELF-AWARENESS: You have these credentials in Railway: ANTHROPIC_API_KEY, GITHUB_TOKEN (owner: jvogter25), DISCORD_TOKEN, SUPABASE_URL/ANON_KEY, VERCEL_TOKEN, E2B_API_KEY, BROWSERBASE_API_KEY, BRAVE_SEARCH_API_KEY. Never ask Jake for info that is discoverable by tool call. Channel IDs are in channels.ts — use read_github_file to check. PR status: fetch the PR. Env vars: they are set, confirm via code not Jake.`;

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
{"analysis": "what went wrong or was suboptimal", "fixes_implemented": "what changes you made to the prompt and why", "new_prompt": "the improved system prompt"}`;

  try {
    emitDashboardEvent({ type: 'training_step', room: 'office', agent: 'trainer', task: 'Analyzing conversations & rewriting system prompt...' });
    const raw = (await think('You are a prompt engineering assistant.', [], analysisPrompt, { model: 'sonnet', noTools: true })).text;
    const cleaned = raw.replace(/^```(?:json)?\n/m, '').replace(/\n```$/m, '').trim();
    const parsed = JSON.parse(cleaned);
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

    emitDashboardEvent({ type: 'training_complete', room: 'office', agent: 'trainer', task: 'Overnight training complete — new prompt saved' });
    const logChannel = discord.channels.cache.get(CHANNELS.OVERNIGHT_LOG) as TextChannel | undefined;
    if (logChannel) {
      await logChannel.send(`**Overnight Training Complete**\n\n**What went wrong:**\n${parsed.analysis}\n\n**Fixes implemented:**\n${parsed.fixes_implemented}\n\n**New prompt saved.**`);
    }
  } catch (err) {
    console.error('Overnight training failed:', err);
  }

  console.log('Overnight training: complete');
}
