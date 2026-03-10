import { loadAgents } from './manifest.js';
import { think } from '../brain.js';
import { planAgentChain } from './chain-planner.js';
import { runAgentChain, StepCompleteCallback } from './chain-runner.js';

export async function routeToAgent(
  userMessage: string,
  onStepComplete?: StepCompleteCallback
): Promise<string | null> {
  // Try chain first
  const chainPlan = await planAgentChain(userMessage);
  if (chainPlan && chainPlan.steps.length > 1) {
    const result = await runAgentChain(userMessage, chainPlan, onStepComplete);
    return result.finalOutput;
  }

  // Fallback: existing single-agent logic unchanged
  const agents = loadAgents();
  const agentList = agents.map(a => `- ${a.id}: ${a.description}`).join('\n');

  const routingSystemPrompt = `You are a task router. Given a user message, decide which specialist agent (if any) should handle it.

Available agents:
${agentList}

If the message is general conversation, strategy, or status — respond with: NONE
Otherwise respond with just the agent ID (e.g. "engineering-ai-engineer"). No explanation.`;

  const agentId = (await think(routingSystemPrompt, [], userMessage)).text.trim();

  if (agentId === 'NONE') return null;

  const agent = agents.find(a => a.id === agentId);
  if (!agent) return null;

  return (await think(agent.systemPrompt, [], userMessage)).text;
}
