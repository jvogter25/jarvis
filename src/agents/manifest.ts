import { Agent } from './types.js';
import agentsData from './agents.json' assert { type: 'json' };

let _agents: Agent[] | null = null;

export function loadAgents(): Agent[] {
  if (_agents) return _agents;
  _agents = agentsData as Agent[];
  console.log(`Loaded ${_agents.length} agents`);
  return _agents;
}
