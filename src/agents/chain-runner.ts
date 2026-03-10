import { think } from '../brain.js';
import { loadAgents } from './manifest.js';
import { AgentChainPlan, AgentChainStep } from './types.js';

export interface ChainRunResult {
  finalOutput: string;
  stepOutputs: Array<{ agentId: string; role: string; output: string }>;
}

export type StepCompleteCallback = (
  step: AgentChainStep,
  output: string,
  stepIndex: number,
  totalSteps: number
) => Promise<void>;

export async function runAgentChain(
  userMessage: string,
  plan: AgentChainPlan,
  onStepComplete?: StepCompleteCallback
): Promise<ChainRunResult> {
  const agents = loadAgents();
  const agentMap = new Map(agents.map(a => [a.id, a]));
  const stepOutputs: Array<{ agentId: string; role: string; output: string }> = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const agent = agentMap.get(step.agentId);
    if (!agent) continue;

    const previousWork = stepOutputs.length > 0
      ? stepOutputs.map(s => `## ${s.role}\n${s.output}`).join('\n\n')
      : '';

    const stepPrompt = [
      `Original request: ${userMessage}`,
      previousWork ? `\nWork completed so far:\n${previousWork}` : '',
      `\nYour role: ${step.role} — ${step.handoffContext}`,
      `\nComplete your part of the task.`,
    ].filter(Boolean).join('\n');

    const result = await think(
      agent.systemPrompt ?? agent.name,
      [],
      stepPrompt,
      { model: 'sonnet', noTools: true }
    );

    stepOutputs.push({ agentId: step.agentId, role: step.role, output: result.text });

    if (onStepComplete) {
      await onStepComplete(step, result.text, i, plan.steps.length);
    }
  }

  return {
    finalOutput: stepOutputs[stepOutputs.length - 1]?.output ?? '',
    stepOutputs,
  };
}
