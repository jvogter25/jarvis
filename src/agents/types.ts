export interface Agent {
  id: string;          // e.g. "engineering-ai-engineer"
  name: string;        // from frontmatter "name" field
  description: string; // from frontmatter "description" field
  systemPrompt: string;// full file content
}

export interface AgentChainStep {
  agentId: string;
  role: string;
  handoffContext: string;
}

export interface AgentChainPlan {
  steps: AgentChainStep[];
  rationale: string;
}
