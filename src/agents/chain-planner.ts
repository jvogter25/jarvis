import { think } from '../brain.js';
import { loadAgents } from './manifest.js';
import { AgentChainPlan, AgentChainStep } from './types.js';

const MAX_CHAIN_LENGTH = 4;
const SINGLE_AGENT_TASKS = ['greeting', 'general conversation', 'status check', 'clarification', 'simple question'];

export async function planAgentChain(userMessage: string): Promise<AgentChainPlan | null> {
  const agents = loadAgents();
  const agentList = agents.map(a => `- ${a.id}: ${a.description ?? a.name}`).join('\n');

  const prompt = `You are a task decomposition planner for an AI assistant with specialist agents.

Available agents:
${agentList}

User message: "${userMessage}"

Decide if this task needs a CHAIN of agents working in sequence, or if a single agent (or no agent) is sufficient.

Rules:
- Only chain when the task genuinely requires multiple specialist phases (e.g. research → analysis → writing)
- Simple questions, greetings, status checks, and conversational messages should NOT chain
- Maximum ${MAX_CHAIN_LENGTH} steps
- Each step must use a valid agent ID from the list above

Return JSON only, no markdown:
{
  "needsChain": false,
  "steps": [],
  "rationale": "simple question, single agent sufficient"
}

OR if chaining is needed:
{
  "needsChain": true,
  "steps": [
    {"agentId": "research-trend-researcher", "role": "researcher", "handoffContext": "Find validated B2B SaaS pain signals in the trades vertical"},
    {"agentId": "product-sprint-prioritization", "role": "analyst", "handoffContext": "Score and prioritize the research findings"},
    {"agentId": "marketing-content", "role": "writer", "handoffContext": "Write a Discord summary of top 3 opportunities"}
  ],
  "rationale": "task requires research then analysis then writing"
}`;

  try {
    const result = await think(
      'You are a task decomposition planner. Return JSON only, no markdown.',
      [],
      prompt,
      { model: 'haiku', noTools: true }
    );

    const cleaned = result.text.replace(/^```(?:json)?\n/m, '').replace(/\n```$/m, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.needsChain || !parsed.steps || parsed.steps.length <= 1) return null;

    // Validate all agentIds exist
    const validIds = new Set(agents.map(a => a.id));
    const validSteps = parsed.steps.filter((s: AgentChainStep) => validIds.has(s.agentId));
    if (validSteps.length <= 1) return null;

    return {
      steps: validSteps.slice(0, MAX_CHAIN_LENGTH),
      rationale: parsed.rationale ?? '',
    };
  } catch {
    return null; // fallback to single agent on any error
  }
}
