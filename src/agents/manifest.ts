import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agent } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _agents: Agent[] | null = null;

export function loadAgents(): Agent[] {
  if (_agents) return _agents;
  // agents.json is copied next to this file during build (see postbuild script)
  const jsonPath = path.join(__dirname, 'agents.json');
  const raw = fs.readFileSync(jsonPath, 'utf-8');
  _agents = JSON.parse(raw) as Agent[];
  console.log(`Loaded ${_agents.length} agents`);
  return _agents;
}
